/**
 * media-obfuscator.js
 * Shared Media Obfuscation & Metadata Spoofing Engine
 * Used by both Electron (main.js) and Express (server.js).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Formats supported for metadata container manipulation
const SUPPORTED_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mp3'
]);

// Software / Producer signatures
const SIGNATURE_PRESETS = {
  'adobe-premiere': 'Adobe Premiere Pro CC 2024 (Build 24.1.0)',
  'davinci-resolve': 'DaVinci Resolve Studio 19.0.1',
  'final-cut': 'Apple Final Cut Pro 10.8',
  'quicktime': 'QuickTime Player 10.5',
  'random': null // Generated dynamically
};

const RANDOM_SIGNATURES = [
  'Adobe Premiere Pro CC 2024 (Build 24.1.0)',
  'DaVinci Resolve Studio 19.0.1',
  'Apple Final Cut Pro 10.8',
  'Avid Media Composer 2024.6',
  'Sony Catalyst Browse 2024.1'
];

/**
 * Generate a randomized ISO-8601 past date (between 1 hour and 90 days ago)
 */
function generateRandomPastDate() {
  const randomMinutes = Math.floor(60 + Math.random() * (90 * 24 * 60));
  const pastMs = Date.now() - randomMinutes * 60 * 1000;
  const d = new Date(pastMs);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Generate a safe unique output filename
 */
function generateOutputFilename(originalPath, namingStrategy, customName) {
  const ext = path.extname(originalPath).toLowerCase() || '.mp4';
  const base = path.basename(originalPath, ext);

  if (namingStrategy === 'custom' && customName && customName.trim()) {
    const sanitized = customName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${sanitized}${ext}`;
  }

  if (namingStrategy === 'suffix') {
    const sanitizedBase = base.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${sanitizedBase}_obfuscated${ext}`;
  }

  // Default: randomized project hash with zero source filename leakage
  const randomHex = crypto.randomBytes(6).toString('hex');
  return `project_${randomHex}${ext}`;
}

/**
 * Resolve destination path without colliding with existing files or overwriting the original.
 */
function resolveUniqueDestination(targetDir, desiredFilename, originalInputPath) {
  const ext = path.extname(desiredFilename);
  const base = path.basename(desiredFilename, ext);
  let candidate = path.join(targetDir, desiredFilename);
  let counter = 1;

  const normalizedOriginal = path.resolve(originalInputPath);
  while (fs.existsSync(candidate) || path.resolve(candidate) === normalizedOriginal) {
    candidate = path.join(targetDir, `${base}_${counter}${ext}`);
    counter++;
  }

  return candidate;
}

/**
 * Build container-tailored FFmpeg arguments for lossless stream copying
 */
function buildFfmpegArgs(inputPath, stagingOutputPath, options = {}) {
  const ext = path.extname(inputPath).toLowerCase();
  const {
    signatureKey = 'adobe-premiere',
    timestampMode = 'random-past', // 'random-past' | 'current' | 'strip'
    customTitle = ''
  } = options;

  let producerSignature = SIGNATURE_PRESETS[signatureKey];
  if (!producerSignature) {
    producerSignature = RANDOM_SIGNATURES[Math.floor(Math.random() * RANDOM_SIGNATURES.length)];
  }

  let creationTime = null;
  if (timestampMode === 'random-past') {
    creationTime = generateRandomPastDate();
  } else if (timestampMode === 'current') {
    creationTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  const randomHash = crypto.randomBytes(4).toString('hex');
  const displayTitle = customTitle && customTitle.trim()
    ? customTitle.trim()
    : `Export_${randomHash}`;

  const args = [
    '-y',
    '-i', inputPath,
    // Map all streams (video, audio, subtitles, data) to prevent dropping tracks
    '-map', '0',
    // Perform lossless stream copy
    '-c', 'copy',
    // Strip container-level and stream-level metadata
    '-map_metadata', '-1',
    '-map_metadata:s', '-1',
    // Bitexact suppresses automated Lavf / Lavc muxer stamps
    '-fflags', '+bitexact',
    '-flags:v', '+bitexact',
    '-flags:a', '+bitexact'
  ];

  // Container-specific tailoring
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') {
    // Faststart moves moov atom to beginning for streamability without non-standard mdta atoms
    args.push('-movflags', '+faststart');
    args.push('-metadata', `title=${displayTitle}`);
    args.push('-metadata', `comment=Rendered_with_${randomHash}`);
    // Standard QuickTime / MP4 Software atom (©swr) and Encoding Tool (©too)
    args.push('-metadata', `encoding_tool=${producerSignature}`);
    args.push('-metadata', `software=${producerSignature}`);
    if (creationTime) {
      args.push('-metadata', `creation_time=${creationTime}`);
    }
  } else if (ext === '.mkv') {
    args.push('-metadata', `title=${displayTitle}`);
    args.push('-metadata', `encoder=${producerSignature}`);
    args.push('-metadata', `software=${producerSignature}`);
    args.push('-metadata', `encoded_by=${producerSignature}`);
    args.push('-metadata', `comment=Rendered_with_${randomHash}`);
    if (creationTime) {
      args.push('-metadata', `creation_time=${creationTime}`);
    }
  } else if (ext === '.webm') {
    args.push('-metadata', `title=${displayTitle}`);
    args.push('-metadata', `software=${producerSignature}`);
    args.push('-metadata', `encoded_by=${producerSignature}`);
    if (creationTime) {
      args.push('-metadata', `creation_time=${creationTime}`);
    }
  } else if (ext === '.mp3') {
    args.push('-id3v2_version', '3');
    args.push('-metadata', `title=${displayTitle}`);
    args.push('-metadata', `encoded_by=${producerSignature}`);
    args.push('-metadata', `artist=${producerSignature}`);
    args.push('-metadata', `software=${producerSignature}`);
    args.push('-metadata', `comment=Rendered_with_${randomHash}`);
    if (creationTime) {
      const year = creationTime.substring(0, 4);
      args.push('-metadata', `date=${year}`);
    }
  } else if (ext === '.avi') {
    args.push('-metadata', `title=${displayTitle}`);
    args.push('-metadata', `software=${producerSignature}`);
    args.push('-metadata', `encoded_by=${producerSignature}`);
    args.push('-metadata', `comment=Rendered_with_${randomHash}`);
    if (creationTime) {
      args.push('-metadata', `date=${creationTime.substring(0, 10)}`);
    }
  }

  args.push(stagingOutputPath);

  return args;
}

/**
 * Safely move a file atomically, with cross-device / filesystem fallback
 */
function moveFileSafely(src, dest) {
  try {
    if (fs.existsSync(dest) && path.resolve(src) !== path.resolve(dest)) {
      try { fs.unlinkSync(dest); } catch (e) { }
    }
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV' || err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EEXIST') {
      fs.copyFileSync(src, dest);
      try { fs.unlinkSync(src); } catch (e) { }
    } else {
      throw err;
    }
  }
}

