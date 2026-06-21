const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { spawn, exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');

// Determine paths
const userDataPath = app.getPath('userData');
const binDir = path.join(userDataPath, 'bin');

const isWin = process.platform === 'win32';
const ytdlpFilename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const ytdlpPath = path.join(binDir, ytdlpFilename);
const ytdlpUrl = isWin 
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

// Resolve ffmpeg path (packaged vs dev)
let ffmpegPath = ffmpeg;
if (app.isPackaged) {
  ffmpegPath = ffmpeg.replace('app.asar', 'app.asar.unpacked');
}

let mainWindow = null;
let currentDownloadProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0B0F19',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (currentDownloadProcess) {
      currentDownloadProcess.kill();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Setup & Update check for yt-dlp
async function ensureYtdlp(win) {
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  if (fs.existsSync(ytdlpPath)) {
    win.webContents.send('setup-status', { stage: 'ready', message: 'Ready to download' });
    
    // Check for updates in background to keep yt-dlp fresh
    exec(`"${ytdlpPath}" --version`, (err) => {
      if (err) {
        // Core corrupted or invalid, force redownload
        fs.unlinkSync(ytdlpPath);
        downloadYtdlp(win);
      } else {
        // Run yt-dlp update check in background
        exec(`"${ytdlpPath}" -U`, (uErr, stdout) => {
          console.log('Update Check Output:', stdout || uErr);
        });
      }
    });
  } else {
    downloadYtdlp(win);
  }
}

async function downloadYtdlp(win) {
  win.webContents.send('setup-status', { stage: 'loading', message: 'Downloading yt-dlp engine...', percent: 0 });
  
  try {
    const response = await axios({
      method: 'get',
      url: ytdlpUrl,
      responseType: 'stream'
    });

    const totalLength = parseInt(response.headers['content-length'], 10) || 15000000;
    let downloadedLength = 0;
    const writer = fs.createWriteStream(ytdlpPath);

    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      const percent = Math.round((downloadedLength / totalLength) * 100);
      win.webContents.send('setup-status', { stage: 'loading', message: 'Downloading yt-dlp engine...', percent });
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        if (!isWin) {
          fs.chmodSync(ytdlpPath, '755');
        }
        win.webContents.send('setup-status', { stage: 'ready', message: 'Setup complete!' });
        resolve();
      });
      writer.on('error', (err) => {
        try { fs.unlinkSync(ytdlpPath); } catch(e) {}
        win.webContents.send('setup-status', { stage: 'error', message: 'Download failed. Retrying...' });
        reject(err);
      });
    });
  } catch (err) {
    win.webContents.send('setup-status', { stage: 'error', message: 'Could not connect to GitHub to download the download engine. Please check your internet connection.' });
    console.error('Error downloading yt-dlp:', err);
  }
}

// IPC Event Handlers
ipcMain.handle('app-loaded', async () => {
  if (mainWindow) {
    ensureYtdlp(mainWindow);
  }
});

ipcMain.handle('retry-setup', async () => {
  if (mainWindow) {
    await ensureYtdlp(mainWindow);
  }
});

ipcMain.handle('get-default-path', () => {
  return app.getPath('downloads');
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Destination Folder'
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('fetch-info', async (event, url) => {
  return new Promise((resolve, reject) => {
    // Run yt-dlp -j to dump metadata
    const child = spawn(ytdlpPath, ['-j', url]);
    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(stdoutData);
          resolve(info);
        } catch (e) {
          reject(new Error('Failed to parse video info.'));
        }
      } else {
        let errMsg = stderrData || 'Unknown error occurred.';
        if (errMsg.includes('ERROR:')) {
          errMsg = errMsg.substring(errMsg.indexOf('ERROR:'));
        }
        reject(new Error(errMsg.trim()));
      }
    });
  });
});

ipcMain.on('start-download', (event, { url, formatId, type, containerFormat, outputFolder }) => {
  const args = [];
  
  if (type === 'audio') {
    args.push(
      '-f', 'bestaudio',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--ffmpeg-location', ffmpegPath
    );
  } else {
    args.push(
      '-f', formatId,
      '--merge-output-format', containerFormat || 'mp4',
      '--ffmpeg-location', ffmpegPath
    );
  }

  // Define save path template
  const outputTemplate = path.join(outputFolder, '%(title)s.%(ext)s');
  args.push('-o', outputTemplate);
  args.push(url);

  // Spawn download process
  currentDownloadProcess = spawn(ytdlpPath, args);
  let filepath = '';

  currentDownloadProcess.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[yt-dlp stdout]:', text);

    // Extract filepaths
    const destMatch = text.match(/Destination:\s*(.+)$/m);
    const audioDestMatch = text.match(/\[ExtractAudio\] Destination:\s*(.+)$/m);
    const alreadyMatch = text.match(/\[download\]\s*(.+?)\s*has already been downloaded/);
    const mergeMatch = text.match(/Merging formats into\s*["']?([^"'\n]+)["']?/);

    if (destMatch) filepath = destMatch[1].trim();
    if (audioDestMatch) filepath = audioDestMatch[1].trim();
    if (alreadyMatch) filepath = alreadyMatch[1].trim();
    if (mergeMatch) filepath = mergeMatch[1].trim();

    // Extract progress data
    if (text.includes('[download]')) {
      const matchPercent = text.match(/(\d+(?:\.\d+)?)%/);
      const matchSpeed = text.match(/at\s+([^\s]+)/);
      const matchEta = text.match(/ETA\s+([^\s]+)/);
      const matchSize = text.match(/of\s+([^\s]+)/);

      if (matchPercent) {
        event.reply('download-progress', {
          percent: parseFloat(matchPercent[1]),
          speed: matchSpeed ? matchSpeed[1] : '',
          eta: matchEta ? matchEta[1] : '',
          size: matchSize ? matchSize[1] : '',
          status: 'Downloading file...'
        });
      }
    } else if (text.includes('[ExtractAudio]')) {
      event.reply('download-progress', { status: 'Converting audio to MP3...' });
    } else if (text.includes('[ffmpeg]')) {
      event.reply('download-progress', { status: 'Merging video & audio channels...' });
    }
  });

  currentDownloadProcess.stderr.on('data', (data) => {
    console.error('[yt-dlp stderr]:', data.toString());
  });

  currentDownloadProcess.on('close', (code) => {
    if (code === 0) {
      event.reply('download-complete', { filepath });
    } else {
      event.reply('download-error', 'Download was interrupted or encountered an error.');
    }
    currentDownloadProcess = null;
  });
});

ipcMain.on('cancel-download', () => {
  if (currentDownloadProcess) {
    currentDownloadProcess.kill();
    currentDownloadProcess = null;
  }
});

ipcMain.on('open-folder', (event, folderPath) => {
  if (fs.existsSync(folderPath)) {
    shell.openPath(folderPath);
  }
});

ipcMain.on('open-file', (event, filePath) => {
  if (fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
});
