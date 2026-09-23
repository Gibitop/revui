import type { Workspace, WorkspaceListing, ToolCommands, IDE } from './workspace'
import type {
  RevisionSuggestion,
  Comparison,
  ContentSearch,
  FileContent,
  ReviewAction,
  ReviewRecord,
  Snapshot,
} from './review'
export type Settings = {
  preferredIDE: IDE
  workspaceCommands: ToolCommands
  repositoryCommands: Record<string, ToolCommands>
  version: 1
  theme: 'system' | 'light' | 'dark'
  diffLayout: 'split' | 'unified'
  reviewLayout: 'continuous' | 'focused'
  wrapLines: boolean
  sidebarCollapsed: boolean
  sidebarWidth: number
  aiPanelOpen: boolean
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
  findWorkspace: (snapshot: string) => Promise<Workspace | null>
  initializeWorkspace: (
    snapshot: string,
    workspace: string | null,
  ) => Promise<{ workspace: string | null } | null>
  workspaceAction: (id: string, action: 'copy-path' | 'copy-revision' | 'open') => Promise<void>
  listWorkspaces: (repository?: string) => Promise<WorkspaceListing[]>
  prepareWorkspace: (snapshot: string, kind: Workspace['kind']) => Promise<Workspace | null>
  acknowledgeRestoration: (id: string) => Promise<void>
  cancelWorkspaceScript: () => Promise<void>
  restoreWorkspace: (id: string) => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  leaveWorkspace: (repository: string) => Promise<boolean>
  runWorkspaceScript: (id: string) => Promise<void>
  openWorkspaceIDE: (
    repository: string,
    workspace: string | null,
    path: string | null,
    line: number,
    ide: IDE,
  ) => Promise<void>
  onScriptOutput: (listener: (data: string) => void) => () => void

  copyRelativePath: (path: string) => Promise<void>
  getRepositoryRefs: (repository: string) => Promise<RevisionSuggestion[]>
  searchReviewContents: (snapshot: string, query: string) => Promise<ContentSearch>
  openComparison: (
    repository: string,
    comparison: Comparison,
    requestId: string,
  ) => Promise<Snapshot>
  recentComparison: (repository: string) => Promise<Comparison | null>
  cancelComparison: (requestId: string) => Promise<void>
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
  acknowledgeRestoration: 'workspace:acknowledge',
  cancelWorkspaceScript: 'workspace:cancel-script',
  findWorkspace: 'workspace:find',
  initializeWorkspace: 'workspace:initialize',
  workspaceAction: 'workspace:action',
  listWorkspaces: 'workspace:list',
  prepareWorkspace: 'workspace:prepare',
  restoreWorkspace: 'workspace:restore',
  removeWorkspace: 'workspace:remove',
  leaveWorkspace: 'workspace:leave',
  runWorkspaceScript: 'workspace:script',
  openWorkspaceIDE: 'workspace:ide',
  scriptOutput: 'workspace:output',

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
