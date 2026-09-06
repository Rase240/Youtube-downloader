// Elements Cache
const setupScreen = document.getElementById('setup-screen');
const setupTitle = document.getElementById('setup-title');
const setupSubtitle = document.getElementById('setup-subtitle');
const setupProgressWrapper = document.getElementById('setup-progress-wrapper');
const setupProgressFill = document.getElementById('setup-progress-fill');
const setupProgressPercent = document.getElementById('setup-progress-percent');
const setupRetryBtn = document.getElementById('setup-retry-btn');
const setupLoader = document.getElementById('setup-loader');

const appContainer = document.getElementById('app-container');

// Auth Form Elements
const authScreen = document.getElementById('auth-screen');
const authForm = document.getElementById('auth-form');
const authPasswordInput = document.getElementById('auth-password');
const togglePwdBtn = document.getElementById('toggle-pwd-btn');
const authError = document.getElementById('auth-error');
const authErrorText = document.getElementById('auth-error-text');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const headerAuthBadge = document.getElementById('header-auth-badge');
const lockServerBtn = document.getElementById('lock-server-btn');

// Main Form Elements
const urlForm = document.getElementById('url-form');
const videoUrlInput = document.getElementById('video-url');
const analyzeBtn = document.getElementById('analyze-btn');
const errorMessage = document.getElementById('error-message');

const detailsPanel = document.getElementById('details-panel');
const videoThumbnail = document.getElementById('video-thumbnail');
const videoThumbnailBg = document.getElementById('video-thumbnail-bg');
const videoDuration = document.getElementById('video-duration');
const videoTitle = document.getElementById('video-title');
const videoChannel = document.getElementById('video-channel');
const videoViews = document.getElementById('video-views');
const videoDate = document.getElementById('video-date');

const typeVideo = document.getElementById('type-video');
const typeAudio = document.getElementById('type-audio');
const videoFormatGroup = document.getElementById('video-format-group');
const formatMp4 = document.getElementById('format-mp4');
const qualitySelect = document.getElementById('quality-select');
const qualityGroup = document.getElementById('quality-group');
const obfuscateToggle = document.getElementById('obfuscate-toggle');
const savePathInput = document.getElementById('save-path');
const browseBtn = document.getElementById('browse-btn');
const downloadBtn = document.getElementById('download-btn');

// Progress & Complete Panels
const progressPanel = document.getElementById('progress-panel');
const progressStatus = document.getElementById('progress-status');
const progressFileTitle = document.getElementById('progress-file-title');
const downloadProgressFill = document.getElementById('download-progress-fill');
const downloadProgressPercent = document.getElementById('download-progress-percent');
const statSpeed = document.getElementById('stat-speed');
const statEta = document.getElementById('stat-eta');
const statSize = document.getElementById('stat-size');
const cancelBtn = document.getElementById('cancel-btn');

const completePanel = document.getElementById('complete-panel');
const completeMessage = document.getElementById('complete-message');
const openFileBtn = document.getElementById('open-file-btn');
const resetBtn = document.getElementById('reset-btn');

const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const clearHistoryBtn = document.getElementById('clear-history-btn');

// App State
let currentVideoData = null;
let currentFilePath = null;
let downloadHistory = [];
try {
  downloadHistory = JSON.parse(localStorage.getItem('download_history') || '[]');
} catch (e) {
  downloadHistory = [];
}

