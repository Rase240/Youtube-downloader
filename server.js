const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { probeMediaInfo, processMediaObfuscation, SUPPORTED_EXTENSIONS } = require('./media-obfuscator');

// Optional: Load environment variables from .env file if it exists
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  try {
    const envConfig = fs.readFileSync(envFile, 'utf8');
    envConfig.split(/\r?\n/).forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = (match[2] || '').trim().replace(/^['"]|['"]$/g, '');
      }
    });
  } catch (e) { }
}

const app = express();
const PORT = process.env.PORT || 3000;
// Default to 'download123' if not set in environment. Set APP_PASSWORD="" to disable auth.
const APP_PASSWORD = process.env.APP_PASSWORD !== undefined ? process.env.APP_PASSWORD : 'download123';

// Session token management: map of token -> { createdAt }
// Tokens are random hex strings, NOT the password itself
const activeSessions = new Map();
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidSession(token) {
  if (!token) return false;
  const session = activeSessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

// Brute-force rate limiter: max 5 failed attempts per IP per 15 minutes
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return true;
  // Clean old attempts
  record.timestamps = record.timestamps.filter(t => now - t < ATTEMPT_WINDOW);
  if (record.timestamps.length >= MAX_ATTEMPTS) return false;
  return true;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  if (!loginAttempts.has(ip)) {
    loginAttempts.set(ip, { timestamps: [now] });
  } else {
    const record = loginAttempts.get(ip);
    record.timestamps = record.timestamps.filter(t => now - t < ATTEMPT_WINDOW);
    record.timestamps.push(now);
  }
}

function clearFailedAttempts(ip) {
  loginAttempts.delete(ip);
}

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of activeSessions) {
    if (now - session.createdAt > SESSION_MAX_AGE) {
      activeSessions.delete(token);
    }
  }
}, 60 * 60 * 1000);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    const allowed = [
      /^https?:\/\/localhost(:\d+)?$/,
      /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
      /^https?:\/\/10\.0\.2\.2(:\d+)?$/,
      /^https:\/\/raserar\.duckdns\.org$/,
      /^capacitor:\/\/localhost$/
    ];
    if (allowed.some(pattern => pattern.test(origin))) {
      return callback(null, true);
    }
    return callback(null, false);
  }
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src')));

// Find yt-dlp binary path
const isWin = process.platform === 'win32';
const ytdlpFilename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const ytdlpPath = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', ytdlpFilename);
const downloadsDir = path.join(__dirname, 'public_downloads');

// Resolve FFmpeg binary (static or system binary)
let resolvedFfmpeg = null;
if (ffmpeg && typeof ffmpeg === 'string' && fs.existsSync(ffmpeg)) {
  resolvedFfmpeg = ffmpeg;
} else if (fs.existsSync('/usr/bin/ffmpeg')) {
  resolvedFfmpeg = '/usr/bin/ffmpeg';
} else if (fs.existsSync('/usr/local/bin/ffmpeg')) {
  resolvedFfmpeg = '/usr/local/bin/ffmpeg';
}
const ffmpegBin = resolvedFfmpeg || 'ffmpeg';

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}
const uploadTempDir = path.join(downloadsDir, '.uploads_temp');
if (!fs.existsSync(uploadTempDir)) {
  fs.mkdirSync(uploadTempDir, { recursive: true });
}