/**
 * Validate that the output file exists and has a non-zero size
 */
function validateOutputFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 1024;
  } catch (e) {
    return false;
  }
}

/**
 * Inspect file metadata cheaply using FFmpeg (-i on input without output)
 */
function probeMediaInfo(ffmpegBin, filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) {
      return resolve({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const result = {
      filename: path.basename(filePath),
      sizeBytes: stat.size,
      sizeFormatted: formatFileSize(stat.size),
      ext,
      isVideo: ext !== '.mp3',
      isAudio: true,
      durationText: '',
      resolutionText: '',
      codecText: '',
      videoCodec: '',
      audioCodec: ''
    };

    const child = spawn(ffmpegBin, ['-hide_banner', '-i', filePath]);
    let stderr = '';

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', () => {
      const durMatch = stderr.match(/Duration:\s*(\d{2}:\d{2}:\d{2})/);
      if (durMatch) {
        result.durationText = durMatch[1];
      }

      const resMatch = stderr.match(/Video:.*?,\s*(\d{3,5}x\d{3,5})/);
      if (resMatch) {
        result.resolutionText = resMatch[1];
      }

      const videoCodecMatch = stderr.match(/Video:\s*([a-zA-Z0-9_-]+)/i);
      const audioCodecMatch = stderr.match(/Audio:\s*([a-zA-Z0-9_-]+)/i);
      result.videoCodec = videoCodecMatch ? videoCodecMatch[1].toLowerCase() : '';
      result.audioCodec = audioCodecMatch ? audioCodecMatch[1].toLowerCase() : '';

      const parts = [];
      if (videoCodecMatch) parts.push(videoCodecMatch[1].toUpperCase());
      if (audioCodecMatch) parts.push(audioCodecMatch[1].toUpperCase());
      result.codecText = parts.join(' / ');

      resolve(result);
    });

    child.on('error', () => {
      resolve(result);
    });
  });
}

