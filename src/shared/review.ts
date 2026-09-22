export type Endpoint = { kind: 'commit'; ref: string } | { kind: 'index' } | { kind: 'working' }
export type Comparison = { base: Endpoint; target: Endpoint; mode: 'direct' | 'merge-base' }
export type ReviewFile = {
  path: string
  additions: number | null
  deletions: number | null
  oldPath: string
  status: string
  oldMode: string
  newMode: string
  oldOid: string
  newOid: string
}
export type Snapshot = {
  id: string
  key: string
  repository: string
  comparison: Comparison
  files: ReviewFile[]
  paths: string[]
  createdAt: string
}
export type FileContent = {
  oldFile: { name: string; contents: string; cacheKey: string } | null
  newFile: { name: string; contents: string; cacheKey: string } | null
  fingerprint: string
  summary: string | null
  large: boolean
  bytes: number
  oldLines: number
  newLines: number
}
export type LocalThread = {
  id: string
  snapshot: string
  fingerprint: string
  path: string
  side: 'deletions' | 'additions'
  start: number
  end: number
  createdAt: string
  updatedAt: string
  resolved: boolean
  messages: { id: string; body: string; createdAt: string; updatedAt: string }[]
}
export type ReviewRecord = { version: 1; threads: LocalThread[]; reviewed: Record<string, string> }
export type ReviewAction =
  | { kind: 'thread'; path: string; side: LocalThread['side']; start: number; end: number; body: string }
  | { kind: 'delete-comment'; thread: string; message: string }
  | { kind: 'reply'; thread: string; body: string }
  | { kind: 'resolve'; thread: string; resolved: boolean }
  | { kind: 'reviewed'; path: string; reviewed: boolean }

export type ContentMatch = { path: string; line: number; text: string }
export type ContentSearch = { matches: ContentMatch[]; truncated: boolean }

export type RevisionSuggestion = { value: string; kind: 'commit' | 'branch' | 'remote' | 'tag' | 'working' | 'index' }
