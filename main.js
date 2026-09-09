const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { spawn, exec } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const {
  probeMediaInfo,
  processMediaObfuscation,
  ensureAppleMediaCompatibility,
  SUPPORTED_EXTENSIONS
} = require('./media-obfuscator');

// Determine paths
const userDataPath = app.getPath('userData');
const binDir = path.join(userDataPath, 'bin');

const isWin = process.platform === 'win32';
const ytdlpFilename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const ytdlpPath = path.join(binDir, ytdlpFilename);
const ytdlpUrl = isWin
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

// Resolve ffmpeg path (packaged vs dev, static or system binary)
let ffmpegPath = ffmpeg;
if (app.isPackaged && typeof ffmpeg === 'string') {
  ffmpegPath = ffmpeg.replace('app.asar', 'app.asar.unpacked');
}
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  if (fs.existsSync('/usr/bin/ffmpeg')) ffmpegPath = '/usr/bin/ffmpeg';
  else if (fs.existsSync('/usr/local/bin/ffmpeg')) ffmpegPath = '/usr/local/bin/ffmpeg';
  else ffmpegPath = 'ffmpeg';
}

function getCookiesPath() {
  const projectCookies = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(projectCookies)) return projectCookies;
  const userCookies = path.join(userDataPath, 'cookies.txt');
  if (fs.existsSync(userCookies)) return userCookies;
  return null;
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

// URL Validation: Prevent yt-dlp flag injection & restrict to HTTP(S) URLs
function isValidMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.startsWith('-')) return false; // Block flag injection (e.g. --exec)
  try {
    const parsed = new URL(trimmed);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch (e) {
    return false;
  }
}

ipcMain.handle('fetch-info', async (event, url) => {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(ytdlpPath)) {
      reject(new Error('yt-dlp is not installed yet. Please wait for setup to finish.'));
      return;
    }

    if (!isValidMediaUrl(url)) {
      reject(new Error('Invalid URL. Only http:// and https:// URLs are allowed.'));
      return;
    }

    const cookiesPath = getCookiesPath();
    const hasCookies = Boolean(cookiesPath && fs.existsSync(cookiesPath));

    const infoArgs = [
      '-j',
      '--no-warnings',
      '--js-runtimes', 'deno,node'
    ];

    if (hasCookies) {
      infoArgs.push('--cookies', cookiesPath);
    } else {
      infoArgs.push('--extractor-args', 'youtube:player_client=ios,android,mweb');
    }

    infoArgs.push(url);

    const child = spawn(ytdlpPath, infoArgs);
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
          const lines = stdoutData.trim().split(/\r?\n/).filter(Boolean);
          const lastLine = lines[lines.length - 1];
          const info = JSON.parse(lastLine || stdoutData);
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

ipcMain.on('start-download', (event, { url, formatId, type, containerFormat, outputFolder, obfuscate }) => {
  if (!fs.existsSync(ytdlpPath)) {
    event.reply('download-error', 'yt-dlp is not installed yet. Please wait for setup to finish.');
    return;
  }

  if (!isValidMediaUrl(url)) {
    event.reply('download-error', 'Invalid URL. Only http:// and https:// URLs are allowed.');
    return;
  }

  if (currentDownloadProcess) {
    event.reply('download-error', 'A download is already in progress.');
    return;
  }

  const cookiesPath = getCookiesPath();
  const hasCookies = Boolean(cookiesPath && fs.existsSync(cookiesPath));

  const args = [
    '--no-warnings',
    '--restrict-filenames',
    '--js-runtimes', 'deno,node',
    '--ffmpeg-location', ffmpegPath
  ];

  if (hasCookies) {
    args.push('--cookies', cookiesPath);
  } else {
    args.push('--extractor-args', 'youtube:player_client=ios,android,mweb');
  }

  if (type === 'audio') {
    args.push(
      '-f', 'ba/b',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0'
    );
  } else {
    const SAFE_CONTAINERS = new Set(['mp4', 'mkv', 'webm']);
    const safeContainer = SAFE_CONTAINERS.has(containerFormat) ? containerFormat : 'mp4';

    const heightMatch = (formatId || '').match(/height<=(\d+)/);
    const maxH = heightMatch ? heightMatch[1] : null;

    let finalFormatId;
    if (maxH) {
      finalFormatId = `bv*[height<=?${maxH}]+ba/b[height<=?${maxH}] / bv*[width<=?${maxH}]+ba/b[width<=?${maxH}] / bv*+ba / b`;
    } else {
      finalFormatId = 'bv*+ba / b';
    }

    args.push('-f', finalFormatId);

    if (safeContainer === 'mp4') {
      // Prioritize H.264 video and AAC audio for 100% native iOS / QuickTime compatibility across YouTube, Instagram, and TikTok
      if (maxH) {
        args.push('-S', `res:${maxH},vcodec:h264,lang,quality,fps,hdr:12,acodec:m4a`);
      } else {
        args.push('-S', 'vcodec:h264,lang,quality,res,fps,hdr:12,acodec:m4a');
      }
      args.push('--merge-output-format', 'mp4');
      args.push('--postprocessor-args', 'ffmpeg:-movflags +faststart');
    } else {
      args.push('--merge-output-format', safeContainer);
    }
  }

  // Define save path template
  const outputTemplate = path.join(outputFolder, '%(title)s.%(ext)s');
  args.push('-o', outputTemplate);
  args.push(url);

  // Spawn download process
  const child = spawn(ytdlpPath, args);
  currentDownloadProcess = child;
  let filepath = '';
  let stderrData = '';

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
    } else if (text.includes('[ffmpeg]') || text.includes('[Merger]')) {
      event.reply('download-progress', { status: 'Merging video & audio channels...' });
    }
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderrData += text;
    console.error('[yt-dlp stderr]:', text);
  });

  child.on('error', (err) => {
    if (currentDownloadProcess !== child) return;
    currentDownloadProcess = null;
    event.reply('download-error', `Failed to start yt-dlp: ${err.message}`);
  });

  child.on('close', async (code) => {
    if (currentDownloadProcess === child) {
      currentDownloadProcess = null;
    }

    if (code === 0) {
      let cleanPath = (filepath || '').replace(/^["']|["']$/g, '').trim();

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

      console.log('Target cleanPath for compatibility and obfuscation:', cleanPath, 'obfuscate flag:', obfuscate);

      let finalPath = cleanPath;
      if (cleanPath && fs.existsSync(cleanPath)) {
        if (type !== 'audio' && (containerFormat === 'mp4' || !containerFormat)) {
          event.reply('download-progress', { status: 'Optimizing for iOS / Apple compatibility...' });
          finalPath = await ensureAppleMediaCompatibility(ffmpegPath, cleanPath);
        }

        if (obfuscate && finalPath && fs.existsSync(finalPath)) {
          event.reply('download-progress', { status: 'Randomizing metadata & project filename...' });
          try {
            const obfResult = await processMediaObfuscation(
              ffmpegPath,
              finalPath,
              outputFolder,
              { signatureKey: 'adobe-premiere', timestampMode: 'random-past' }
            );
            if (obfResult && obfResult.outputPath) {
              if (obfResult.outputPath !== finalPath) {
                try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath); } catch (e) {}
              }
              finalPath = obfResult.outputPath;
            }
          } catch (obfErr) {
            console.warn('[Obfuscation Warning] Failed to obfuscate, using normalized file:', obfErr.message);
          }
        }
      }

      event.reply('download-complete', { filepath: finalPath });
    } else {
      let errorSummary = (stderrData || '').trim();
      if (errorSummary.includes('ERROR:')) {
        errorSummary = errorSummary.substring(errorSummary.indexOf('ERROR:'));
      }
      const lines = errorSummary.split('\n').filter(Boolean);
      const userError = lines.slice(-2).join(' ') || 'Download was interrupted or encountered an error.';
      event.reply('download-error', userError);
    }
  });
});

