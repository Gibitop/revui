import { contextBridge, ipcRenderer } from 'electron'
import { channels, type DesktopAPI } from '../shared/desktop'

const desktop: DesktopAPI = {
  aiModels: () => ipcRenderer.invoke(channels.aiModels),
  ai: (request) => ipcRenderer.invoke(channels.ai, request),
  onAIChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) =>
      listener(state)
    ipcRenderer.on(channels.aiChanged, handler)
    return () => {
      ipcRenderer.removeListener(channels.aiChanged, handler)
    }
  },
  gitlab: (request) => ipcRenderer.invoke(channels.gitlab, request),
  workspaceAction: (...args) => ipcRenderer.invoke(channels.workspaceAction, ...args),
  findWorkspace: (...args) => ipcRenderer.invoke(channels.findWorkspace, ...args),
  workspaceMatches: (...args) => ipcRenderer.invoke(channels.workspaceMatches, ...args),
  initializeWorkspace: (...args) => ipcRenderer.invoke(channels.initializeWorkspace, ...args),
  acknowledgeRestoration: (...args) => ipcRenderer.invoke(channels.acknowledgeRestoration, ...args),
  cancelWorkspaceScript: () => ipcRenderer.invoke(channels.cancelWorkspaceScript),
  listWorkspaces: (...args) => ipcRenderer.invoke(channels.listWorkspaces, ...args),
  prepareWorkspace: (...args) => ipcRenderer.invoke(channels.prepareWorkspace, ...args),
  restoreWorkspace: (...args) => ipcRenderer.invoke(channels.restoreWorkspace, ...args),
  removeWorkspace: (...args) => ipcRenderer.invoke(channels.removeWorkspace, ...args),
  leaveWorkspace: (...args) => ipcRenderer.invoke(channels.leaveWorkspace, ...args),
  runWorkspaceScript: (...args) => ipcRenderer.invoke(channels.runWorkspaceScript, ...args),
  openWorkspaceIDE: (...args) => ipcRenderer.invoke(channels.openWorkspaceIDE, ...args),
  onScriptOutput: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: string) => listener(value)
    ipcRenderer.on(channels.scriptOutput, handler)
    return () => {
      ipcRenderer.removeListener(channels.scriptOutput, handler)
    }
  },

  openWebLink: (url) => ipcRenderer.invoke(channels.openWebLink, url),
  copyText: (text) => ipcRenderer.invoke(channels.copyText, text),
  copyRelativePath: (path) => ipcRenderer.invoke(channels.copyRelativePath, path),
  getRepositoryRefs: (repository) => ipcRenderer.invoke(channels.getRepositoryRefs, repository),
  searchReviewContents: (snapshot, query, paths, options) =>
    ipcRenderer.invoke(channels.searchReviewContents, snapshot, query, paths, options),
  openComparison: (repository, comparison, requestId, refresh) =>
    ipcRenderer.invoke(channels.openComparison, repository, comparison, requestId, refresh),
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