// Automatic cleanup: Purge files older than 60 minutes every 15 minutes to preserve VPS disk
setInterval(() => {
  try {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 60 mins

    if (fs.existsSync(downloadsDir)) {
      const files = fs.readdirSync(downloadsDir);
      for (const file of files) {
        const filePath = path.join(downloadsDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && (now - stats.mtimeMs > maxAge)) {
            fs.unlinkSync(filePath);
            console.log(`[Cleaner] Auto-deleted old download: ${file}`);
          }
        } catch (e) { }
      }
    }

    if (fs.existsSync(uploadTempDir)) {
      const tempFiles = fs.readdirSync(uploadTempDir);
      for (const tf of tempFiles) {
        const tfPath = path.join(uploadTempDir, tf);
        try {
          const stats = fs.statSync(tfPath);
          if (stats.isFile() && (now - stats.mtimeMs > 15 * 60 * 1000)) { // 15 mins for orphaned uploads
            fs.unlinkSync(tfPath);
            console.log(`[Cleaner] Auto-deleted orphaned upload temp: ${tf}`);
          }
        } catch (e) { }
      }
    }
  } catch (e) {
    console.warn('[Cleaner] Error during auto-cleanup:', e.message);
  }
}, 15 * 60 * 1000);

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

// Download concurrency limiter
const MAX_CONCURRENT_DOWNLOADS = 3;
let activeDownloads = 0;

// Authentication Middleware
function checkAuth(req, res, next) {
  if (!APP_PASSWORD || APP_PASSWORD.trim().length === 0) {
    return next(); // Auth disabled
  }
  const token = req.headers['x-access-token'] || req.query.token;
  if (token && isValidSession(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
}

// FFmpeg Metadata Obfuscation & Spoofing (Injects fake metadata: title, creation date, software encoder, and random filename)
function obfuscateVideoMetadata(inputPath) {
  return new Promise((resolve) => {
    let cleanInput = (inputPath || '').replace(/^["']|["']$/g, '').trim();
    if (!fs.existsSync(cleanInput)) {
      return resolve(cleanInput);
    }

    const ext = path.extname(cleanInput) || '.mp4';
    const randomId = Math.floor(10000 + Math.random() * 90000);
    const randomStr = Math.random().toString(36).substring(2, 10);
    const outputPath = path.join(downloadsDir, `project_${randomId}${ext}`);

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
      '-metadata', `encoder=Adobe Premiere Pro CC 2024`,
      outputPath
    ];

    const child = spawn(ffmpegBin, args);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        try { fs.unlinkSync(cleanInput); } catch (e) { }
        resolve(outputPath);
      } else {
        resolve(cleanInput);
      }
    });
    child.on('error', () => resolve(cleanInput));
  });
}

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    serverTime: new Date().toISOString(),
    authRequired: Boolean(APP_PASSWORD && APP_PASSWORD.trim().length > 0)
  });
});

// Auth Status Endpoint
app.get('/api/auth/status', (req, res) => {
  res.json({ 
    authRequired: Boolean(APP_PASSWORD && APP_PASSWORD.trim().length > 0) 
  });
});

// Token Validation Endpoint (check if saved session token is still valid)
app.post('/api/auth/validate', (req, res) => {
  if (!APP_PASSWORD || APP_PASSWORD.trim().length === 0) {
    return res.json({ valid: true, authRequired: false });
  }
  const { token } = req.body || {};
  if (token && isValidSession(token)) {
    return res.json({ valid: true });
  }
  return res.status(401).json({ valid: false });
});

// Auth Verification Endpoint (rate-limited)
app.post('/api/auth/verify', (req, res) => {
  if (!APP_PASSWORD || APP_PASSWORD.trim().length === 0) {
    return res.json({ success: true, authRequired: false });
  }

  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

  // Check rate limit
  if (!checkRateLimit(clientIp)) {
    const retryAfter = Math.ceil(ATTEMPT_WINDOW / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ 
      success: false, 
      error: 'Too many failed attempts. Please try again in 15 minutes.' 
    });
  }

  const { password } = req.body || {};
  // Constant-time comparison to prevent timing attacks
  if (password && typeof password === 'string' &&
      password.length === APP_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(password), Buffer.from(APP_PASSWORD))) {
    clearFailedAttempts(clientIp);
    const sessionToken = generateSessionToken();
    activeSessions.set(sessionToken, { createdAt: Date.now() });
    return res.json({ success: true, token: sessionToken });
  }

  recordFailedAttempt(clientIp);
  return res.status(401).json({ success: false, error: 'Incorrect password. Access denied.' });
});