ipcMain.on('cancel-download', () => {
  if (currentDownloadProcess) {
    if (process.platform === 'win32' && currentDownloadProcess.pid) {
      try {
        exec(`taskkill /pid ${currentDownloadProcess.pid} /T /F`);
      } catch (e) {
        currentDownloadProcess.kill();
      }
    } else {
      currentDownloadProcess.kill();
    }
    currentDownloadProcess = null;
  }
});

ipcMain.on('open-folder', (event, folderPath) => {
  if (fs.existsSync(folderPath)) {
    try {
      const stat = fs.statSync(folderPath);
      if (stat.isDirectory()) {
        shell.openPath(folderPath);
      } else {
        shell.showItemInFolder(folderPath);
      }
    } catch (e) {
      shell.openPath(folderPath);
    }
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

// Local Media Obfuscator IPC Handlers
ipcMain.handle('select-media-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Media File to Obfuscate',
    properties: ['openFile'],
    filters: [
      { name: 'Supported Media', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mp3'] },
      { name: 'Video Files', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi'] },
      { name: 'Audio Files', extensions: ['mp3'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
    const selected = result.filePaths[0];
    const info = await probeMediaInfo(ffmpegPath, selected);
    return { filePath: selected, ...info };
  }
  return null;
});

ipcMain.handle('probe-media-file', async (event, filePath) => {
  if (!filePath || typeof filePath !== 'string') return null;
  const clean = path.resolve(filePath.replace(/^["']|["']$/g, '').trim());
  if (!fs.existsSync(clean) || !fs.statSync(clean).isFile()) return null;
  const info = await probeMediaInfo(ffmpegPath, clean);
  return { filePath: clean, ...info };
});

ipcMain.handle('obfuscate-local-file', async (event, { filePath, targetDir, options }) => {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('No input file provided.');
  }
  const cleanPath = path.resolve(filePath.replace(/^["']|["']$/g, '').trim());
  if (!fs.existsSync(cleanPath) || !fs.statSync(cleanPath).isFile()) {
    throw new Error('Input file does not exist or is not a regular file.');
  }

  const destFolder = targetDir && typeof targetDir === 'string'
    ? path.resolve(targetDir)
    : path.dirname(cleanPath);

  const result = await processMediaObfuscation(
    ffmpegPath,
    cleanPath,
    destFolder,
    options || {},
    (progress) => {
      safeSend('obfuscate-progress', progress);
    }
  );

  return result;
});
