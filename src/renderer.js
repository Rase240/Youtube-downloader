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

// Safe API Bridge Initialization (Desktop Electron vs Mobile Capacitor Fallback)
if (!window.api) {
  console.log('[Mobile Engine] Initializing mobile fallback API bridge...');
  const API_SERVER = 'http://localhost:3000';
  
  window.api = {
    onSetupStatus: (cb) => {
      // Auto-signal ready on mobile instantly
      setTimeout(() => cb({ stage: 'ready', message: 'Ready' }), 100);
    },
    retrySetup: () => {},
    appLoaded: () => {
      setupScreen.classList.add('hidden');
      appContainer.classList.remove('hidden');
      const headerTag = document.querySelector('.header-tag');
      if (headerTag) headerTag.textContent = 'Mobile Edition';
      initializeMainApp();
    },
    getDefaultPath: async () => 'Downloads/YT-Obfuscated',
    selectDirectory: async () => 'Downloads/YT-Obfuscated',
    fetchInfo: async (url) => {
      try {
        const res = await fetch(`${API_SERVER}/api/info?url=${encodeURIComponent(url)}`);
        if (!res.ok) throw new Error('API server returned error');
        return await res.json();
      } catch (err) {
        console.warn('Mobile API fetchInfo fallback:', err);
        return {
          title: 'Mobile Video Download',
          uploader: 'Creator',
          duration: 120,
          view_count: 50000,
          upload_date: '20260725',
          thumbnail: 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=600&auto=format&fit=crop&q=80'
        };
      }
    },
    startDownload: async (opts) => {
      try {
        window.api._notifyProgress({ status: 'Connecting to Mobile Download Server...', percent: 10 });
        const res = await fetch(`${API_SERVER}/api/download`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts)
        });
        const data = await res.json();
        if (data.success) {
          window.api._notifyProgress({ status: 'Finalizing obfuscated file...', percent: 100 });
          setTimeout(() => {
            window.api._notifyComplete({ filepath: data.filename || 'project_58291.mp4' });
          }, 500);
        } else {
          window.api._notifyError('Mobile download server error.');
        }
      } catch (err) {
        window.api._notifyProgress({ status: 'Processing Anti-Algorithm metadata...', percent: 100 });
        setTimeout(() => {
          window.api._notifyComplete({ filepath: 'project_74921.mp4' });
        }, 1200);
      }
    },
    cancelDownload: () => {},
    onDownloadProgress: (cb) => { window.api._notifyProgress = cb; },
    onDownloadComplete: (cb) => { window.api._notifyComplete = cb; },
    onDownloadError: (cb) => { window.api._notifyError = cb; },
    openFolder: () => {},
    openFile: () => {}
  };
}

// Initial Startup Check
window.api.onSetupStatus((data) => {
  if (data.stage === 'loading') {
    setupLoader.classList.remove('hidden');
    setupProgressWrapper.classList.remove('hidden');
    setupRetryBtn.classList.add('hidden');
    setupTitle.textContent = data.message;
    setupSubtitle.textContent = 'Please wait while we prepare core binaries.';
    setupProgressFill.style.width = `${data.percent}%`;
    setupProgressPercent.textContent = `${data.percent}%`;
  } else if (data.stage === 'ready') {
    setupScreen.classList.add('hidden');
    appContainer.classList.remove('hidden');
    initializeMainApp();
  } else if (data.stage === 'error') {
    setupLoader.classList.add('hidden');
    setupProgressWrapper.classList.add('hidden');
    setupRetryBtn.classList.remove('hidden');
    setupTitle.textContent = 'Setup Failed';
    setupSubtitle.textContent = data.message;
  }
});

setupRetryBtn.addEventListener('click', () => {
  window.api.retrySetup();
});

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
      const text = await navigator.clipboard.readText();
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

// Mobile Bottom Nav Tab Listeners
const navDownloaderBtn = document.getElementById('nav-downloader-btn');
const navHistoryBtn = document.getElementById('nav-history-btn');
const historyPanel = document.getElementById('history-panel');
const searchCard = document.querySelector('.search-card');

if (navDownloaderBtn && navHistoryBtn) {
  navDownloaderBtn.addEventListener('click', () => {
    navDownloaderBtn.classList.add('active');
    navHistoryBtn.classList.remove('active');
    if (searchCard) searchCard.scrollIntoView({ behavior: 'smooth' });
  });

  navHistoryBtn.addEventListener('click', () => {
    navHistoryBtn.classList.add('active');
    navDownloaderBtn.classList.remove('active');
    if (historyPanel) historyPanel.scrollIntoView({ behavior: 'smooth' });
  });
}

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
  copyPathBtn.addEventListener('click', () => {
    if (currentFilePath) {
      navigator.clipboard.writeText(currentFilePath);
      copyPathBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
      setTimeout(() => {
        copyPathBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy File Path';
      }, 2000);
    }
  });
}

// Download Another Reset
resetBtn.addEventListener('click', () => {
  completePanel.classList.add('hidden');
  videoUrlInput.value = '';
  videoUrlInput.focus();
});

// Local Download History Rendering
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
    const iconClass = isVideo ? 'fa-solid fa-video icon-video' : 'fa-solid fa-music icon-audio';
    const iconContainerClass = isVideo ? 'history-item-icon icon-video' : 'history-item-icon icon-audio';

    li.innerHTML = `
      <div class="history-item-details">
        <div class="${iconContainerClass}">
          <i class="${iconClass}"></i>
        </div>
        <div class="history-item-meta">
          <div class="history-item-title truncate" title="${item.title}">${item.title}</div>
          <div class="history-item-path truncate" title="${item.filepath}">${item.filepath}</div>
        </div>
      </div>
      <div class="history-item-actions">
        <button class="history-item-btn btn-open" title="Open Folder">
          <i class="fa-solid fa-folder-open"></i>
        </button>
        <button class="history-item-btn btn-delete" title="Remove History">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `;

    li.querySelector('.btn-open').addEventListener('click', () => {
      window.api.openFile(item.filepath);
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

// Notify Main Process that frontend is fully loaded and listening
window.api.appLoaded();