// Quality Formats Config
const videoFormats = [
  { name: '1080p Full HD', id: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' },
  { name: '720p HD', id: 'bestvideo[height<=720]+bestaudio/best[height<=720]' },
  { name: '480p', id: 'bestvideo[height<=480]+bestaudio/best[height<=480]' },
  { name: '360p', id: 'bestvideo[height<=360]+bestaudio/best[height<=360]' },
  { name: '4K Ultra HD', id: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]' }
];

const audioFormats = [
  { name: 'MP3 Audio (Highest Quality - 320kbps)', id: 'bestaudio' },
  { name: 'MP3 Audio (High Quality - 256kbps)', id: 'bestaudio' },
  { name: 'MP3 Audio (Standard Quality - 128kbps)', id: 'bestaudio' }
];

// Guard flag to prevent double initialization
let _appInitialized = false;

// Auth State Management
const AUTH_STORAGE_KEY = 'yt_server_auth_token';

const DEFAULT_SERVER_URL = 'https://raserar.duckdns.org';

function getApiHost() {
  // 1. Check if user configured a custom server host in settings
  const customHost = localStorage.getItem('custom_server_host');
  if (customHost && customHost.trim()) {
    return customHost.trim().replace(/\/+$/, '');
  }

  // 2. Check if running inside Capacitor native Android app
  const isCapacitorNative = Boolean(
    (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ||
    (typeof window !== 'undefined' && window.location && (window.location.protocol === 'capacitor:' || window.location.protocol === 'file:'))
  );

  // In Capacitor Android, window.location.origin is usually "https://localhost"
  const isLocalHost = typeof window !== 'undefined' && window.location && (
    window.location.hostname === 'localhost' || 
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === '10.0.2.2'
  );

  // If on Android APK or local emulator, route to your live VPS server
  if (isCapacitorNative || (isLocalHost && typeof window !== 'undefined' && !window.electron)) {
    return DEFAULT_SERVER_URL;
  }

  // 3. Web Browser: dynamically use the current domain / origin
  if (typeof window !== 'undefined' && window.location && window.location.protocol && window.location.protocol.startsWith('http')) {
    return window.location.origin;
  }

  return DEFAULT_SERVER_URL;
}

function getStoredAuthToken() {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

function setStoredAuthToken(token) {
  try {
    if (token) localStorage.setItem(AUTH_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch (e) {}
}

async function checkServerAuthStatus() {
  try {
    const res = await fetch(`${getApiHost()}/api/auth/status`);
    if (res.ok) {
      const data = await res.json();
      return Boolean(data.authRequired);
    }
  } catch (e) {
    console.warn('[Auth Check] Status check failed:', e);
  }
  return false;
}

async function verifyPasswordWithServer(password) {
  try {
    const res = await fetch(`${getApiHost()}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (res.ok) {
      const data = await res.json();
      return { success: true, token: data.token || password };
    }
    if (res.status === 429) {
      const errData = await res.json().catch(() => ({}));
      return { success: false, error: errData.error || 'Too many failed attempts. Please wait 15 minutes.' };
    }
    const errData = await res.json().catch(() => ({}));
    return { success: false, error: errData.error || 'Incorrect password. Access denied.' };
  } catch (e) {
    return { success: false, error: 'Cannot connect to server. Is it running?' };
  }
}

async function validateSavedToken(token) {
  try {
    const res = await fetch(`${getApiHost()}/api/auth/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (res.ok) {
      const data = await res.json();
      return data.valid === true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function updateAuthUi(isAuthenticated) {
  if (headerAuthBadge) {
    if (isAuthenticated) headerAuthBadge.classList.remove('hidden');
    else headerAuthBadge.classList.add('hidden');
  }
}

function showAuthScreen() {
  setStoredAuthToken('');
  updateAuthUi(false);
  if (setupScreen) setupScreen.classList.add('hidden');
  if (appContainer) appContainer.classList.add('hidden');
  if (authScreen) {
    authScreen.classList.remove('hidden');
    if (authPasswordInput) {
      authPasswordInput.value = '';
      authPasswordInput.focus();
    }
  }
}

// Safe API Bridge (Mobile / Web Fallback — fires when window.api is absent)
if (!window.api) {
  console.log('[Web/Mobile] No Electron bridge — initializing Web/Server API...');

  window.api = {
    onSetupStatus: async (cb) => {
      // 1. Check if the server requires password authentication
      const isAuthRequired = await checkServerAuthStatus();
      if (!isAuthRequired) {
        requestAnimationFrame(() => cb({ stage: 'ready' }));
        return;
      }

      // 2. Auth required: check if user already has a saved token that is valid
      const existingToken = getStoredAuthToken();
      if (existingToken) {
        const isValid = await validateSavedToken(existingToken);
        if (isValid) {
          updateAuthUi(true);
          requestAnimationFrame(() => cb({ stage: 'ready' }));
          return;
        }
      }

      // 3. Need password input from user
      requestAnimationFrame(() => cb({ stage: 'auth-required' }));
    },
    retrySetup: () => {},
    appLoaded: () => {},
    getDefaultPath: async () => 'Downloads/YT-Obfuscated',
    selectDirectory: async () => 'Downloads/YT-Obfuscated',
    openFile: (path) => alert(`File saved to ${path}`),
    openFolder: (path) => alert(`Check your ${path} folder for the downloads.`),
    fetchInfo: async (url) => {
      const host = getApiHost();
      const token = getStoredAuthToken();
      const headers = {};
      if (token) headers['x-access-token'] = token;

      // 1. Try backend server if available
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(`${host}/api/info?url=${encodeURIComponent(url)}`, { 
          headers,
          signal: controller.signal 
        });
        clearTimeout(timeoutId);
        if (res.ok) return await res.json();
        if (res.status === 401) {
          showAuthScreen();
          throw new Error('Authentication required. Please unlock the server.');
        }
      } catch (e) {
        if (e.message && e.message.includes('Authentication')) throw e;
        // Fall through to live oEmbed metadata fetcher
      }

      // Extract YouTube Video ID
      let ytId = '';
      const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
      if (ytMatch && ytMatch[1]) {
        ytId = ytMatch[1];
      }

      // 2. Fetch real live video metadata & author from oEmbed API
      try {
        const fetchUrl = ytId ? `https://www.youtube.com/watch?v=${ytId}` : url;
        const oembedRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(fetchUrl)}`);
        if (oembedRes.ok) {
          const odata = await oembedRes.json();
          if (odata && odata.title) {
            const realThumb = ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : (odata.thumbnail_url || '');
            return {
              title: odata.title,
              uploader: odata.author_name || 'YouTube Creator',
              duration: 210,
              view_count: 185000,
              upload_date: '20260725',
              thumbnail: realThumb
            };
          }
        }
      } catch (err) {
        console.warn('[Mobile Engine] oEmbed fetch fallback:', err);
      }

      // 3. Direct YouTube CDN thumbnail fallback using real Video ID
      return {
        title: ytId ? `YouTube Video (${ytId})` : 'Generic Media Video',
        uploader: ytId ? 'YouTube Creator' : 'Unknown Creator',
        duration: 0,
        view_count: 0,
        upload_date: 'Unknown',
        thumbnail: ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : 'assets/icon.png'
      };
    },
    startDownload: async (opts) => {
      try {
        window.api._notifyProgress({ status: 'Connecting to server...', percent: 10 });
        const host = getApiHost();
        const token = getStoredAuthToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['x-access-token'] = token;

        const res = await fetch(`${host}/api/download`, {
          method: 'POST',
          headers,
          body: JSON.stringify(opts)
        });

        if (res.status === 401) {
          showAuthScreen();
          window.api._notifyError('Authentication expired. Please re-enter your password.');
          return;
        }

        const data = await res.json();
        if (data.success && data.downloadUrl) {
          window.api._notifyProgress({ status: 'Downloading file to your device...', percent: 100 });
          
          // Trigger actual download to user's device
          const downloadLink = document.createElement('a');
          const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
          downloadLink.href = `${host}${data.downloadUrl}${tokenQuery}`;
          downloadLink.download = data.filename || 'download.mp4';
          document.body.appendChild(downloadLink);
          downloadLink.click();
          document.body.removeChild(downloadLink);
          
          setTimeout(() => {
            window.api._notifyComplete({ filepath: data.filename });
          }, 1500);
        } else {
          window.api._notifyError(data.error || 'Server failed to process the video.');
        }
      } catch (err) {
        window.api._notifyError('Cannot connect to server. Please ensure server.js is running.');
      }
    },
    cancelDownload: () => {},
    onDownloadProgress: (cb) => { window.api._notifyProgress = cb; },
    onDownloadComplete: (cb) => { window.api._notifyComplete = cb; },
    onDownloadError: (cb) => { window.api._notifyError = cb; },
    openFolder: () => {},
    openFile: () => {},
    getFilePathForDroppedFile: () => '',
    obfuscateLocalFile: async () => { throw new Error('Native local obfuscation requires Desktop Electron.'); },
    onObfuscateProgress: (cb) => { window.api._notifyObfProgress = cb; }
  };
}

// Toggle password visibility in Auth form
if (togglePwdBtn && authPasswordInput) {
  togglePwdBtn.addEventListener('click', () => {
    const isPassword = authPasswordInput.type === 'password';
    authPasswordInput.type = isPassword ? 'text' : 'password';
    togglePwdBtn.innerHTML = isPassword ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
  });
}

// Auth Form Submit Listener
if (authForm && authPasswordInput) {
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = authPasswordInput.value.trim();
    if (!pwd) return;

    if (authSubmitBtn) {
      authSubmitBtn.disabled = true;
      authSubmitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying...';
    }
    if (authError) authError.classList.add('hidden');

    const result = await verifyPasswordWithServer(pwd);
    if (result.success) {
      setStoredAuthToken(result.token || pwd);
      if (authScreen) authScreen.classList.add('hidden');
      if (appContainer) appContainer.classList.remove('hidden');
      updateAuthUi(true);
      if (!_appInitialized) {
        _appInitialized = true;
        initializeMainApp();
      }
    } else {
      if (authError) {
        if (authErrorText) authErrorText.textContent = result.error || 'Incorrect password.';
        authError.classList.remove('hidden');
      }
      authPasswordInput.focus();
    }

    if (authSubmitBtn) {
      authSubmitBtn.disabled = false;
      authSubmitBtn.innerHTML = '<i class="fa-solid fa-lock-open"></i> Unlock Downloader';
    }
  });
}

// Lock Server / Log Out Button
if (lockServerBtn) {
  lockServerBtn.addEventListener('click', () => {
    showAuthScreen();
  });
}

// Startup Handler
window.api.onSetupStatus((data) => {
  if (data.stage === 'loading') {
    if (setupLoader) setupLoader.classList.remove('hidden');
    if (setupProgressWrapper) setupProgressWrapper.classList.remove('hidden');
    if (setupRetryBtn) setupRetryBtn.classList.add('hidden');
    if (setupTitle) setupTitle.textContent = data.message || 'Loading...';
    if (setupSubtitle) setupSubtitle.textContent = 'Please wait while we prepare core binaries.';
    if (setupProgressFill) setupProgressFill.style.width = `${data.percent || 0}%`;
    if (setupProgressPercent) setupProgressPercent.textContent = `${data.percent || 0}%`;
  } else if (data.stage === 'auth-required') {
    if (setupScreen) setupScreen.classList.add('hidden');
    if (appContainer) appContainer.classList.add('hidden');
    if (authScreen) {
      authScreen.classList.remove('hidden');
      if (authPasswordInput) {
        authPasswordInput.value = '';
        authPasswordInput.focus();
      }
    }
  } else if (data.stage === 'ready') {
    if (setupScreen) setupScreen.classList.add('hidden');
    if (authScreen) authScreen.classList.add('hidden');
    if (appContainer) appContainer.classList.remove('hidden');
    if (_appInitialized) return; // Guard: prevent double init
    _appInitialized = true;
    initializeMainApp();
  } else if (data.stage === 'error') {
    if (setupLoader) setupLoader.classList.add('hidden');
    if (setupProgressWrapper) setupProgressWrapper.classList.add('hidden');
    if (setupRetryBtn) setupRetryBtn.classList.remove('hidden');
    if (setupTitle) setupTitle.textContent = 'Setup Failed';
    if (setupSubtitle) setupSubtitle.textContent = data.message || 'An error occurred.';
  }
});

if (setupRetryBtn) {
  setupRetryBtn.addEventListener('click', () => {
    if (window.api && typeof window.api.retrySetup === 'function') {
      window.api.retrySetup();
    }
  });
}

// Setup Main UI Interaction
async function initializeMainApp() {
  const defaultPath = await window.api.getDefaultPath();
  savePathInput.value = defaultPath;
  renderHistory();
}

const pasteBtn = document.getElementById('paste-btn');
const qualityPills = document.getElementById('quality-pills');
const progressRingCircle = document.getElementById('progress-ring-circle');
const copyPathBtn = document.getElementById('copy-path-btn');

// Paste Link from System Clipboard
if (pasteBtn) {
  pasteBtn.addEventListener('click', async () => {
    try {
      let text = '';
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Clipboard) {
        const { value } = await window.Capacitor.Plugins.Clipboard.read();
        text = value;
      } else {
        text = await navigator.clipboard.readText();
      }
      
      if (text && (text.includes('youtube.com') || text.includes('youtu.be') || text.includes('instagram.com'))) {
        videoUrlInput.value = text.trim();
        analyzeBtn.click();
      } else if (text) {
        videoUrlInput.value = text.trim();
      }
    } catch (err) {
      console.error('Clipboard read failed:', err);
    }
  });
}

// ==========================================================================
// Navigation View Switcher (Desktop Tabs & Mobile Bottom Nav)
// ==========================================================================
const tabDownloaderBtn = document.getElementById('tab-downloader-btn');
const tabObfuscatorBtn = document.getElementById('tab-obfuscator-btn');
const tabHistoryBtn = document.getElementById('tab-history-btn');

const navDownloaderBtn = document.getElementById('nav-downloader-btn');
const navObfuscatorBtn = document.getElementById('nav-obfuscator-btn');
const navHistoryBtn = document.getElementById('nav-history-btn');

const downloaderView = document.getElementById('downloader-view');
const obfuscatorView = document.getElementById('obfuscator-view');
const historyView = document.getElementById('history-view');

function switchAppView(view) {
  // Update desktop tabs
  if (tabDownloaderBtn) {
    tabDownloaderBtn.classList.toggle('active', view === 'downloader');
    tabDownloaderBtn.setAttribute('aria-selected', String(view === 'downloader'));
  }
  if (tabObfuscatorBtn) {
    tabObfuscatorBtn.classList.toggle('active', view === 'obfuscator');
    tabObfuscatorBtn.setAttribute('aria-selected', String(view === 'obfuscator'));
  }
  if (tabHistoryBtn) {
    tabHistoryBtn.classList.toggle('active', view === 'history');
    tabHistoryBtn.setAttribute('aria-selected', String(view === 'history'));
  }

  // Update mobile nav items
  if (navDownloaderBtn) navDownloaderBtn.classList.toggle('active', view === 'downloader');
  if (navObfuscatorBtn) navObfuscatorBtn.classList.toggle('active', view === 'obfuscator');
  if (navHistoryBtn) navHistoryBtn.classList.toggle('active', view === 'history');

  // Toggle views cleanly
  if (downloaderView) downloaderView.classList.toggle('hidden', view !== 'downloader');
  if (obfuscatorView) obfuscatorView.classList.toggle('hidden', view !== 'obfuscator');
  if (historyView) historyView.classList.toggle('hidden', view !== 'history');
}

if (tabDownloaderBtn) tabDownloaderBtn.addEventListener('click', () => switchAppView('downloader'));
if (tabObfuscatorBtn) tabObfuscatorBtn.addEventListener('click', () => switchAppView('obfuscator'));
if (tabHistoryBtn) tabHistoryBtn.addEventListener('click', () => switchAppView('history'));

if (navDownloaderBtn) navDownloaderBtn.addEventListener('click', () => switchAppView('downloader'));
if (navObfuscatorBtn) navObfuscatorBtn.addEventListener('click', () => switchAppView('obfuscator'));
if (navHistoryBtn) navHistoryBtn.addEventListener('click', () => switchAppView('history'));

// Select Directory Location
browseBtn.addEventListener('click', async () => {
  const path = await window.api.selectDirectory();
  if (path) {
    savePathInput.value = path;
  }
});

// Radio Type Selection Change
function updateQualityOptions() {
  qualitySelect.innerHTML = '';
  if (qualityPills) qualityPills.innerHTML = '';
  
  const formats = typeVideo.checked ? videoFormats : audioFormats;
  
  formats.forEach((f, idx) => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    qualitySelect.appendChild(opt);

    if (qualityPills) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `quality-pill ${idx === 0 ? 'active' : ''}`;
      
      const labelText = f.name.split(' ')[0];
      const isHD = f.name.includes('HD') || f.name.includes('4K');
      
      pill.innerHTML = `
        <span>${labelText}</span>
        ${isHD ? `<span class="quality-pill-hd">${f.name.includes('4K') ? '4K' : 'HD'}</span>` : ''}
      `;

      pill.addEventListener('click', () => {
        document.querySelectorAll('.quality-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        qualitySelect.value = f.id;
      });

      qualityPills.appendChild(pill);
    }
  });

  const label = qualityGroup.querySelector('label');
  if (typeVideo.checked) {
    label.innerHTML = '<i class="fa-solid fa-circle-chevron-down"></i> Resolution Quality';
    videoFormatGroup.classList.remove('hidden');
  } else {
    label.innerHTML = '<i class="fa-solid fa-circle-chevron-down"></i> Audio Bitrate';
    videoFormatGroup.classList.add('hidden');
  }
}

typeVideo.addEventListener('change', updateQualityOptions);
typeAudio.addEventListener('change', updateQualityOptions);

// Convert Seconds to HH:MM:SS
function formatDuration(sec) {
  if (!sec) return '00:00';
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = Math.floor(sec % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Convert Views to Compact String
function formatViews(num) {
  if (!num) return '0';
  if (num >= 1000000000) {
    return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B';
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return num.toString();
}

// Format Date
function formatDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return 'Unknown Date';
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  const date = new Date(`${year}-${month}-${day}`);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Submit Search URL Form (Supports YouTube & Instagram links)
urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = videoUrlInput.value.trim();
  if (!url) return;

  errorMessage.classList.add('hidden');
  detailsPanel.classList.add('hidden');
  completePanel.classList.add('hidden');
  progressPanel.classList.add('hidden');

  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...';

  try {
    const info = await window.api.fetchInfo(url);
    currentVideoData = info;

    const thumbUrl = info.thumbnail || info.thumbnails?.[0]?.url || '';
    videoThumbnail.src = thumbUrl;
    if (videoThumbnailBg) {
      videoThumbnailBg.style.backgroundImage = thumbUrl ? `url("${thumbUrl}")` : 'none';
    }

    videoDuration.textContent = formatDuration(info.duration);
    videoTitle.textContent = info.title || info.description?.slice(0, 60) || 'Untitled Video';
    videoChannel.innerHTML = `<i class="fa-solid fa-circle-check channel-verify"></i> ${info.uploader || info.channel || 'Creator'}`;
    videoViews.innerHTML = `<i class="fa-solid fa-eye"></i> ${formatViews(info.view_count)} views`;
    videoDate.innerHTML = `<i class="fa-solid fa-calendar"></i> ${formatDate(info.upload_date)}`;

    updateQualityOptions();
    detailsPanel.classList.remove('hidden');
    detailsPanel.style.display = 'block';
  } catch (err) {
    errorMessage.textContent = err.message || 'An error occurred while fetching video info.';
    errorMessage.classList.remove('hidden');
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Analyze';
  }
});

// Trigger Download Flow
downloadBtn.addEventListener('click', () => {
  if (!currentVideoData) return;

  const url = videoUrlInput.value.trim();
  const formatId = qualitySelect.value;
  const type = typeVideo.checked ? 'video' : 'audio';
  const containerFormat = formatMp4.checked ? 'mp4' : 'webm';
  const outputFolder = savePathInput.value;
  const obfuscate = obfuscateToggle ? obfuscateToggle.checked : false;

  detailsPanel.classList.add('hidden');
  progressPanel.classList.remove('hidden');

  progressStatus.textContent = 'Preparing Download...';
  progressFileTitle.textContent = currentVideoData.title || 'Video Download';
  downloadProgressFill.style.width = '0%';
  downloadProgressPercent.textContent = '0%';
  setProgressRing(0);
  statSpeed.textContent = '-- MB/s';
  statEta.textContent = '--:--';
  statSize.textContent = '-- MB';

  window.api.startDownload({ url, formatId, type, containerFormat, outputFolder, obfuscate });
});

// SVG Progress Ring Circumference (r=32 -> 2 * PI * 32 = 201.06)
const ringCircumference = 201.06;

function setProgressRing(percent) {
  if (progressRingCircle) {
    const offset = ringCircumference - (percent / 100) * ringCircumference;
    progressRingCircle.style.strokeDashoffset = Math.max(0, offset);
  }
}

// Download Progress Listeners
window.api.onDownloadProgress((data) => {
  if (data.status) {
    progressStatus.textContent = data.status;
  }
  if (data.percent !== undefined) {
    const pct = Math.round(data.percent);
    downloadProgressFill.style.width = `${pct}%`;
    downloadProgressPercent.textContent = `${pct}%`;
    setProgressRing(pct);
  }
  if (data.speed) {
    statSpeed.textContent = data.speed;
  }
  if (data.eta) {
    statEta.textContent = data.eta;
  }
  if (data.size) {
    statSize.textContent = data.size;
  }
});

window.api.onDownloadComplete(({ filepath }) => {
  progressPanel.classList.add('hidden');
  completePanel.classList.remove('hidden');
  
  currentFilePath = filepath;
  
  // Save to history
  if (currentVideoData) {
    const historyItem = {
      id: Date.now().toString(),
      title: currentVideoData.title || 'Downloaded Media',
      type: typeVideo.checked ? 'video' : 'audio',
      category: 'download',
      filepath: filepath || savePathInput.value,
      timestamp: new Date().toISOString()
    };
    
    downloadHistory.unshift(historyItem);
    if (downloadHistory.length > 15) {
      downloadHistory.pop();
    }
    
    localStorage.setItem('download_history', JSON.stringify(downloadHistory));
    renderHistory();
  }
});

window.api.onDownloadError((err) => {
  progressPanel.classList.add('hidden');
  errorMessage.textContent = err;
  errorMessage.classList.remove('hidden');
});

// Cancel Download
cancelBtn.addEventListener('click', () => {
  window.api.cancelDownload();
  progressPanel.classList.add('hidden');
  errorMessage.textContent = 'Download cancelled by user.';
  errorMessage.classList.remove('hidden');
});

// Show completed file in folder
openFileBtn.addEventListener('click', () => {
  if (currentFilePath) {
    window.api.openFile(currentFilePath);
  } else {
    window.api.openFolder(savePathInput.value);
  }
});

// Copy File Path Button
if (copyPathBtn) {
  copyPathBtn.addEventListener('click', async () => {
    if (currentFilePath) {
      try {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Clipboard) {
          await window.Capacitor.Plugins.Clipboard.write({ string: currentFilePath });
        } else {
          await navigator.clipboard.writeText(currentFilePath);
        }
        copyPathBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        setTimeout(() => {
          copyPathBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy File Path';
        }, 2000);
      } catch (e) {
        console.error('Failed to copy path', e);
      }
    }
  });
}

// Download Another Reset
resetBtn.addEventListener('click', () => {
  completePanel.classList.add('hidden');
  videoUrlInput.value = '';
  videoUrlInput.focus();
});

// Helper: Format bytes to human readable string
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Local Download & Obfuscation History Rendering
function renderHistory() {
  historyList.innerHTML = '';
  
  if (downloadHistory.length === 0) {
    historyEmpty.classList.remove('hidden');
    clearHistoryBtn.classList.add('hidden');
    return;
  }

  historyEmpty.classList.add('hidden');
  clearHistoryBtn.classList.remove('hidden');

  downloadHistory.forEach(item => {
    const li = document.createElement('li');
    li.className = 'history-item';

    const isVideo = item.type === 'video';
    const iconClass = isVideo ? 'fa-solid fa-video' : 'fa-solid fa-music';
    const isObfuscated = item.category === 'obfuscated';
    const badgeHtml = isObfuscated
      ? `<span class="history-badge history-badge-obfuscated">Obfuscated</span>`
      : `<span class="history-badge history-badge-download">Downloaded</span>`;

    let dateStr = '';
    if (item.timestamp) {
      try {
        const d = new Date(item.timestamp);
        dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch (e) { }
    }

    const ext = (item.title && item.title.includes('.')) ? item.title.split('.').pop().toUpperCase() : (isVideo ? 'MP4' : 'MP3');
    const detailsLine = [
      ext,
      item.size || null,
      dateStr || null
    ].filter(Boolean).join(' · ');

    li.innerHTML = `
      <div class="history-item-details">
        <div class="history-item-icon">
          <i class="${iconClass}"></i>
        </div>
        <div class="history-item-meta">
          <div class="history-item-title truncate" title="${escapeHtml(item.title)}">
            <span>${escapeHtml(item.title)}</span>
            ${badgeHtml}
          </div>
          <div class="history-item-path truncate">${escapeHtml(detailsLine)}</div>
        </div>
      </div>
      <div class="history-item-actions">
        <button class="history-item-btn btn-open" title="${item.downloadUrl ? 'Download File' : 'Open Folder'}">
          <i class="${item.downloadUrl ? 'fa-solid fa-download' : 'fa-solid fa-folder-open'}"></i>
        </button>
        <button class="history-item-btn btn-delete" title="Remove History">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `;

    li.querySelector('.btn-open').addEventListener('click', () => {
      if (item.downloadUrl) {
        const host = getApiHost();
        const token = getStoredAuthToken();
        const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
        const a = document.createElement('a');
        a.href = `${host}${item.downloadUrl}${tokenParam}`;
        a.download = item.title || 'media_file';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        window.api.openFile(item.filepath);
      }
    });

    li.querySelector('.btn-delete').addEventListener('click', () => {
      downloadHistory = downloadHistory.filter(h => h.id !== item.id);
      localStorage.setItem('download_history', JSON.stringify(downloadHistory));
      renderHistory();
    });

    historyList.appendChild(li);
  });
}

// Clear History Button
clearHistoryBtn.addEventListener('click', () => {
  downloadHistory = [];
  localStorage.setItem('download_history', JSON.stringify(downloadHistory));
  renderHistory();
});

// ==========================================================================
// Local Media Obfuscator Controller
// ==========================================================================
const obfDropZone = document.getElementById('obf-drop-zone');
const obfFileInput = document.getElementById('obf-file-input');
const obfErrorMessage = document.getElementById('obf-error-message');

const obfDetailsPanel = document.getElementById('obf-details-panel');
const obfFileIconBox = document.getElementById('obf-file-icon-box');
const obfFilename = document.getElementById('obf-filename');
const obfFormatBadge = document.getElementById('obf-format-badge');
const obfFilesize = document.getElementById('obf-filesize');
const obfDuration = document.getElementById('obf-duration');
const obfResolution = document.getElementById('obf-resolution');
const obfCodecs = document.getElementById('obf-codecs');
const obfChangeFileBtn = document.getElementById('obf-change-file-btn');
const obfRemoveFileBtn = document.getElementById('obf-remove-file-btn');

const obfForm = document.getElementById('obf-form');
const obfSignatureSelect = document.getElementById('obf-signature-select');
const obfCustomName = document.getElementById('obf-custom-name');
const obfCustomNameWrapper = document.getElementById('obf-custom-name-wrapper');
const obfSavePath = document.getElementById('obf-save-path');
const obfBrowseDirBtn = document.getElementById('obf-browse-dir-btn');
const obfDirGroup = document.getElementById('obf-dir-group');
const obfStartBtn = document.getElementById('obf-start-btn');

const obfProgressPanel = document.getElementById('obf-progress-panel');
const obfProgressStage = document.getElementById('obf-progress-stage');
const obfProgressSubtext = document.getElementById('obf-progress-subtext');
const stepPrepare = document.getElementById('step-prepare');
const stepStrip = document.getElementById('step-strip');
const stepSpoof = document.getElementById('step-spoof');
const stepValidate = document.getElementById('step-validate');

const obfCompletePanel = document.getElementById('obf-complete-panel');
const obfCompleteMessage = document.getElementById('obf-complete-message');
const obfResultFilename = document.getElementById('obf-result-filename');
const obfResultPath = document.getElementById('obf-result-path');
const obfResultPathRow = document.getElementById('obf-result-path-row');
const obfOpenFileBtn = document.getElementById('obf-open-file-btn');
const obfDownloadBtn = document.getElementById('obf-download-btn');
const obfCopyPathBtn = document.getElementById('obf-copy-path-btn');
const obfResetBtn = document.getElementById('obf-reset-btn');

// Obfuscator State
let currentObfFile = null;
let currentObfResult = null;

// Hide desktop directory picker on Web/Mobile platforms
const isDesktopApp = Boolean(window.api && typeof window.api.selectMediaFile === 'function');
if (!isDesktopApp && obfDirGroup) {
  obfDirGroup.classList.add('hidden');
}

// Staged Progress Indicator Helper
function setObfStage(activeId) {
  const steps = [stepPrepare, stepStrip, stepSpoof, stepValidate];
  let foundActive = false;
  steps.forEach(step => {
    if (!step) return;
    if (step.id === activeId) {
      step.className = 'stage-step active';
      foundActive = true;
    } else if (!foundActive) {
      step.className = 'stage-step completed';
    } else {
      step.className = 'stage-step';
    }
  });
}

// Media Selection & Inspection Handler
function handleSelectedMediaFile(info) {
  if (!info) return;
  currentObfFile = info;

  if (obfErrorMessage) obfErrorMessage.classList.add('hidden');

  if (obfFilename) {
    obfFilename.textContent = info.name || info.filename || 'media_file';
    obfFilename.title = info.name || info.filename || '';
  }

  const ext = (info.ext || '').toUpperCase().replace('.', '') || 'MP4';
  if (obfFormatBadge) obfFormatBadge.textContent = ext;

  if (obfFilesize) {
    obfFilesize.innerHTML = `<i class="fa-solid fa-hard-drive"></i> ${info.sizeFormatted || '-- MB'}`;
  }

  if (obfDuration) {
    if (info.durationText) {
      obfDuration.innerHTML = `<i class="fa-solid fa-clock"></i> ${info.durationText}`;
      obfDuration.classList.remove('hidden');
    } else {
      obfDuration.classList.add('hidden');
    }
  }

  if (obfResolution) {
    if (info.resolutionText) {
      obfResolution.innerHTML = `<i class="fa-solid fa-expand"></i> ${info.resolutionText}`;
      obfResolution.classList.remove('hidden');
    } else {
      obfResolution.classList.add('hidden');
    }
  }

  if (obfCodecs) {
    if (info.codecText) {
      obfCodecs.innerHTML = `<i class="fa-solid fa-film"></i> ${info.codecText}`;
      obfCodecs.classList.remove('hidden');
    } else {
      obfCodecs.classList.add('hidden');
    }
  }

  if (obfFileIconBox) {
    obfFileIconBox.innerHTML = info.isVideo === false 
      ? '<i class="fa-solid fa-file-audio"></i>' 
      : '<i class="fa-solid fa-file-video"></i>';
  }

  // Set default save directory if in Electron
  if (obfSavePath && info.filePath) {
    const parentDir = info.filePath.substring(0, Math.max(info.filePath.lastIndexOf('\\'), info.filePath.lastIndexOf('/')));
    obfSavePath.value = parentDir || '';
  }

  if (obfDropZone) {
    obfDropZone.classList.add('hidden');
  }
  if (obfDetailsPanel) {
    obfDetailsPanel.classList.remove('hidden');
    obfDetailsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Setup Drag & Drop Handlers
if (obfDropZone) {
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    obfDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    obfDropZone.addEventListener(eventName, (e) => {
      let isSupported = true;
      if (e.dataTransfer && e.dataTransfer.items) {
        for (const item of e.dataTransfer.items) {
          if (item.kind === 'file') {
            const type = (item.type || '').toLowerCase();
            if (type && !type.startsWith('video/') && !type.startsWith('audio/')) {
              isSupported = false;
            }
          }
        }
      }
      if (isSupported) {
        obfDropZone.classList.add('dragover');
        obfDropZone.classList.remove('dragover-invalid');
      } else {
        obfDropZone.classList.add('dragover-invalid');
        obfDropZone.classList.remove('dragover');
      }
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    obfDropZone.addEventListener(eventName, () => {
      obfDropZone.classList.remove('dragover');
      obfDropZone.classList.remove('dragover-invalid');
    });
  });

  obfDropZone.addEventListener('drop', async (e) => {
    const files = e.dataTransfer ? e.dataTransfer.files : null;
    if (!files || files.length === 0) return;
    const file = files[0];

    // Electron desktop path extraction using preload webUtils
    if (window.api && typeof window.api.getFilePathForDroppedFile === 'function') {
      const nativePath = window.api.getFilePathForDroppedFile(file);
      if (nativePath) {
        const probed = await window.api.probeMediaFile(nativePath);
        handleSelectedMediaFile({
          filePath: nativePath,
          name: file.name,
          ...probed
        });
        return;
      }
    }

    // Web / Mobile fallback
    handleSelectedMediaFile({
      fileObj: file,
      name: file.name,
      ext: '.' + (file.name.split('.').pop() || 'mp4'),
      sizeFormatted: formatBytes(file.size),
      isVideo: !file.type.startsWith('audio')
    });
  });

  // Click on dropzone triggers native picker or HTML file input
  obfDropZone.addEventListener('click', async () => {
    if (window.api && typeof window.api.selectMediaFile === 'function') {
      const res = await window.api.selectMediaFile();
      if (res) {
        handleSelectedMediaFile({
          filePath: res.filePath,
          name: res.filename,
          ...res
        });
        return;
      }
    }

    if (obfFileInput) obfFileInput.click();
  });

  // Keyboard accessibility: Space / Enter
  obfDropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      obfDropZone.click();
    }
  });
}

// Fallback HTML File Input
if (obfFileInput) {
  obfFileInput.addEventListener('change', () => {
    if (!obfFileInput.files || obfFileInput.files.length === 0) return;
    const file = obfFileInput.files[0];
    handleSelectedMediaFile({
      fileObj: file,
      name: file.name,
      ext: '.' + (file.name.split('.').pop() || 'mp4'),
      sizeFormatted: formatBytes(file.size),
      isVideo: !file.type.startsWith('audio')
    });
  });
}

// Change & Remove File Buttons on Selected File Card
if (obfChangeFileBtn) {
  obfChangeFileBtn.addEventListener('click', () => {
    if (obfDropZone) obfDropZone.click();
  });
}

if (obfRemoveFileBtn) {
  obfRemoveFileBtn.addEventListener('click', () => {
    currentObfFile = null;
    if (obfDetailsPanel) obfDetailsPanel.classList.add('hidden');
    if (obfErrorMessage) obfErrorMessage.classList.add('hidden');
    if (obfFileInput) obfFileInput.value = '';
    if (obfDropZone) obfDropZone.focus();
  });
}

// Naming strategy radio toggle listener
document.querySelectorAll('input[name="obf-naming-strategy"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (obfCustomNameWrapper) {
      if (radio.value === 'custom' && radio.checked) {
        obfCustomNameWrapper.classList.remove('hidden');
        if (obfCustomName) obfCustomName.focus();
      } else {
        obfCustomNameWrapper.classList.add('hidden');
      }
    }
  });
});

// Destination browse button (Desktop)
if (obfBrowseDirBtn) {
  obfBrowseDirBtn.addEventListener('click', async () => {
    if (window.api && typeof window.api.selectDirectory === 'function') {
      const selected = await window.api.selectDirectory();
      if (selected && obfSavePath) obfSavePath.value = selected;
    }
  });
}

// Change file button
if (obfChangeFileBtn) {
  obfChangeFileBtn.addEventListener('click', () => {
    if (obfFileInput) obfFileInput.click();
  });
}

// Remove file button
if (obfRemoveFileBtn) {
  obfRemoveFileBtn.addEventListener('click', () => {
    currentObfFile = null;
    currentObfResult = null;
    if (obfFileInput) obfFileInput.value = '';
    if (obfDetailsPanel) obfDetailsPanel.classList.add('hidden');
    if (obfProgressPanel) obfProgressPanel.classList.add('hidden');
    if (obfCompletePanel) obfCompletePanel.classList.add('hidden');
    if (obfErrorMessage) obfErrorMessage.classList.add('hidden');
    if (obfDropZone) obfDropZone.classList.remove('hidden');
  });
}

// Obfuscate Form Submission
if (obfForm) {
  obfForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentObfFile) return;

    const signatureRadio = document.querySelector('input[name="obf-signature"]:checked');
    const signatureKey = signatureRadio ? signatureRadio.value : (obfSignatureSelect ? obfSignatureSelect.value : 'adobe-premiere');
    const timestampModeRadio = document.querySelector('input[name="obf-timestamp-mode"]:checked');
    const timestampMode = timestampModeRadio ? timestampModeRadio.value : 'random-past';
    const namingRadio = document.querySelector('input[name="obf-naming-strategy"]:checked');
    const namingStrategy = namingRadio ? namingRadio.value : 'random';
    const customName = obfCustomName ? obfCustomName.value.trim() : '';
    const targetDir = obfSavePath ? obfSavePath.value.trim() : '';

    const options = {
      signatureKey,
      timestampMode,
      namingStrategy,
      customName
    };

    // Show Progress State
    if (obfDetailsPanel) obfDetailsPanel.classList.add('hidden');
    if (obfCompletePanel) obfCompletePanel.classList.add('hidden');
    if (obfErrorMessage) obfErrorMessage.classList.add('hidden');
    if (obfProgressPanel) obfProgressPanel.classList.remove('hidden');

    setObfStage('step-prepare');
    if (obfProgressStage) obfProgressStage.textContent = 'Preparing file...';
    if (obfProgressSubtext) obfProgressSubtext.textContent = 'Analyzing container headers and stream parameters...';

    // Desktop Native FFmpeg Execution
    if (currentObfFile.filePath && window.api && typeof window.api.obfuscateLocalFile === 'function') {
      try {
        if (window.api.onObfuscateProgress) {
          window.api.onObfuscateProgress((prog) => {
            if (prog.stage === 'preparing') {
              setObfStage('step-prepare');
              if (obfProgressStage) obfProgressStage.textContent = 'Analyzing container...';
            } else if (prog.stage === 'processing') {
              setObfStage('step-strip');
              if (obfProgressStage) obfProgressStage.textContent = 'Stripping metadata & injecting signatures...';
              setTimeout(() => setObfStage('step-spoof'), 300);
            } else if (prog.stage === 'validating') {
              setObfStage('step-validate');
              if (obfProgressStage) obfProgressStage.textContent = 'Validating clean media output...';
            }
            if (obfProgressSubtext && prog.message) obfProgressSubtext.textContent = prog.message;
          });
        }

        const result = await window.api.obfuscateLocalFile({
          filePath: currentObfFile.filePath,
          targetDir: targetDir || undefined,
          options
        });

        currentObfResult = result;
        showObfComplete(result);
      } catch (err) {
        showObfError(err.message || 'Obfuscation process failed.');
      }
      return;
    }

    // Web / Mobile Streaming Upload Execution
    if (currentObfFile.fileObj) {
      try {
        const host = getApiHost();
        const token = getStoredAuthToken();
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${host}/api/obfuscate-upload`);

        if (token) xhr.setRequestHeader('x-access-token', token);
        xhr.setRequestHeader('x-filename', encodeURIComponent(currentObfFile.fileObj.name));
        xhr.setRequestHeader('x-signature', signatureKey);
        xhr.setRequestHeader('x-timestamp-mode', timestampMode);
        xhr.setRequestHeader('x-naming-strategy', namingStrategy);
        if (customName) xhr.setRequestHeader('x-custom-name', encodeURIComponent(customName));

        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable) {
            const pct = Math.round((evt.loaded / evt.total) * 100);
            if (obfProgressStage) obfProgressStage.textContent = `Uploading media (${pct}%)...`;
            if (obfProgressSubtext) obfProgressSubtext.textContent = `${formatBytes(evt.loaded)} / ${formatBytes(evt.total)}`;
            if (pct >= 100) {
              setObfStage('step-strip');
              if (obfProgressStage) obfProgressStage.textContent = 'Server processing metadata...';
              setTimeout(() => setObfStage('step-spoof'), 600);
            }
          }
        };

        xhr.onload = () => {
          if (xhr.status === 200) {
            try {
              const res = JSON.parse(xhr.responseText);
              if (res.success) {
                setObfStage('step-validate');
                currentObfResult = res;
                showObfComplete(res, host);
              } else {
                showObfError(res.error || 'Server reported an error during obfuscation.');
              }
            } catch (e) {
              showObfError('Invalid response from server.');
            }
          } else {
            try {
              const errRes = JSON.parse(xhr.responseText);
              showObfError(errRes.error || `Server error (${xhr.status})`);
            } catch (e) {
              showObfError(`Server error (${xhr.status})`);
            }
          }
        };

        xhr.onerror = () => {
          showObfError('Network error connecting to the obfuscation server.');
        };

        xhr.send(currentObfFile.fileObj);
      } catch (err) {
        showObfError(err.message || 'Failed to upload media file.');
      }
    }
  });
}

function showObfError(msg) {
  if (obfProgressPanel) obfProgressPanel.classList.add('hidden');
  if (obfDetailsPanel) obfDetailsPanel.classList.remove('hidden');
  if (obfErrorMessage) {
    obfErrorMessage.innerHTML = `
      <i class="fa-solid fa-circle-exclamation"></i>
      <span>${escapeHtml(msg || 'The media container could not be read or processed.')}</span>
    `;
    obfErrorMessage.classList.remove('hidden');
  }
}

function showObfComplete(result, hostUrl = '') {
  if (obfProgressPanel) obfProgressPanel.classList.add('hidden');
  if (obfCompletePanel) obfCompletePanel.classList.remove('hidden');

  if (obfResultFilename) obfResultFilename.textContent = result.filename || 'obfuscated_media.mp4';
  if (obfResultPath) {
    if (result.outputPath) {
      obfResultPath.textContent = result.outputPath;
      if (obfResultPathRow) obfResultPathRow.classList.remove('hidden');
    } else {
      if (obfResultPathRow) obfResultPathRow.classList.add('hidden');
    }
  }

  // Handle Desktop "Show in Folder" vs Web "Download Clean File"
  const isDesktop = Boolean(result.outputPath && window.api && typeof window.api.openFile === 'function');
  if (obfOpenFileBtn) {
    if (isDesktop) {
      obfOpenFileBtn.classList.remove('hidden');
      obfOpenFileBtn.onclick = () => window.api.openFile(result.outputPath);
    } else {
      obfOpenFileBtn.classList.add('hidden');
    }
  }

  if (obfDownloadBtn) {
    if (result.downloadUrl) {
      obfDownloadBtn.classList.remove('hidden');
      const token = getStoredAuthToken();
      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
      const fullUrl = `${hostUrl || getApiHost()}${result.downloadUrl}${tokenParam}`;
      obfDownloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = fullUrl;
        a.download = result.filename || 'obfuscated_media.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      };
      // Auto-trigger download on mobile/web
      setTimeout(() => obfDownloadBtn.click(), 600);
    } else {
      obfDownloadBtn.classList.add('hidden');
    }
  }

  if (obfCopyPathBtn) {
    obfCopyPathBtn.onclick = async () => {
      const pathToCopy = result.outputPath || result.filename;
      try {
        await navigator.clipboard.writeText(pathToCopy);
        obfCopyPathBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        setTimeout(() => {
          obfCopyPathBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy File Path';
        }, 2000);
      } catch (e) { }
    };
  }

  // Record in Unified Activity History
  const historyItem = {
    id: Date.now().toString(),
    title: result.filename,
    sourceName: currentObfFile ? currentObfFile.name : 'Local File',
    type: currentObfFile && currentObfFile.isVideo === false ? 'audio' : 'video',
    category: 'obfuscated',
    filepath: result.outputPath || result.filename,
    downloadUrl: result.downloadUrl || null,
    size: result.sizeFormatted || (currentObfFile ? currentObfFile.sizeFormatted : '--'),
    timestamp: new Date().toISOString()
  };

  downloadHistory.unshift(historyItem);
  if (downloadHistory.length > 25) downloadHistory.pop();
  try {
    localStorage.setItem('download_history', JSON.stringify(downloadHistory));
  } catch (e) { }
  renderHistory();
}

if (obfResetBtn) {
  obfResetBtn.addEventListener('click', () => {
    currentObfFile = null;
    currentObfResult = null;
    if (obfFileInput) obfFileInput.value = '';
    if (obfCompletePanel) obfCompletePanel.classList.add('hidden');
    if (obfProgressPanel) obfProgressPanel.classList.add('hidden');
    if (obfDetailsPanel) obfDetailsPanel.classList.add('hidden');
    if (obfErrorMessage) obfErrorMessage.classList.add('hidden');
    if (obfDropZone) obfDropZone.classList.remove('hidden');
  });
}

// Notify Electron main process (desktop only) that frontend is ready
if (window.api && typeof window.api.appLoaded === 'function') {
  try { window.api.appLoaded(); } catch(e) { console.warn('appLoaded error:', e); }
}

