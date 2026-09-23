export type GitLabUser = { id: number; name: string; avatar_url?: string | null }
export type GitLabConfig = {
  url: string
  configured: boolean
  version?: string
  caCertificate?: string
  ignoreTls?: boolean
}
export type MR = {
  iid: number
  project_id: number
  source_project_id: number
  title: string
  description: string | null
  web_url: string
  source_branch: string
  target_branch: string
  state: string
  draft: boolean
  labels: string[]
  author: GitLabUser
  reviewers: GitLabUser[]
  assignees?: GitLabUser[]
  assignee?: GitLabUser | null
  sha: string
  diff_refs: { base_sha: string; head_sha: string; start_sha: string } | null
  head_pipeline: { status: string; web_url: string } | null
}
export type PositionLine = {
  line_code: string
  type: 'old' | 'new'
  old_line?: number
  new_line?: number
}
export type Position = {
  line_range?: { start: PositionLine; end: PositionLine }
  position_type: 'text' | 'file'
  base_sha: string
  head_sha: string
  start_sha: string
  old_path: string
  new_path: string
  old_line?: number
  new_line?: number
}
export type Discussion = {
  id: string
  individual_note: boolean
  notes: {
    id: number
    body: string
    author: GitLabUser
    system: boolean
    resolvable: boolean
    resolved: boolean
    created_at?: string
    updated_at: string
    position?: Position
  }[]
}
export type Anchor = {
  path: string
  side: 'additions' | 'deletions'
  line: number
  startLine?: number
}
export type GitLabReview = {
  reviewApps?: { id: number; name: string; url: string }[]
  reviewAppsError?: string
  session: string
  mr: MR
  pinned: NonNullable<MR['diff_refs']>
  discussions: Discussion[]
  userId: number
  approvals: { approved: boolean; approved_by: { user: GitLabUser }[] } | null
  approvalError?: string
  aligned: boolean
}
export type GitLabRequest =
  | { kind: 'config' }
  | { kind: 'configure'; url: string; token: string; caCertificate?: string; ignoreTls?: boolean }
  | { kind: 'disconnect' }
  | { kind: 'lookup'; snapshot: string }
  | { kind: 'select'; snapshot: string; iid: number }
  | { kind: 'refresh'; session: string }
  | { kind: 'avatar'; session: string; user: number }
  | { kind: 'approve'; session: string; approved: boolean }
  | {
      kind: 'comment'
      session: string
      body: string
      discussion?: string
      anchor?: Anchor
    }
  | { kind: 'delete-note'; session: string; discussion: string; note: number }
  | { kind: 'edit'; session: string; discussion: string; note: number; body: string }
  | { kind: 'resolve'; session: string; discussion: string; resolved: boolean }
  | { kind: 'open-url' | 'copy-url'; session: string }
  | { kind: 'open-pipeline' | 'copy-pipeline-link'; session: string }
  | { kind: 'open-app' | 'copy-app-link'; session: string; environment: number }
export type GitLabResult = {
  posted?: boolean
  discussion?: string
  avatar?: string | null
  config?: GitLabConfig
  matches?: MR[]
  review?: GitLabReview
}