/**
 * Ensures media files (MP4/MOV/M4V) are fully compliant with Apple iOS
 * (iPhone, iPad, Safari, QuickTime, and Photos app) across YouTube, Instagram, and TikTok.
 *
 * Checks video and audio codecs:
 * - Audio: Must be AAC (or MP3/ALAC). If Opus, Vorbis, etc., transcode audio to AAC.
 * - Video: Must be H.264 (AVC) or H.265 (HEVC) with yuv420p. If VP9, AV1, etc., transcode to H.264.
 * - Container: Always applies -movflags +faststart to place the moov atom at the start of the file.
 */
function ensureAppleMediaCompatibility(ffmpegBin, inputPath) {
  return new Promise(async (resolve) => {
    let cleanInput = (inputPath || '').replace(/^["']|["']$/g, '').trim();
    if (!fs.existsSync(cleanInput)) {
      return resolve(cleanInput);
    }

    const ext = path.extname(cleanInput).toLowerCase();
    // Only MP4, M4V, MOV containers require Apple AVFoundation container normalization
    if (ext !== '.mp4' && ext !== '.m4v' && ext !== '.mov') {
      return resolve(cleanInput);
    }

    try {
      const info = await probeMediaInfo(ffmpegBin, cleanInput);
      const videoCodec = (info.videoCodec || '').toLowerCase();
      const audioCodec = (info.audioCodec || '').toLowerCase();

      const isAppleAudioCompatible = ['aac', 'mp4a', 'mp3', 'alac'].includes(audioCodec);
      const isAppleVideoCompatible = ['h264', 'avc1', 'hevc', 'hvc1', 'hev1'].includes(videoCodec);

      // Determine ffmpeg arguments
      const args = [
        '-y',
        '-i', cleanInput,
        '-map', '0'
      ];

      let needsVideoTranscode = !isAppleVideoCompatible && videoCodec.length > 0;
      let needsAudioTranscode = !isAppleAudioCompatible && audioCodec.length > 0;

      if (needsVideoTranscode) {
        // Transcode VP9/AV1 to high quality H.264 with yuv420p standard chroma
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p');
      } else {
        args.push('-c:v', 'copy');
      }

      if (needsAudioTranscode) {
        // Transcode Opus/Vorbis to high quality AAC 192k
        args.push('-c:a', 'aac', '-b:a', '192k');
      } else {
        args.push('-c:a', 'copy');
      }

      // Preserve subtitles and other metadata streams
      args.push('-c:s', 'copy', '-c:d', 'copy');
      // Critical for iOS streaming: place moov atom at the front
      args.push('-movflags', '+faststart');

      const stagingDir = path.dirname(cleanInput);
      const randomHex = crypto.randomBytes(4).toString('hex');
      const stagingPath = path.join(stagingDir, `.compat_staging_${randomHex}${ext}`);
      args.push(stagingPath);

      const child = spawn(ffmpegBin, args);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        if (code === 0 && validateOutputFile(stagingPath)) {
          try {
            moveFileSafely(stagingPath, cleanInput);
            resolve(cleanInput);
          } catch (mvErr) {
            try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (e) { }
            resolve(cleanInput);
          }
        } else {
          try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (e) { }
          console.warn('[Apple Compatibility] Transcoding fallback, keeping original:', stderr.slice(-300));
          resolve(cleanInput);
        }
      });

      child.on('error', (err) => {
        console.warn('[Apple Compatibility] Process error:', err.message);
        try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (e) { }
        resolve(cleanInput);
      });
    } catch (err) {
      console.warn('[Apple Compatibility] Probe error:', err.message);
      resolve(cleanInput);
    }
  });
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Execute media obfuscation safely
 */
function processMediaObfuscation(ffmpegBin, inputPath, targetDir, options = {}, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const cleanInput = (inputPath || '').replace(/^["']|["']$/g, '').trim();

    if (!fs.existsSync(cleanInput) || !fs.statSync(cleanInput).isFile()) {
      return reject(new Error('Input file does not exist or is not a regular file.'));
    }

    const ext = path.extname(cleanInput).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return reject(new Error(`Unsupported format "${ext}". Supported formats: ${Array.from(SUPPORTED_EXTENSIONS).join(', ')}`));
    }

    const destDir = targetDir ? path.resolve(targetDir) : path.dirname(cleanInput);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Verify write permissions on destination directory
    try {
      fs.accessSync(destDir, fs.constants.W_OK);
    } catch (permErr) {
      return reject(new Error(`Destination directory is not writable: ${permErr.message}`));
    }

    const desiredName = generateOutputFilename(cleanInput, options.namingStrategy, options.customName);
    const finalOutputPath = resolveUniqueDestination(destDir, desiredName, cleanInput);

    let stagingName = `.staging_${crypto.randomBytes(6).toString('hex')}${ext}`;
    let stagingPath = path.join(destDir, stagingName);
    while (fs.existsSync(stagingPath)) {
      stagingName = `.staging_${crypto.randomBytes(6).toString('hex')}${ext}`;
      stagingPath = path.join(destDir, stagingName);
    }

    onProgress({ stage: 'preparing', message: 'Analyzing container structure...' });

    const args = buildFfmpegArgs(cleanInput, stagingPath, options);

    onProgress({ stage: 'processing', message: 'Stripping tracking metadata & injecting signatures...' });

    const child = spawn(ffmpegBin, args);
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (e) { }
      reject(new Error(`FFmpeg execution failed: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0 && validateOutputFile(stagingPath)) {
        onProgress({ stage: 'validating', message: 'Validating processed media stream...' });

        try {
          moveFileSafely(stagingPath, finalOutputPath);

          onProgress({ stage: 'complete', message: 'Media successfully obfuscated!' });
          resolve({
            success: true,
            originalPath: cleanInput,
            outputPath: finalOutputPath,
            filename: path.basename(finalOutputPath),
            sizeFormatted: formatFileSize(fs.statSync(finalOutputPath).size),
            timestamp: new Date().toISOString()
          });
        } catch (moveErr) {
          try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (e) { }
          reject(new Error(`Failed to finalize output file: ${moveErr.message}`));
        }
      } else {
        try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (e) { }
        const lastErr = stderr.split('\n').filter(Boolean).slice(-3).join(' ') || `FFmpeg exit code ${code}`;
        reject(new Error(`Obfuscation failed: ${lastErr}`));
      }
    });
  });
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  SIGNATURE_PRESETS,
  buildFfmpegArgs,
  moveFileSafely,
  resolveUniqueDestination,
  validateOutputFile,
  probeMediaInfo,
  processMediaObfuscation,
  ensureAppleMediaCompatibility,
  formatFileSize,
  generateOutputFilename
};
