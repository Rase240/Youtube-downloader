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

function safeSend(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#111113',
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
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
      currentDownloadProcess = null;
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
        try {
          fs.unlinkSync(ytdlpPath);
        } catch (e) {
          console.error('Failed to remove corrupted yt-dlp binary:', e);
        }
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

    const totalLength = parseInt(response.headers['content-length'], 10) || 0;
    let downloadedLength = 0;
    const writer = fs.createWriteStream(ytdlpPath);

    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      const percent = totalLength
        ? Math.min(99, Math.round((downloadedLength / totalLength) * 100))
        : undefined;
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
        try { fs.unlinkSync(ytdlpPath); } catch (e) { }
        win.webContents.send('setup-status', { stage: 'error', message: 'Download failed. Retrying...' });
        reject(err);
      });
      response.data.on('error', (err) => {
        try { fs.unlinkSync(ytdlpPath); } catch (e) { }
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
    if (!fs.existsSync(ytdlpPath)) {
      reject(new Error('yt-dlp is not installed yet. Please wait for setup to finish.'));
      return;
    }

    // Run yt-dlp -j to dump metadata
    const child = spawn(ytdlpPath, ['-j', url]);
    let stdoutData = '';
    let stderrData = '';
    let settled = false;

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
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

// FFmpeg Metadata Obfuscation & Spoofing (Injects fake metadata: title, creation date, software encoder, and random filename)
function obfuscateVideoMetadata(inputPath) {
  return new Promise((resolve) => {
    let cleanInput = (inputPath || '').replace(/^["']|["']$/g, '').trim();
    if (!fs.existsSync(cleanInput)) {
      console.error('obfuscateVideoMetadata target file not found:', cleanInput);
      return resolve(cleanInput);
    }

    const ext = path.extname(cleanInput) || '.mp4';
    const dir = path.dirname(cleanInput);
    const randomId = Math.floor(10000 + Math.random() * 90000);
    const randomStr = Math.random().toString(36).substring(2, 10);
    const outputPath = path.join(dir, `project_${randomId}${ext}`);

    const randomMinutes = Math.floor(15 + Math.random() * 4300);
    const pastDate = new Date(Date.now() - randomMinutes * 60 * 1000).toISOString();

    const args = [
      '-y',
      '-i', cleanInput,
      '-c', 'copy',
      '-map_metadata', '-1',
      '-metadata', `title=Export_${randomId}`,
      '-metadata', `comment=Rendered_with_${randomStr}`,
      '-metadata', `creation_time=${pastDate}`,
      '-metadata', `encoder=Adobe Premiere Pro CC 2024`
    ];

    if (ext === '.mp3') {
      args.push('-id3v2_version', '3');
    }

    args.push(outputPath);

    console.log('[FFmpeg Obfuscate] Command:', ffmpegPath, args.join(' '));
    const child = spawn(ffmpegPath, args);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        try { fs.unlinkSync(cleanInput); } catch (e) { }
        console.log('[FFmpeg Obfuscate] Successfully created obfuscated video:', outputPath);
        resolve(outputPath);
      } else {
        console.error('[FFmpeg Obfuscate] Failed with exit code:', code);
        resolve(cleanInput);
      }
    });
    child.on('error', (err) => {
      console.error('[FFmpeg Obfuscate] Process error:', err);
      resolve(cleanInput);
    });
  });
}

ipcMain.on('start-download', (event, { url, formatId, type, containerFormat, outputFolder, obfuscate }) => {
  if (!fs.existsSync(ytdlpPath)) {
    event.reply('download-error', 'yt-dlp is not installed yet. Please wait for setup to finish.');
    return;
  }

  if (currentDownloadProcess) {
    event.reply('download-error', 'A download is already in progress.');
    return;
  }

  const args = [];

  if (type === 'audio') {
    args.push(
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--restrict-filenames',
      '--no-warnings',
      '--ffmpeg-location', ffmpegPath
    );
  } else {
    let requestedFormat = formatId || 'bestvideo+bestaudio/best';
    // Robust format fallback string to prevent "Requested format not available" errors
    let finalFormatId = `${requestedFormat}/${requestedFormat.replace('[ext=m4a]', '')}/bestvideo+bestaudio/best`;

    args.push(
      '-f', finalFormatId,
      '--merge-output-format', containerFormat || 'mp4',
      '--restrict-filenames',
      '--no-warnings',
      '--ffmpeg-location', ffmpegPath
    );
  }

  // Define save path template
  const outputTemplate = path.join(outputFolder, '%(title)s.%(ext)s');
  args.push('-o', outputTemplate);
  args.push(url);

  // Spawn download process
  const child = spawn(ytdlpPath, args);
  currentDownloadProcess = child;
  let filepath = '';

  child.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[yt-dlp stdout]:', text);

    // Extract filepaths
    const destMatch = text.match(/Destination:\s*(.+)$/m);
    const audioDestMatch = text.match(/\[ExtractAudio\] Destination:\s*(.+)$/m);
    const alreadyMatch = text.match(/\[download\]\s*(.+?)\s*has already been downloaded/);
    const mergeMatch = text.match(/Merging formats into\s*["']?([^"'\r\n]+)["']?/);

    if (destMatch) filepath = destMatch[1].replace(/^["']|["']$/g, '').trim();
    if (audioDestMatch) filepath = audioDestMatch[1].replace(/^["']|["']$/g, '').trim();
    if (alreadyMatch) filepath = alreadyMatch[1].replace(/^["']|["']$/g, '').trim();
    if (mergeMatch) filepath = mergeMatch[1].replace(/^["']|["']$/g, '').trim();

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

  child.stderr.on('data', (data) => {
    console.error('[yt-dlp stderr]:', data.toString());
  });

  child.on('error', (err) => {
    if (currentDownloadProcess !== child) return;
    currentDownloadProcess = null;
    event.reply('download-error', `Failed to start yt-dlp: ${err.message}`);
  });

  child.on('close', async (code) => {
    // Guard against a stale process (e.g. a previous download) clobbering
    // the reference for a newer one.
    if (currentDownloadProcess === child) {
      currentDownloadProcess = null;
    }

    if (code === 0) {
      let cleanPath = (filepath || '').replace(/^["']|["']$/g, '').trim();

      // Fallback: If cleanPath doesn't exist or is empty, find newest file in outputFolder
      if (!cleanPath || !fs.existsSync(cleanPath)) {
        try {
          const files = fs.readdirSync(outputFolder)
            .map(f => path.join(outputFolder, f))
            .filter(f => fs.statSync(f).isFile() && !f.endsWith('.part') && !f.endsWith('.ytdl'))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

          if (files.length > 0) {
            cleanPath = files[0];
          }
        } catch (e) {
          console.error('Error finding newest downloaded file:', e);
        }
      }

      console.log('Target cleanPath for obfuscation:', cleanPath, 'obfuscate flag:', obfuscate);

      if (obfuscate && cleanPath && fs.existsSync(cleanPath)) {
        event.reply('download-progress', { status: 'Randomizing metadata & project filename...' });
        const obfuscatedPath = await obfuscateVideoMetadata(cleanPath);
        event.reply('download-complete', { filepath: obfuscatedPath });
      } else {
        event.reply('download-complete', { filepath: cleanPath });
      }
    } else {
      event.reply('download-error', 'Download was interrupted or encountered an error.');
    }
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

ipcMain.handle('save-metadata-file', async (event, { content, filename, defaultPath }) => {
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Metadata File',
    defaultPath: path.join(defaultPath || app.getPath('downloads'), filename || 'instagram_metadata.json'),
    filters: [
      { name: 'JSON Metadata', extensions: ['json'] },
      { name: 'Text File', extensions: ['txt'] }
    ]
  });

  if (!saveResult.canceled && saveResult.filePath) {
    fs.writeFileSync(saveResult.filePath, content, 'utf-8');
    return saveResult.filePath;
  }
  return null;
});