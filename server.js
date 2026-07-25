const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src')));

// Find yt-dlp binary path
const isWin = process.platform === 'win32';
const ytdlpFilename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const ytdlpPath = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', ytdlpFilename);
const downloadsDir = path.join(__dirname, 'public_downloads');

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// FFmpeg metadata sanitization (privacy: strip embedded metadata such as
// device/location info before the file is served).
function sanitizeVideoMetadata(inputPath) {
  return new Promise((resolve) => {
    let cleanInput = (inputPath || '').replace(/^["']|["']$/g, '').trim();
    if (!fs.existsSync(cleanInput)) {
      return resolve(cleanInput);
    }

    const ext = path.extname(cleanInput) || '.mp4';
    const base = path.basename(cleanInput, ext);
    const outputPath = path.join(downloadsDir, `${base}_clean${ext}`);

    const args = [
      '-y',
      '-i', cleanInput,
      '-c', 'copy',
      '-map_metadata', '-1',
      outputPath
    ];

    const child = spawn(ffmpeg, args);
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
  res.json({ status: 'ok', serverTime: new Date().toISOString() });
});

// Fetch Metadata Info API
app.get('/api/info', (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  const binToUse = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp';
  const child = spawn(binToUse, ['-j', videoUrl]);

  let stdout = '';
  let stderr = '';
  let settled = false;

  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

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
      res.status(500).json({ error: stderr || 'Error analyzing URL' });
    }
  });
});

// Download & Sanitize API
app.post('/api/download', (req, res) => {
  const { url, formatId, type, containerFormat, obfuscate = true } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const binToUse = fs.existsSync(ytdlpPath) ? ytdlpPath : 'yt-dlp';
  const args = [];

  if (type === 'audio') {
    args.push(
      '-f', 'bestaudio/best',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--restrict-filenames',
      '--no-warnings',
      '--ffmpeg-location', ffmpeg
    );
  } else {
    let requestedFormat = formatId || 'bestvideo+bestaudio/best';
    let finalFormatId = `${requestedFormat}/${requestedFormat.replace('[ext=m4a]', '')}/bestvideo+bestaudio/best`;
    args.push(
      '-f', finalFormatId,
      '--merge-output-format', containerFormat || 'mp4',
      '--restrict-filenames',
      '--no-warnings',
      '--ffmpeg-location', ffmpeg
    );
  }

  const outputTemplate = path.join(downloadsDir, 'temp_download_%(id)s.%(ext)s');
  args.push('-o', outputTemplate, url);

  const child = spawn(binToUse, args);
  let filepath = '';
  let responded = false;

  child.stdout.on('data', (data) => {
    const text = data.toString();
    const destMatch = text.match(/Destination:\s*(.+)$/m);
    const mergeMatch = text.match(/Merging formats into\s*["']?([^"'\r\n]+)["']?/);
    if (destMatch) filepath = destMatch[1].replace(/^["']|["']$/g, '').trim();
    if (mergeMatch) filepath = mergeMatch[1].replace(/^["']|["']$/g, '').trim();
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
        cleanPath = await sanitizeVideoMetadata(cleanPath);
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
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

// File Stream Download Route
app.get('/api/file/:filename', (req, res) => {
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
  console.log(`Mobile Download Engine Server running on http://localhost:${PORT}`);
});