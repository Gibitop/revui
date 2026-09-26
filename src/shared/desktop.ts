import type {
  AIProvider,
  ProviderSettings,
  AIModel,
  AITaskSettings,
  AIRequest,
  AIState,
} from './ai'
import type { GitLabRequest, GitLabResult } from './gitlab'
import type { Workspace, WorkspaceListing, ToolCommands, IDE } from './workspace'
import type {
  RevisionSuggestion,
  Comparison,
  ContentSearch,
  ContentSearchOptions,
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
  diffLayout: 'auto' | 'split' | 'unified'
  reviewLayout: 'continuous' | 'focused'
  wrapLines: boolean
  sidebarCollapsed: boolean
  sidebarWidth: number
  fileView: 'tree' | 'flat'
  aiPanelOpen: boolean
  aiPanelWidth: number
  aiProviders: ProviderSettings
  aiTasks: AITaskSettings
  aiLanguage: string
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
  aiModels: (provider?: AIProvider) => Promise<AIModel[]>
  ai: (request: AIRequest) => Promise<AIState>
  onAIChanged: (listener: (state: AIState) => void) => () => void
  gitlab: (request: GitLabRequest) => Promise<GitLabResult>
  findWorkspace: (snapshot: string) => Promise<Workspace | null>
  workspaceMatches: (snapshot: string, workspace: string | null) => Promise<boolean>
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

  openWebLink: (url: string) => Promise<void>
  copyText: (text: string) => Promise<void>
  copyRelativePath: (path: string) => Promise<void>
  getRepositoryRefs: (repository: string) => Promise<RevisionSuggestion[]>
  searchReviewContents: (
    snapshot: string,
    query: string,
    paths?: string[],
    options?: ContentSearchOptions,
  ) => Promise<ContentSearch>
  openComparison: (
    repository: string,
    comparison: Comparison,
    requestId: string,
    refresh?: boolean,
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
  ai: 'ai:request',
  aiModels: 'ai:models',
  aiChanged: 'ai:changed',
  gitlab: 'gitlab:request',
  acknowledgeRestoration: 'workspace:acknowledge',
  cancelWorkspaceScript: 'workspace:cancel-script',
  findWorkspace: 'workspace:find',
  workspaceMatches: 'workspace:matches',
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

  openWebLink: 'links:open-web',
  copyText: 'clipboard:text',
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
