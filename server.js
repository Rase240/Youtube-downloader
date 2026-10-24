const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const dns = require('dns').promises;
const net = require('net');
const ffmpeg = require('ffmpeg-static');
const {
  probeMediaInfo,
  processMediaObfuscation,
  ensureAppleMediaCompatibility,
  moveFileSafely,
  resolveUniqueDestination,
  SUPPORTED_EXTENSIONS
} = require('./media-obfuscator');

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
// Number of reverse-proxy hops to trust for client IP. Use 0 if Node is exposed directly (otherwise X-Forwarded-For is spoofable).
app.set('trust proxy', parseInt(process.env.TRUST_PROXY ?? '1', 10));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // use 127.0.0.1 when Nginx proxies to this process
// Auth fails closed: the server refuses to start without a password unless ALLOW_NO_AUTH=1 is set explicitly.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
if (!APP_PASSWORD.trim() && process.env.ALLOW_NO_AUTH !== '1') {
  console.error('FATAL: APP_PASSWORD is not set. Set it in .env (or set ALLOW_NO_AUTH=1 to run without auth).');
  process.exit(1);
}
if (APP_PASSWORD === 'download123') {
  console.error('FATAL: APP_PASSWORD is the publicly known default. Choose a different password.');
  process.exit(1);
}

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

// Cleanup expired sessions and stale rate limit records every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of activeSessions) {
    if (now - session.createdAt > SESSION_MAX_AGE) {
      activeSessions.delete(token);
    }
  }
  for (const [ip, record] of loginAttempts) {
    record.timestamps = record.timestamps.filter(t => now - t < ATTEMPT_WINDOW);
    if (record.timestamps.length === 0) {
      loginAttempts.delete(ip);
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

// HTTP Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

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
const jobsDir = path.join(downloadsDir, '.jobs');
fs.mkdirSync(jobsDir, { recursive: true });
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

    for (const d of fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : []) {
      const dPath = path.join(jobsDir, d);
      try {
        if (now - fs.statSync(dPath).mtimeMs > 2 * 60 * 60 * 1000) fs.rmSync(dPath, { recursive: true, force: true });
      } catch (e) { }
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

// URL Validation: Prevent yt-dlp flag injection & restrict to public HTTP(S) hosts
function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(addr)) {
    const l = addr.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true;
}

// Blocks loopback / link-local (AWS metadata 169.254.169.254) / private-network targets (SSRF).
async function isValidMediaUrl(url) {
  if (!url || typeof url !== 'string' || url.length > 2048) return false;
  const trimmed = url.trim();
  if (trimmed.startsWith('-')) return false; // Block flag injection (e.g. --exec)
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (e) {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  try {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    return addrs.length > 0 && !addrs.some(a => isPrivateAddress(a.address));
  } catch (e) {
    return false;
  }
}

// Kill a spawned process and its children (yt-dlp spawns ffmpeg).
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL'); // child is spawned detached => own process group
    }
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (e2) { }
  }
}
const runningChildren = new Set();
function shutdown() {
  for (const c of runningChildren) killTree(c);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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
      crypto.timingSafeEqual(
        crypto.createHash('sha256').update(password).digest(),
        crypto.createHash('sha256').update(APP_PASSWORD).digest()
      )) {
    clearFailedAttempts(clientIp);
    const sessionToken = generateSessionToken();
    activeSessions.set(sessionToken, { createdAt: Date.now() });
    return res.json({ success: true, token: sessionToken });
  }

  recordFailedAttempt(clientIp);
  return res.status(401).json({ success: false, error: 'Incorrect password. Access denied.' });
});

