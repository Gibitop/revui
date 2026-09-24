export const chatPermissions = {
  'read-only': 'Read only',
  ask: 'Ask for approval',
  auto: 'Approve for me',
  full: 'Full access',
} as const
export type ChatPermission = keyof typeof chatPermissions
import type { LocalThread } from './review'

export const aiTasks = { chat: 'Chat', review: 'Code review', order: 'Review order' } as const
export type AIModelSettings = { model: string; effort: string }
export type AITaskSettings = Record<keyof typeof aiTasks, AIModelSettings>
export const defaultAITasks: AITaskSettings = {
  chat: { model: '', effort: '' },
  review: { model: '', effort: '' },
  order: { model: '', effort: '' },
}
export type AIModel = {
  model: string
  displayName: string
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[]
}

export type AIAttachment =
  | { path: string; side?: LocalThread['side']; start?: number; end?: number }
  | { thread: string }
  | { text: string; label: string }
export type AIFinding = {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  body: string
  path: string
  side: LocalThread['side']
  start: number
  end: number
  replacement: string | null
  fingerprint: string
  state: 'pending' | 'accepted' | 'dismissed' | 'converted'
  thread?: string
}
export type AIMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  prompt?: string
  createdAt?: string
  attachments?: AIAttachment[]
}
export type AIChat = {
  permission: ChatPermission
  id: string
  created: number
  session: string | null
  messages: AIMessage[]
  generation: string
  stale: boolean
}
export type AIRecord = {
  permission: ChatPermission
  chatId: string
  chatCreated: number
  otherChats: AIChat[]
  version: 1
  generation: string
  parameterContext: boolean
  session: string | null
  messages: AIMessage[]
  findings: AIFinding[]
  walkthroughKey: string | null
  walkthrough: { id: string; title: string; rationale: string; paths: string[]; done: boolean }[]
  stale: boolean
}
export type AIState = {
  snapshot: string
  record: AIRecord
  running: boolean
  chats: Record<string, { running: boolean; error: string | null; approvals: number }>
  order: { running: boolean; error: string | null }
  review: { running: boolean; error: string | null; completed: number; comments: number }
  error: string | null
  approvals: { id: string; command: string; cwd: string; reason: string }[]
  capabilities: {
    provider: 'Codex'
    version: string
    commands: boolean
    resume: boolean
    structuredResults: boolean
  }
}
export type AIRequest =
  | { kind: 'get'; snapshot: string }
  | { kind: 'permission'; snapshot: string; chatId: string; permission: ChatPermission }
  | { kind: 'new-chat'; snapshot: string }
  | { kind: 'select-chat' | 'close-chat'; snapshot: string; id: string }
  | { kind: 'order'; snapshot: string }
  | { kind: 'review' | 'cancel-review'; snapshot: string }
  | {
      kind: 'send'
      editMessage?: string
      chatId?: string
      snapshot: string
      workspace: string | null
      mode: 'chat' | 'review'
      text: string
      attachments: AIAttachment[]
    }
  | { kind: 'cancel'; snapshot: string; chatId?: string }
  | { kind: 'approval'; snapshot: string; chatId?: string; id: string; allow: boolean }
  | {
      kind: 'finding'
      snapshot: string
      id: string
      action: 'accept' | 'dismiss' | 'convert' | 'edit'
      body?: string
    }
  | { kind: 'walkthrough'; snapshot: string; id: string; done: boolean }
