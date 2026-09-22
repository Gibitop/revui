import { contextBridge, ipcRenderer } from 'electron'
import { channels, type DesktopAPI } from '../shared/desktop'

const desktop: DesktopAPI = {
  getBootstrap: () => ipcRenderer.invoke(channels.bootstrap),
  updatePreferences: (patch) => ipcRenderer.invoke(channels.preferences, patch),
  chooseRepository: () => ipcRenderer.invoke(channels.chooseRepository),
  reopenRepository: (path) => ipcRenderer.invoke(channels.reopenRepository, path),
  onSettingsChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value)
    ipcRenderer.on(channels.settingsChanged, handler)
    return () => { ipcRenderer.removeListener(channels.settingsChanged, handler) }
  },
  onSystemThemeChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value)
    ipcRenderer.on(channels.systemThemeChanged, handler)
    return () => { ipcRenderer.removeListener(channels.systemThemeChanged, handler) }
  },
}

contextBridge.exposeInMainWorld('desktop', desktop)
