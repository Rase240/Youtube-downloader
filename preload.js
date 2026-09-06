const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Setup & updates
  onSetupStatus: (callback) => ipcRenderer.on('setup-status', (event, data) => callback(data)),
  retrySetup: () => ipcRenderer.invoke('retry-setup'),
  appLoaded: () => ipcRenderer.invoke('app-loaded'),

  // Metadata retrieval
  fetchInfo: (url) => ipcRenderer.invoke('fetch-info', url),

  // Download lifecycle
  startDownload: (options) => ipcRenderer.send('start-download', options),
  cancelDownload: () => ipcRenderer.send('cancel-download'),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, data) => callback(data)),
  onDownloadComplete: (callback) => ipcRenderer.on('download-complete', (event, data) => callback(data)),
  onDownloadError: (callback) => ipcRenderer.on('download-error', (event, error) => callback(error)),

  // Shell, Dialog & File Export actions
  getDefaultPath: () => ipcRenderer.invoke('get-default-path'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openFolder: (path) => ipcRenderer.send('open-folder', path),
  openFile: (path) => ipcRenderer.send('open-file', path),
  saveMetadataFile: (data) => ipcRenderer.invoke('save-metadata-file', data),

  // Local Media Obfuscator APIs
  getFilePathForDroppedFile: (file) => {
    try {
      return webUtils ? webUtils.getPathForFile(file) : (file.path || '');
    } catch (e) {
      return file.path || '';
    }
  },
  selectMediaFile: () => ipcRenderer.invoke('select-media-file'),
  probeMediaFile: (filePath) => ipcRenderer.invoke('probe-media-file', filePath),
  obfuscateLocalFile: (options) => ipcRenderer.invoke('obfuscate-local-file', options),
  onObfuscateProgress: (callback) => ipcRenderer.on('obfuscate-progress', (event, data) => callback(data))
});

