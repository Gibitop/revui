export const ideChoices = {
  cursor: 'Cursor',
  vscode: 'VS Code',
  idea: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
} as const
export type IDE = keyof typeof ideChoices
export type ToolCommands = {
  script: string
}
export type Workspace = {
  id: string
  repository: string
  path: string
  snapshot: string
  kind: 'worktree' | 'in-place'
  original: string
  branch: string | null
  target: string
  stash: string | null
  initialized?: boolean
  phase: 'preparing' | 'ready' | 'restoring' | 'restored' | 'failed'
  error: string | null
}

export type WorkspaceListing = Workspace & {
  refs: { name: string; kind: 'branch' | 'tag' }[]
}
