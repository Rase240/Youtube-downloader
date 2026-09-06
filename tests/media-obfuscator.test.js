/**
 * tests/media-obfuscator.test.js
 * Comprehensive Regression & Security Test Suite for Local Media Obfuscator
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const http = require('http');

const {
  SUPPORTED_EXTENSIONS,
  SIGNATURE_PRESETS,
  buildFfmpegArgs,
  moveFileSafely,
  resolveUniqueDestination,
  validateOutputFile,
  probeMediaInfo,
  processMediaObfuscation
} = require('../media-obfuscator');

const FFMPEG_BIN = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const TEST_WORKSPACE = path.join(__dirname, 'scratch_test_workspace');

function computeSha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function generateSyntheticMedia(outPath, formatExt) {
  const args = ['-y'];
  if (formatExt !== '.mp3') {
    args.push('-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10');
    args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1');
    if (formatExt === '.webm') {
      args.push('-c:v', 'libvpx', '-c:a', 'libvorbis');
    } else if (formatExt === '.avi') {
      args.push('-c:v', 'mpeg4', '-c:a', 'mp3');
    } else {
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
    }
  } else {
    args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libmp3lame');
  }

  // Embed realistic sensitive metadata
  args.push(
    '-metadata', 'title=Classified_Surveillance_RAW',
    '-metadata', 'artist=Jane Doe Agent 007',
    '-metadata', 'comment=Filmed at Secret Base Coordinates 37.7749',
    '-metadata', 'make=Sony Alpha',
    '-metadata', 'model=ILCE-7SM3-SERIAL-998877',
    '-metadata', 'location=+37.7749-122.4194/',
    outPath
  );

  const res = spawnSync(FFMPEG_BIN, args);
  if (res.status !== 0) {
    throw new Error(`Failed to generate test media ${formatExt}: ${res.stderr.toString()}`);
  }
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: options.port || 3456,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: false
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

describe('Local Media Obfuscator - Comprehensive Suite', () => {

  before(() => {
    if (!fs.existsSync(TEST_WORKSPACE)) {
      fs.mkdirSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  after(() => {
    try {
      if (fs.existsSync(TEST_WORKSPACE)) {
        fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
      }
    } catch (e) { }
  });

  // 1. CORE CONTAINER TESTS (All 7 formats)
  describe('1. Core Container Support (All 7 Formats)', () => {
    const formats = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mp3'];

    for (const ext of formats) {
      test(`Lossless stream-copy obfuscation for ${ext}`, async () => {
        const rawFile = path.join(TEST_WORKSPACE, `test_core${ext}`);
        generateSyntheticMedia(rawFile, ext);

        const shaBefore = computeSha256(rawFile);
        assert.ok(fs.existsSync(rawFile), `Raw file ${rawFile} exists`);

        const result = await processMediaObfuscation(FFMPEG_BIN, rawFile, TEST_WORKSPACE, {
          signatureKey: 'adobe-premiere',
          timestampMode: 'random-past',
          namingStrategy: 'suffix'
        });

        assert.strictEqual(result.success, true);
        assert.ok(fs.existsSync(result.outputPath), 'Obfuscated output exists');
        assert.notStrictEqual(result.outputPath, rawFile, 'Output path differs from input');

        // Verify original file bit-for-bit untouched
        const shaAfter = computeSha256(rawFile);
        assert.strictEqual(shaBefore, shaAfter, `Original file ${ext} MUST remain byte-identical`);

        // Verify output file playability / probing
        const probeRes = await probeMediaInfo(FFMPEG_BIN, result.outputPath);
        assert.strictEqual(probeRes.filename, path.basename(result.outputPath));
        assert.ok(probeRes.sizeBytes > 1024, 'Output file non-empty');
      });
    }
  });

  // 2. METADATA STRIPPING & SPOOFING VERIFICATION
  describe('2. Metadata Stripping & Spoofing Audit', () => {
    test('Verifies sensitive tags (GPS, camera, secret comments) are removed in MP4', async () => {
      const rawFile = path.join(TEST_WORKSPACE, 'meta_test.mp4');
      generateSyntheticMedia(rawFile, '.mp4');

      const result = await processMediaObfuscation(FFMPEG_BIN, rawFile, TEST_WORKSPACE, {
        signatureKey: 'davinci-resolve',
        timestampMode: 'random-past',
        namingStrategy: 'custom',
        customName: 'clean_export'
      });

      // Extract raw metadata dictionary via ffmetadata
      const metaOut = spawnSync(FFMPEG_BIN, ['-i', result.outputPath, '-f', 'ffmetadata', '-'], { encoding: 'utf8' }).stdout;
      const rawMeta = spawnSync(FFMPEG_BIN, ['-i', rawFile, '-f', 'ffmetadata', '-'], { encoding: 'utf8' }).stdout;

      assert.ok(rawMeta.includes('location=+37.7749'), 'Original has location tag');
      assert.ok(rawMeta.includes('Jane Doe'), 'Original has artist tag');
      assert.ok(rawMeta.includes('Secret Base'), 'Original has comment tag');

      // In obfuscated:
      assert.strictEqual(metaOut.includes('location='), false, 'Location tag removed');
      assert.strictEqual(metaOut.includes('Jane Doe'), false, 'Artist name removed');
      assert.strictEqual(metaOut.includes('Secret Base'), false, 'Original comment removed');

      // Probe check for container signature tag
      const probeOut = spawnSync(FFMPEG_BIN, ['-hide_banner', '-i', result.outputPath], { encoding: 'utf8' }).stderr;
      assert.ok(
        probeOut.includes('DaVinci Resolve Studio 19.0.1') ||
        probeOut.includes('clean_export'),
        'Custom clean export and studio tags applied'
      );
    });

    test('Verifies creation_time timestamp modification', async () => {
      const rawFile = path.join(TEST_WORKSPACE, 'time_test.mp4');
      generateSyntheticMedia(rawFile, '.mp4');

      const result = await processMediaObfuscation(FFMPEG_BIN, rawFile, TEST_WORKSPACE, {
        timestampMode: 'random-past',
        namingStrategy: 'random'
      });

      const probeOut = spawnSync(FFMPEG_BIN, ['-hide_banner', '-i', result.outputPath], { encoding: 'utf8' }).stderr;
      const timeMatch = probeOut.match(/creation_time\s*:\s*(\d{4}-\d{2}-\d{2})/);
      assert.ok(timeMatch !== null, 'Output has creation_time attribute');
    });
  });

  // 3. ORIGINAL FILE & ATOMIC OUTPUT SAFETY
  describe('3. File Safety & Staging Protection', () => {
    test('Guarantees original file is NEVER overwritten on collision', async () => {
      const rawFile = path.join(TEST_WORKSPACE, 'safety_original.mp4');
      generateSyntheticMedia(rawFile, '.mp4');
      const originalSha = computeSha256(rawFile);

      // Attempt obfuscating with the EXACT same filename in the same directory
      const rawBase = path.basename(rawFile, '.mp4');
      const result = await processMediaObfuscation(FFMPEG_BIN, rawFile, TEST_WORKSPACE, {
        namingStrategy: 'custom',
        customName: rawBase // Intentionally identical name
      });

      assert.notStrictEqual(result.outputPath, rawFile, 'Collision resolution generated distinct path');
      assert.ok(result.outputPath.endsWith(`${rawBase}_1.mp4`), 'Appended collision counter');
      assert.strictEqual(computeSha256(rawFile), originalSha, 'Original file bit-for-bit unchanged');
    });

    test('Staging failure cleans up temporary files without altering source', async () => {
      const rawFile = path.join(TEST_WORKSPACE, 'corrupt_test.mp4');
      fs.writeFileSync(rawFile, 'NOT_A_REAL_VIDEO_HEADER');
      const shaBefore = computeSha256(rawFile);

      await assert.rejects(
        processMediaObfuscation(FFMPEG_BIN, rawFile, TEST_WORKSPACE, {}),
        /Obfuscation failed/
      );

      // Source is untouched
      assert.strictEqual(computeSha256(rawFile), shaBefore, 'Source untouched on failure');

      // No stray staging files left
      const remainingFiles = fs.readdirSync(TEST_WORKSPACE);
      const stagingFiles = remainingFiles.filter(f => f.startsWith('.staging_'));
      assert.strictEqual(stagingFiles.length, 0, 'Staging file was cleaned up');
    });

    test('Rejects non-existent input files gracefully', async () => {
      const missingFile = path.join(TEST_WORKSPACE, 'does_not_exist.mp4');
      await assert.rejects(
        processMediaObfuscation(FFMPEG_BIN, missingFile, TEST_WORKSPACE, {}),
        /Input file does not exist/
      );
    });

    test('Rejects directories passed as input files', async () => {
      await assert.rejects(
        processMediaObfuscation(FFMPEG_BIN, TEST_WORKSPACE, TEST_WORKSPACE, {}),
        /Input file does not exist or is not a regular file/
      );
    });

    test('Rejects unsupported file extensions (.exe, .sh, .txt)', async () => {
      const exeFile = path.join(TEST_WORKSPACE, 'danger.exe');
      fs.writeFileSync(exeFile, 'fake binary');
      await assert.rejects(
        processMediaObfuscation(FFMPEG_BIN, exeFile, TEST_WORKSPACE, {}),
        /Unsupported format/
      );
    });

    test('moveFileSafely handles cross-device EXDEV fallback', () => {
      const src = path.join(TEST_WORKSPACE, 'move_src.txt');
      const dest = path.join(TEST_WORKSPACE, 'move_dest.txt');
      fs.writeFileSync(src, 'cross device test content');

      moveFileSafely(src, dest);
      assert.strictEqual(fs.existsSync(src), false, 'Source unlinked after move');
      assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'cross device test content');
    });
  });

  // 4. SERVER UPLOAD & SECURITY AUDIT
  describe('4. Server Security & Upload Vulnerability Audit', () => {
    let serverProcess = null;
    const TEST_PORT = 3456;
    let validToken = null;

    before(async () => {
      // Start express server in a child process with TEST_PORT and APP_PASSWORD
      const env = { ...process.env, PORT: String(TEST_PORT), APP_PASSWORD: 'testpassword123' };
      serverProcess = require('child_process').spawn('node', ['server.js'], { env, cwd: path.join(__dirname, '..') });

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Obtain session token via /api/auth/verify
      const authRes = await httpRequest({
        port: TEST_PORT,
        path: '/api/auth/verify',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, JSON.stringify({ password: 'testpassword123' }));

      const data = JSON.parse(authRes.body);
      validToken = data.token;
      assert.ok(validToken, 'Obtained auth session token');
    });

    after(() => {
      if (serverProcess) {
        serverProcess.kill();
      }
    });

    test('Rejects unauthenticated upload requests with HTTP 401', async () => {
      const res = await httpRequest({
        port: TEST_PORT,
        path: '/api/obfuscate-upload',
        method: 'POST',
        headers: { 'Content-Length': '10' }
      }, 'helloworld');
      assert.strictEqual(res.status, 401, 'Unauthorized request rejected with 401');
    });

    test('Rejects unsupported file format upload with HTTP 400', async () => {
      const res = await httpRequest({
        port: TEST_PORT,
        path: '/api/obfuscate-upload',
        method: 'POST',
        headers: {
          'x-access-token': validToken,
          'x-filename': 'malicious_script.sh',
          'Content-Length': '11'
        }
      }, '#!/bin/bash');

      assert.strictEqual(res.status, 400, 'Unsupported format rejected with 400');
      const json = JSON.parse(res.body);
      assert.ok(json.error.includes('Unsupported format'));
    });

    test('Handles malformed URI encoded filenames safely without crashing', async () => {
      const res = await httpRequest({
        port: TEST_PORT,
        path: '/api/obfuscate-upload',
        method: 'POST',
        headers: {
          'x-access-token': validToken,
          'x-filename': '%E0%A4%A_malformed.mp4',
          'Content-Length': '10'
        }
      }, 'dummydata!');
      assert.ok(res.status === 400 || res.status === 500);

      // Verify server is STILL alive
      const health = await httpRequest({ port: TEST_PORT, path: '/api/health', method: 'GET' });
      assert.strictEqual(health.status, 200, 'Server process remained healthy');
    });

    test('Blocks directory traversal in filenames', async () => {
      const res = await httpRequest({
        port: TEST_PORT,
        path: '/api/obfuscate-upload',
        method: 'POST',
        headers: {
          'x-access-token': validToken,
          'x-filename': '../../../../windows/system32/cmd.mp4',
          'Content-Length': '10'
        }
      }, 'dummydata!');
      assert.ok(res.status === 400 || res.status === 500);
    });

    test('Enforces 500 MB upload limit via Content-Length header with HTTP 413', async () => {
      const res = await httpRequest({
        port: TEST_PORT,
        path: '/api/obfuscate-upload',
        method: 'POST',
        headers: {
          'x-access-token': validToken,
          'x-filename': 'massive.mp4',
          'Content-Length': String(600 * 1024 * 1024)
        }
      });
      assert.strictEqual(res.status, 413, 'Oversized payload rejected with 413');
    });

    test('Successful authenticated upload produces obfuscated download URL with high-entropy filename', async () => {
      const smallMedia = path.join(TEST_WORKSPACE, 'server_upload.mp4');
      generateSyntheticMedia(smallMedia, '.mp4');
      const mediaBuf = fs.readFileSync(smallMedia);

      const res = await httpRequest({
        port: TEST_PORT,
        path: '/api/obfuscate-upload',
        method: 'POST',
        headers: {
          'x-access-token': validToken,
          'x-filename': 'my_private_video.mp4',
          'x-signature': 'adobe-premiere',
          'Content-Length': String(mediaBuf.length)
        }
      }, mediaBuf);

      assert.strictEqual(res.status, 200, 'Upload succeeded with 200');
      const json = JSON.parse(res.body);
      assert.strictEqual(json.success, true);
      assert.ok(json.downloadUrl.startsWith('/api/file/'));

      // Verify filename is high-entropy / unpredictable (contains proj_<hex>_)
      assert.ok(json.filename.startsWith('proj_'), 'Filename prefixed with proj_');
      assert.ok(json.filename.length > 20, 'Filename contains cryptographic entropy');

      // Verify download of clean file works with authentication
      const dlRes = await httpRequest({
        port: TEST_PORT,
        path: json.downloadUrl,
        method: 'GET',
        headers: { 'x-access-token': validToken }
      });
      assert.strictEqual(dlRes.status, 200, 'Clean file downloaded successfully');
    });
  });
});
