const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

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

app.use(cors());
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

// Automatic cleanup: Purge files older than 60 minutes every 15 minutes to preserve VPS disk
setInterval(() => {
  try {
    if (!fs.existsSync(downloadsDir)) return;
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 60 mins
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
  } catch (e) {
    console.warn('[Cleaner] Error during auto-cleanup:', e.message);
  }
}, 15 * 60 * 1000);

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
  if (password && password === APP_PASSWORD) {
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

  const binToUse = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp';
  const infoArgs = [
    '-j',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=android,web',
    videoUrl
  ];

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

  const binToUse = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp';
  const args = [
    '--no-warnings',
    '--restrict-filenames',
    '--extractor-args', 'youtube:player_client=android,web'
  ];

  // Only supply --ffmpeg-location if an explicit binary file path exists
  if (resolvedFfmpeg && fs.existsSync(resolvedFfmpeg)) {
    args.push('--ffmpeg-location', resolvedFfmpeg);
  }

  if (type === 'audio') {
    args.push(
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0'
    );
  } else {
    let requestedFormat = formatId || 'bestvideo+bestaudio/best';
    let finalFormatId = `${requestedFormat}/${requestedFormat.replace('[ext=m4a]', '')}/bestvideo+bestaudio/best`;
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
    res.status(500).json({ error: `Failed to start yt-dlp: ${err.message}` });
  });

  child.on('close', async (code) => {
    if (responded) return;

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
      const filename = path.basename(cleanPath);
      res.json({
        success: true,
        filename,
        downloadUrl: `/api/file/${encodeURIComponent(filename)}`
      });
    } else {
      responded = true;
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