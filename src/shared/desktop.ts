export type Settings = {
  version: 1
  theme: 'system' | 'light' | 'dark'
  diffLayout: 'split' | 'unified'
  reviewLayout: 'continuous' | 'focused'
  aiPanelOpen: boolean
  terminalPanelOpen: boolean
  recentRepositories: string[]
}
export type PreferencesPatch = Partial<Omit<Settings, 'version' | 'recentRepositories'>>
export type Repository = { name: string; path: string; branch: string | null }
export type Bootstrap = {
  settings: Settings
  warning: string | null
  platform: string
  systemTheme: 'light' | 'dark'
  versions: { app: string; electron: string; node: string; chrome: string }
}

export type DesktopAPI = {
  getBootstrap: () => Promise<Bootstrap>
  updatePreferences: (patch: PreferencesPatch) => Promise<Settings>
  chooseRepository: () => Promise<Repository | null>
  reopenRepository: (path: string) => Promise<Repository>
  onSettingsChanged: (listener: (settings: Settings) => void) => () => void
  onSystemThemeChanged: (listener: (theme: Bootstrap['systemTheme']) => void) => () => void
}

export const channels = {
  bootstrap: 'app:bootstrap',
  preferences: 'settings:update-preferences',
  settingsChanged: 'settings:changed',
  systemThemeChanged: 'app:system-theme-changed',
  chooseRepository: 'repository:choose',
  reopenRepository: 'repository:reopen',
} as const