// Fetch Metadata Info API (Protected)
app.get('/api/info', checkAuth, (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  if (!isValidMediaUrl(videoUrl)) {
    return res.status(400).json({ error: 'Invalid URL. Only http:// and https:// URLs are allowed.' });
  }

  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const binToUse = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp';
  const hasCookies = fs.existsSync(cookiesPath);

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

  infoArgs.push(videoUrl);

  const child = spawn(binToUse, infoArgs);

  let stdout = '';
  let stderr = '';
  let settled = false;

  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { 
    stderr += d.toString(); 
    console.warn(`[yt-dlp info stderr] ${d.toString()}`);
  });

  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    res.status(500).json({ error: `Failed to start yt-dlp: ${err.message}` });
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    if (code === 0) {
      try {
        const info = JSON.parse(stdout);
        res.json(info);
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse metadata' });
      }
    } else {
      console.error(`[yt-dlp info error] Code ${code}:`, stderr);
      res.status(500).json({ error: stderr || 'Error analyzing URL' });
    }
  });
});

// Download & Sanitize API (Protected)
app.post('/api/download', checkAuth, (req, res) => {
  const { url, formatId, type, containerFormat, obfuscate = true } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  if (!isValidMediaUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL. Only http:// and https:// URLs are allowed.' });
  }

  // Enforce concurrent download limit
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({ error: 'Server is busy processing other downloads. Please try again shortly.' });
  }
  activeDownloads++;
  const releaseDownloadSlot = () => { activeDownloads = Math.max(0, activeDownloads - 1); };

  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const binToUse = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp';
  const hasCookies = fs.existsSync(cookiesPath);

  const args = [
    '--no-warnings',
    '--restrict-filenames',
    '--js-runtimes', 'deno,node'
  ];

  if (hasCookies) {
    args.push('--cookies', cookiesPath);
  } else {
    args.push('--extractor-args', 'youtube:player_client=ios,android,mweb');
  }

  // Only supply --ffmpeg-location if an explicit binary file path exists
  if (resolvedFfmpeg && fs.existsSync(resolvedFfmpeg)) {
    args.push('--ffmpeg-location', resolvedFfmpeg);
  }

  if (type === 'audio') {
    args.push(
      '-f', 'ba/b',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0'
    );
  } else {
    // Resilient format selection:
    // Handles both landscape & portrait (Shorts) videos, and falls back to
    // highest available stream (/ b) so it NEVER errors with "Requested format is not available".
    const heightMatch = (formatId || '').match(/height<=(\d+)/);
    const maxH = heightMatch ? heightMatch[1] : null;
    let finalFormatId;
    if (maxH) {
      finalFormatId = `bv*[height<=?${maxH}]+ba/b[height<=?${maxH}] / bv*[width<=?${maxH}]+ba/b[width<=?${maxH}] / bv*+ba / b`;
    } else {
      finalFormatId = 'bv*+ba / b';
    }

    args.push(
      '-f', finalFormatId,
      '--merge-output-format', containerFormat || 'mp4'
    );
  }

  const outputTemplate = path.join(downloadsDir, 'temp_download_%(id)s.%(ext)s');
  args.push('-o', outputTemplate, url);

  const child = spawn(binToUse, args);
  let filepath = '';
  let stderr = '';
  let responded = false;

  child.stdout.on('data', (data) => {
    const text = data.toString();
    console.log(`[yt-dlp stdout] ${text.trim()}`);
    const destMatch = text.match(/Destination:\s*(.+)$/m);
    const mergeMatch = text.match(/Merging formats into\s*["']?([^"'\r\n]+)["']?/);
    if (destMatch) filepath = destMatch[1].replace(/^["']|["']$/g, '').trim();
    if (mergeMatch) filepath = mergeMatch[1].replace(/^["']|["']$/g, '').trim();
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderr += text;
    console.warn(`[yt-dlp stderr] ${text.trim()}`);
  });

  child.on('error', (err) => {
    if (responded) return;
    responded = true;
    releaseDownloadSlot();
    res.status(500).json({ error: `Failed to start yt-dlp: ${err.message}` });
  });

  child.on('close', async (code) => {
    if (responded) { releaseDownloadSlot(); return; }

    if (code === 0) {
      let cleanPath = (filepath || '').replace(/^["']|["']$/g, '').trim();

      if (!cleanPath || !fs.existsSync(cleanPath)) {
        const files = fs.readdirSync(downloadsDir)
          .map(f => path.join(downloadsDir, f))
          .filter(f => fs.statSync(f).isFile() && !f.endsWith('.part'))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (files.length > 0) cleanPath = files[0];
      }

      if (obfuscate && cleanPath && fs.existsSync(cleanPath)) {
        cleanPath = await obfuscateVideoMetadata(cleanPath);
      }

      responded = true;
      releaseDownloadSlot();
      const filename = path.basename(cleanPath);
      res.json({
        success: true,
        filename,
        downloadUrl: `/api/file/${encodeURIComponent(filename)}`
      });
    } else {
      responded = true;
      releaseDownloadSlot();
      console.error(`[Download Error] yt-dlp failed (code ${code}):`, stderr);
      res.status(500).json({ error: stderr.trim() || 'Download failed' });
    }
  });
});

// File Stream Download Route (Protected)
app.get('/api/file/:filename', checkAuth, (req, res) => {
  // Prevent path traversal: only allow a bare filename with no separators,
  // and resolve+verify it stays inside downloadsDir.
  const requested = req.params.filename;
  if (!requested || requested.includes('/') || requested.includes('\\') || requested.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(downloadsDir, requested);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(downloadsDir) + path.sep)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  if (fs.existsSync(resolved)) {
    res.download(resolved);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Local Media Obfuscation Upload Endpoint (Protected, Streaming, Strict Size Limit)
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB limit for remote uploads
const MAX_CONCURRENT_UPLOADS = 3;
let activeUploads = 0;
const { pipeline, Transform } = require('stream');

app.post('/api/obfuscate-upload', checkAuth, (req, res) => {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({
      error: 'Server is currently busy processing other media uploads. Please try again in a few moments.'
    });
  }

  activeUploads++;
  let slotReleased = false;
  const releaseSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      activeUploads = Math.max(0, activeUploads - 1);
    }
  };

  res.on('finish', releaseSlot);
  res.on('close', releaseSlot);

  const rawFilename = req.headers['x-filename'] || req.query.filename || 'media.mp4';
  let decodedFilename = 'media.mp4';
  try {
    decodedFilename = decodeURIComponent(rawFilename);
  } catch (uriErr) {
    decodedFilename = 'media.mp4';
  }

  let sanitizedFilename = path.basename(decodedFilename).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!sanitizedFilename || sanitizedFilename === '.' || sanitizedFilename === '..') {
    sanitizedFilename = 'media.mp4';
  }

  const ext = path.extname(sanitizedFilename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return res.status(400).json({
      error: `Unsupported format "${ext}". Supported formats: ${Array.from(SUPPORTED_EXTENSIONS).join(', ')}`
    });
  }

  const declaredLength = parseInt(req.headers['content-length'], 10);
  if (declaredLength === 0) {
    return res.status(400).json({ error: 'Uploaded file is empty.' });
  }
  if (declaredLength && declaredLength > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'File exceeds maximum upload size of 500 MB.' });
  }

  const uploadId = crypto.randomBytes(8).toString('hex');
  const tempInputPath = path.join(uploadTempDir, `upload_${uploadId}${ext}`);
  const writeStream = fs.createWriteStream(tempInputPath);

  const cleanupTemp = () => {
    try {
      if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
    } catch (e) { }
  };

  // Abort / timeout handlers
  req.on('aborted', () => {
    writeStream.destroy();
    cleanupTemp();
    releaseSlot();
  });

  req.on('close', () => {
    if (!req.complete) {
      writeStream.destroy();
      cleanupTemp();
      releaseSlot();
    }
  });

  req.setTimeout(10 * 60 * 1000, () => {
    writeStream.destroy();
    cleanupTemp();
    releaseSlot();
    if (!res.headersSent) res.status(408).json({ error: 'Upload timed out.' });
  });

  // Byte size tracking & enforcement Transform stream
  let uploadedBytes = 0;
  const sizeLimiter = new Transform({
    transform(chunk, encoding, callback) {
      uploadedBytes += chunk.length;
      if (uploadedBytes > MAX_UPLOAD_BYTES) {
        callback(new Error('File exceeds maximum upload size of 500 MB.'));
      } else {
        callback(null, chunk);
      }
    }
  });

  pipeline(req, sizeLimiter, writeStream, async (err) => {
    if (err) {
      cleanupTemp();
      releaseSlot();
      if (!res.headersSent) {
        if (err.message && err.message.includes('maximum upload size')) {
          res.status(413).json({ error: err.message });
        } else {
          res.status(500).json({ error: `Upload stream error: ${err.message}` });
        }
      }
      return;
    }

    // Stream finished writing to disk safely! Execute obfuscation:
    try {
      const allowedSignatures = ['adobe-premiere', 'davinci-resolve', 'final-cut', 'quicktime', 'random'];
      const rawSig = req.headers['x-signature'] || req.query.signature;
      const signatureKey = allowedSignatures.includes(rawSig) ? rawSig : 'adobe-premiere';

      const allowedTimestamps = ['random-past', 'current', 'strip'];
      const rawTime = req.headers['x-timestamp-mode'] || req.query.timestampMode;
      const timestampMode = allowedTimestamps.includes(rawTime) ? rawTime : 'random-past';

      const rawNaming = req.headers['x-naming-strategy'] || req.query.namingStrategy;
      const rawCustom = req.headers['x-custom-name'] || req.query.customName;
      let decodedCustom = '';
      if (rawCustom) {
        try { decodedCustom = decodeURIComponent(rawCustom); } catch (e) { decodedCustom = rawCustom; }
      }

      // Generate clean filename based on naming strategy:
      const randHex = crypto.randomBytes(8).toString('hex');
      let serverFilename;
      if (rawNaming === 'suffix') {
        const baseWithoutExt = path.basename(sanitizedFilename, ext).slice(0, 40);
        serverFilename = `${baseWithoutExt}_obfuscated`;
      } else if (rawNaming === 'custom' && decodedCustom.trim()) {
        serverFilename = decodedCustom.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
      } else {
        // Default / 'random': PURE random hash, ZERO original filename trace
        serverFilename = `proj_${randHex}`;
      }

      const options = {
        signatureKey,
        timestampMode,
        namingStrategy: 'custom',
        customName: serverFilename
      };

      const result = await processMediaObfuscation(ffmpegBin, tempInputPath, downloadsDir, options);
      cleanupTemp();
      releaseSlot();

      res.json({
        success: true,
        filename: result.filename,
        sizeFormatted: result.sizeFormatted,
        downloadUrl: `/api/file/${encodeURIComponent(result.filename)}`
      });
    } catch (procErr) {
      cleanupTemp();
      releaseSlot();
      if (!res.headersSent) {
        res.status(500).json({ error: procErr.message || 'Obfuscation processing failed.' });
      }
    }
  });
});



app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 YT Downloader Pro Server running on http://localhost:${PORT}`);
  if (APP_PASSWORD && APP_PASSWORD.trim().length > 0) {
    console.log(`🔒 Password Protection: ENABLED`);
    console.log(`🔑 Current Access Password: "${APP_PASSWORD}"`);
  } else {
    console.log(`⚠️ Password Protection: DISABLED (Anyone can access)`);
  }
  console.log(`======================================================\n`);
});