// Fetch Metadata Info API (Protected)
app.get('/api/info', checkAuth, async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }
  if (typeof videoUrl !== 'string' || !(await isValidMediaUrl(videoUrl))) {
    return res.status(400).json({ error: 'Invalid URL. Only public http:// and https:// URLs are allowed.' });
  }

  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const binToUse = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp';
  const hasCookies = fs.existsSync(cookiesPath);

  const infoArgs = [
    '-j',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '20',
    '--extractor-retries', '2',
    '--js-runtimes', 'deno,node'
  ];

  if (hasCookies) {
    infoArgs.push('--cookies', cookiesPath);
  }

  infoArgs.push(videoUrl);

  const child = spawn(binToUse, infoArgs, { detached: !isWin });
  runningChildren.add(child);
  child.on('close', () => runningChildren.delete(child));

  let stdout = '';
  let stderr = '';
  let settled = false;

  const infoTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      killTree(child);
      res.status(504).json({ error: 'Video analysis timed out. Please check the URL and try again.' });
    }
  }, 25000);

  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { 
    stderr += d.toString(); 
    console.warn(`[yt-dlp info stderr] ${d.toString()}`);
  });

  child.on('error', (err) => {
    clearTimeout(infoTimer);
    if (settled) return;
    settled = true;
    res.status(500).json({ error: `Failed to start yt-dlp: ${err.message}` });
  });

  child.on('close', (code) => {
    clearTimeout(infoTimer);
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

// Download & Sanitize API (Protected, Streaming Progress Enabled)
app.post('/api/download', checkAuth, async (req, res) => {
  const { url, formatId, type, containerFormat, obfuscate = true, stream = false } = req.body || {};
  const isStreamRequested = stream === true || req.headers.accept?.includes('text/event-stream');

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  if (!(await isValidMediaUrl(url))) {
    return res.status(400).json({ error: 'Invalid URL. Only public http:// and https:// URLs are allowed.' });
  }

  // Enforce concurrent download limit
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({ error: 'Server is busy processing other downloads. Please try again shortly.' });
  }
  activeDownloads++;
  let slotReleased = false;
  const releaseDownloadSlot = () => {
    if (!slotReleased) {
      slotReleased = true;
      activeDownloads = Math.max(0, activeDownloads - 1);
    }
  };

  if (isStreamRequested) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
  }

  const sendEvent = (data) => {
    if (isStreamRequested && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (typeof res.flush === 'function') res.flush();
    }
  };

  sendEvent({
    stage: 'starting',
    status: 'Connecting to media servers & analyzing streams...',
    percent: 5
  });

  let heartbeat = null;
  if (isStreamRequested) {
    heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n');
        if (typeof res.flush === 'function') res.flush();
      }
    }, 10000);
  }
  const cleanupHeartbeat = () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  };

  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const binToUse = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp';
  const hasCookies = fs.existsSync(cookiesPath);

  const args = [
    '--no-warnings',
    '--restrict-filenames',
    '--throttled-rate', '100K',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
    '--extractor-retries', '3',
    '--js-runtimes', 'deno,node',
    '--buffer-size', '64K',
    '--http-chunk-size', '10M'
  ];

  if (hasCookies) {
    args.push('--cookies', cookiesPath);
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
      finalFormatId = `bv[height<=?${maxH}]+ba / bv*[height<=?${maxH}]+ba / bv[width<=?${maxH}]+ba / bv*[width<=?${maxH}]+ba / bv*+ba / b`;
    } else {
      finalFormatId = 'bv+ba / bv*+ba / b';
    }

    const SAFE_CONTAINERS = new Set(['mp4', 'mkv', 'webm']);
    const safeContainer = SAFE_CONTAINERS.has(containerFormat) ? containerFormat : 'mp4';

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

  // Each job gets its own directory so concurrent downloads of the same video can't collide
  // and the output file is identified exactly (never "newest file in the folder").
  const jobDir = path.join(jobsDir, crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(jobDir, { recursive: true });
  const pathFile = path.join(jobDir, '.final_path.txt');
  const removeJobDir = () => { try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) { } };

  args.push(
    '--no-playlist',
    '--newline',
    '--max-filesize', process.env.MAX_DOWNLOAD_SIZE || '2G',
    '--print-to-file', 'after_move:filepath', pathFile
  );
  args.push('-o', path.join(jobDir, '%(id)s.%(ext)s'), '--', url.trim());

  const child = spawn(binToUse, args, { detached: !isWin });
  runningChildren.add(child);
  let stderr = '';
  let responded = false;

  const abortJob = () => {
    killTree(child);
    removeJobDir();
  };

  // Maximum 12-minute watchdog to prevent stuck processes from locking download slots
  const downloadTimer = setTimeout(() => {
    if (!responded) {
      responded = true;
      cleanupHeartbeat();
      releaseDownloadSlot();
      abortJob();
      const errMsg = 'Download timed out after 12 minutes.';
      if (isStreamRequested) {
        sendEvent({ stage: 'error', error: errMsg });
        res.end();
      } else {
        res.status(504).json({ error: errMsg });
      }
    }
  }, 12 * 60 * 1000);

  // Clean up if client disconnects before completion
  res.on('close', () => {
    if (!responded) {
      responded = true;
      cleanupHeartbeat();
      clearTimeout(downloadTimer);
      releaseDownloadSlot();
      abortJob();
    }
  });

  let stdoutBuf = '';
  child.stdout.on('data', (data) => {
    stdoutBuf += data.toString();
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
    for (const text of lines) {
      if (text.startsWith('[download]')) {
        const matchPercent = text.match(/(\d+(?:\.\d+)?)%/);
        const matchSpeed = text.match(/at\s+([^\s]+)/);
        const matchEta = text.match(/ETA\s+([^\s]+)/);
        const matchSize = text.match(/of\s+~?\s*([^\s]+)/);

        if (matchPercent) {
          const rawP = parseFloat(matchPercent[1]);
          const scaled = Math.min(85, Math.round(10 + rawP * 0.75));
          sendEvent({
            stage: 'downloading',
            status: `Downloading media (${matchPercent[1]}%)...`,
            percent: scaled,
            speed: matchSpeed ? matchSpeed[1] : '',
            eta: matchEta ? matchEta[1] : '',
            size: matchSize ? matchSize[1] : ''
          });
        }
      } else if (text.includes('[ExtractAudio]')) {
        sendEvent({ stage: 'converting', status: 'Converting audio to MP3...', percent: 86 });
      } else if (text.includes('[ffmpeg]') || text.includes('[Merger]')) {
        sendEvent({ stage: 'merging', status: 'Merging video & audio streams...', percent: 88 });
      }
    }
  });

  child.stderr.on('data', (data) => {
    // Keep only the tail: error bodies can be large, and only the last lines matter.
    stderr = (stderr + data.toString()).slice(-4000);
  });

  child.on('error', (err) => {
    runningChildren.delete(child);
    clearTimeout(downloadTimer);
    cleanupHeartbeat();
    removeJobDir();
    if (responded) return;
    responded = true;
    releaseDownloadSlot();
    console.error('[Download Error] spawn failed:', err.message);
    const msg = 'Failed to start yt-dlp. Is it installed on the server?';
    if (isStreamRequested) {
      sendEvent({ stage: 'error', error: msg });
      res.end();
    } else {
      res.status(500).json({ error: msg });
    }
  });

  // Last meaningful stderr line, without server paths, for the client.
  const clientError = () => {
    const lines = stderr.trim().split('\n');
    const line = lines.filter(l => /ERROR/.test(l)).pop() || lines.pop() || 'Download failed';
    return line.replace(/\/[^\s'"]*/g, '<path>').replace(/[A-Za-z]:\\[^\s'"]*/g, '<path>').slice(0, 300);
  };

  const fail = (message) => {
    responded = true;
    releaseDownloadSlot();
    removeJobDir();
    if (isStreamRequested) {
      sendEvent({ stage: 'error', error: message });
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  };

  child.on('close', async (code) => {
    runningChildren.delete(child);
    clearTimeout(downloadTimer);
    cleanupHeartbeat();
    if (responded) { releaseDownloadSlot(); return; }

    if (code !== 0) {
      console.error(`[Download Error] yt-dlp failed (code ${code}):`, stderr);
      return fail(clientError());
    }

    try {
      // Exit code 0 is not proof of success: confirm the exact file yt-dlp reported exists and is non-empty.
      let producedPath = '';
      try {
        producedPath = fs.readFileSync(pathFile, 'utf8').split(/\r?\n/).filter(Boolean).pop() || '';
      } catch (e) { }
      const resolvedProduced = producedPath ? path.resolve(producedPath) : '';
      if (!resolvedProduced || !resolvedProduced.startsWith(path.resolve(jobDir) + path.sep) ||
          !fs.existsSync(resolvedProduced) || fs.statSync(resolvedProduced).size === 0) {
        console.error('[Download Error] yt-dlp exited 0 but produced no usable file. stderr:', stderr);
        return fail('Download finished but no output file was produced.');
      }

      let finalPath = resolvedProduced;
      if (type !== 'audio' && (containerFormat === 'mp4' || !containerFormat)) {
        sendEvent({ stage: 'optimizing', status: 'Optimizing for iOS / Apple compatibility...', percent: 92 });
        finalPath = await ensureAppleMediaCompatibility(ffmpegBin, finalPath);
      }

      let publishedPath = null;
      if (obfuscate && fs.existsSync(finalPath)) {
        sendEvent({ stage: 'obfuscating', status: 'Scrubbing metadata and signatures...', percent: 96 });
        try {
          const obfResult = await processMediaObfuscation(
            ffmpegBin,
            finalPath,
            downloadsDir,
            { signatureKey: 'adobe-premiere', timestampMode: 'random-past' }
          );
          if (obfResult && obfResult.outputPath) publishedPath = obfResult.outputPath;
        } catch (obfErr) {
          console.warn('[Server Obfuscate Warning]:', obfErr.message);
        }
      }
      if (!publishedPath) {
        publishedPath = resolveUniqueDestination(downloadsDir, path.basename(finalPath), finalPath);
        moveFileSafely(finalPath, publishedPath);
      }
      removeJobDir();

      responded = true;
      releaseDownloadSlot();
      const filename = path.basename(publishedPath);
      const downloadUrl = `/api/file/${encodeURIComponent(filename)}`;

      if (isStreamRequested) {
        sendEvent({ stage: 'complete', status: 'Ready to save', percent: 100, success: true, filename, downloadUrl });
        res.end();
      } else {
        res.json({ success: true, filename, downloadUrl });
      }
    } catch (postErr) {
      console.error('[Download Error] post-processing failed:', postErr);
      fail('Post-processing failed.');
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

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile() && !requested.startsWith('.')) {
    res.setHeader('Accept-Ranges', 'bytes');
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



app.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 YT Downloader Pro Server running on http://${HOST}:${PORT}`);
  if (APP_PASSWORD && APP_PASSWORD.trim().length > 0) {
    console.log(`🔒 Password Protection: ENABLED`);
  } else {
    console.log(`⚠️ Password Protection: DISABLED (Anyone can access)`);
  }
  console.log(`======================================================\n`);
});