import type { RevisionSuggestion, Comparison, ContentSearch, FileContent, ReviewAction, ReviewRecord, Snapshot } from './review'
export type Settings = {
  version: 1
  theme: 'system' | 'light' | 'dark'
  diffLayout: 'split' | 'unified'
  reviewLayout: 'continuous' | 'focused'
  wrapLines: boolean
  sidebarCollapsed: boolean
  sidebarWidth: number
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
  copyRelativePath: (path: string) => Promise<void>
  getRepositoryRefs: (repository: string) => Promise<RevisionSuggestion[]>
  searchReviewContents: (snapshot: string, query: string) => Promise<ContentSearch>
  openComparison: (repository: string, comparison: Comparison) => Promise<Snapshot>
  recentComparison: (repository: string) => Promise<Comparison | null>
  cancelComparison: () => Promise<void>
  loadReviewFile: (snapshot: string, path: string, force?: boolean) => Promise<FileContent>
  getReviewRecord: (snapshot: string) => Promise<ReviewRecord>
  updateReviewRecord: (snapshot: string, action: ReviewAction) => Promise<ReviewRecord>
  getBootstrap: () => Promise<Bootstrap>
  updatePreferences: (patch: PreferencesPatch) => Promise<Settings>
  chooseRepository: () => Promise<Repository | null>
  reopenRepository: (path: string) => Promise<Repository>
  onSettingsChanged: (listener: (settings: Settings) => void) => () => void
  onSystemThemeChanged: (listener: (theme: Bootstrap['systemTheme']) => void) => () => void
}

export const channels = {
  copyRelativePath: 'clipboard:relative-path',
  getRepositoryRefs: 'repository:refs',
  searchReviewContents: 'review:search',
  openComparison: 'review:open',
  recentComparison: 'review:recent',
  cancelComparison: 'review:cancel',
  loadReviewFile: 'review:file',
  getReviewRecord: 'review:record',
  updateReviewRecord: 'review:update',
  bootstrap: 'app:bootstrap',
  preferences: 'settings:update-preferences',
  settingsChanged: 'settings:changed',
  systemThemeChanged: 'app:system-theme-changed',
  chooseRepository: 'repository:choose',
  reopenRepository: 'repository:reopen',
} as const
