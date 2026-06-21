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
const urlForm = document.getElementById('url-form');
const videoUrlInput = document.getElementById('video-url');
const analyzeBtn = document.getElementById('analyze-btn');
const errorMessage = document.getElementById('error-message');

const detailsPanel = document.getElementById('details-panel');
const videoThumbnail = document.getElementById('video-thumbnail');
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
const savePathInput = document.getElementById('save-path');
const browseBtn = document.getElementById('browse-btn');
const downloadBtn = document.getElementById('download-btn');

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
let downloadHistory = JSON.parse(localStorage.getItem('download_history') || '[]');

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
  // Load Default Save Path
  const defaultPath = await window.api.getDefaultPath();
  savePathInput.value = defaultPath;
  
  // Render History
  renderHistory();
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
  const formats = typeVideo.checked ? videoFormats : audioFormats;
  
  formats.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    qualitySelect.appendChild(opt);
  });

  // Adjust label description
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

// Submit Search URL Form
urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = videoUrlInput.value.trim();
  if (!url) return;

  // Reset UI
  errorMessage.classList.add('hidden');
  detailsPanel.classList.add('hidden');
  completePanel.classList.add('hidden');
  progressPanel.classList.add('hidden');

  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...';

  try {
    const info = await window.api.fetchInfo(url);
    currentVideoData = info;

    // Display Data
    videoThumbnail.src = info.thumbnail || info.thumbnails?.[0]?.url || '';
    videoDuration.textContent = formatDuration(info.duration);
    videoTitle.textContent = info.title || 'Untitled Video';
    videoChannel.innerHTML = `<i class="fa-solid fa-circle-check channel-verify"></i> ${info.uploader || info.channel || 'Unknown Creator'}`;
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

  // UI Updates
  detailsPanel.classList.add('hidden');
  progressPanel.classList.remove('hidden');

  progressStatus.textContent = 'Preparing Download...';
  progressFileTitle.textContent = currentVideoData.title;
  downloadProgressFill.style.width = '0%';
  downloadProgressPercent.textContent = '0%';
  statSpeed.textContent = '-- MB/s';
  statEta.textContent = '--:--';
  statSize.textContent = '-- MB';

  window.api.startDownload({ url, formatId, type, containerFormat, outputFolder });
});

// Download Progress Listeners
window.api.onDownloadProgress((data) => {
  if (data.status) {
    progressStatus.textContent = data.status;
  }
  if (data.percent !== undefined) {
    downloadProgressFill.style.width = `${data.percent}%`;
    downloadProgressPercent.textContent = `${Math.round(data.percent)}%`;
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
      title: currentVideoData.title,
      type: typeVideo.checked ? 'video' : 'audio',
      filepath: filepath || savePathInput.value,
      timestamp: new Date().toISOString()
    };
    
    downloadHistory.unshift(historyItem);
    // Limit history to 15 items
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

    // Click to highlight/show file
    li.querySelector('.btn-open').addEventListener('click', () => {
      window.api.openFile(item.filepath);
    });

    // Delete item from history list
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
