import { contextBridge, ipcRenderer } from 'electron'
import { channels, type DesktopAPI } from '../shared/desktop'

const desktop: DesktopAPI = {
  copyRelativePath: (path) => ipcRenderer.invoke(channels.copyRelativePath, path),
  getRepositoryRefs: (repository) => ipcRenderer.invoke(channels.getRepositoryRefs, repository),
  searchReviewContents: (snapshot, query) =>
    ipcRenderer.invoke(channels.searchReviewContents, snapshot, query),
  openComparison: (repository, comparison, requestId) =>
    ipcRenderer.invoke(channels.openComparison, repository, comparison, requestId),
  recentComparison: (repository) => ipcRenderer.invoke(channels.recentComparison, repository),
  cancelComparison: (requestId) => ipcRenderer.invoke(channels.cancelComparison, requestId),
  loadReviewFile: (snapshot, path, force = false) =>
    ipcRenderer.invoke(channels.loadReviewFile, snapshot, path, force),
  getReviewRecord: (snapshot) => ipcRenderer.invoke(channels.getReviewRecord, snapshot),
  updateReviewRecord: (snapshot, action) =>
    ipcRenderer.invoke(channels.updateReviewRecord, snapshot, action),
  getBootstrap: () => ipcRenderer.invoke(channels.bootstrap),
  updatePreferences: (patch) => ipcRenderer.invoke(channels.preferences, patch),
  chooseRepository: () => ipcRenderer.invoke(channels.chooseRepository),
  reopenRepository: (path) => ipcRenderer.invoke(channels.reopenRepository, path),
  onSettingsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) =>
      listener(value)
    ipcRenderer.on(channels.settingsChanged, handler)
    return () => {
      ipcRenderer.removeListener(channels.settingsChanged, handler)
    }
  },
  onSystemThemeChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) =>
      listener(value)
    ipcRenderer.on(channels.systemThemeChanged, handler)
    return () => {
      ipcRenderer.removeListener(channels.systemThemeChanged, handler)
    }
  },
}

contextBridge.exposeInMainWorld('desktop', desktop)
