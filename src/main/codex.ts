import type { AIModelSettings, ChatPermission } from '../shared/ai'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { access } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

export type HarnessEvent =
  | {
      kind: 'message'
      session?: string
      id: string
      role: 'assistant' | 'tool'
      text: string
      delta: boolean
    }
  | {
      kind: 'approval'
      session?: string
      id: string | number
      command: string
      cwd: string
      reason: string
    }
  | { kind: 'approval-resolved'; session?: string; id: string | number }
  | { kind: 'started'; session?: string; turn: string }
  | { kind: 'completed'; session?: string; status: string; error?: string }

// The provider boundary intentionally stays small: the review service owns persistence and context.
export interface ReviewHarness {
  version: string
  connect(cwd?: string): Promise<void>
  start(
    cwd: string,
    session: string | null,
    instructions: string,
    background?: boolean,
    selection?: AIModelSettings,
    permission?: ChatPermission,
  ): Promise<string>
  send(session: string, text: string, schema?: unknown): Promise<string>
  cancel(session: string, turn: string): Promise<void>
  approve(id: string | number, allow: boolean): void
  close(): void
}

export class CodexHarness implements ReviewHarness {
  version = ''
  private child?: ChildProcessWithoutNullStreams
  private permission: ChatPermission = 'read-only'
  private approvals = new Map<string | number, (allow: boolean) => void>()
  private fileChanges = new Map<string, string>()
  private sequence = 0
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(
    private event: (event: HarnessEvent) => void,
    private failed: (error: Error) => void,
    private executable = 'codex',
    private args = ['app-server'],
  ) {}
  async connect(cwd?: string) {
    if (this.child) return
    let executable = this.executable,
      args = this.args
    const env = { ...process.env }
    if (executable === 'codex') {
      if (process.platform === 'win32') {
        const { stdout } = await promisify(execFile)('where.exe', ['codex'], {
          windowsHide: true,
        }).catch(() => ({ stdout: '' }))
        const candidates = stdout.trim().split(/\r?\n/)
        const native = candidates.find((path) => path.toLowerCase().endsWith('.exe'))
        if (native) executable = native
        else {
          const shim = candidates.find((path) => path.toLowerCase().endsWith('.cmd'))
          if (shim) {
            const script = join(
              dirname(shim),
              'node_modules',
              '@openai',
              'codex',
              'bin',
              'codex.js',
            )
            await access(script).catch(() => {
              throw new Error('Install the Codex CLI with npm or put codex.exe on PATH.')
            })
            executable = process.execPath
            args = [script, ...args]
            env.ELECTRON_RUN_AS_NODE = '1'
          }
        }
      } else {
        for (const path of [
          ...(process.env.PATH ?? '').split(delimiter),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          join(homedir(), '.local', 'bin'),
        ]) {
          const candidate = join(path, 'codex')
          if (
            await access(candidate).then(
              () => true,
              () => false,
            )
          ) {
            executable = candidate
            break
          }
        }
      }
    }
    const child = spawn(executable, args, { stdio: 'pipe', windowsHide: true, env, cwd })
    this.child = child
    const fail = (error: Error) => {
      if (this.child !== child) return
      this.close(error)
      this.failed(error)
    }
    child.on('error', () =>
      fail(
        new Error(
          'Codex could not start. Install the Codex CLI, run codex login, and ensure codex is on PATH.',
        ),
      ),
    )
    child.on('exit', (code) =>
      fail(
        new Error(`Codex exited (${code ?? 'signal'}). Send again to resume the saved session.`),
      ),
    )
    child.stdin.on('error', (error) => fail(error))
    // Drain stderr without exposing credentials or provider diagnostics to the renderer.
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.method) {
          const p = message.params ?? {},
            method = message.method,
            session = p.threadId
          if (message.id !== undefined) {
            if (
              [
                'item/commandExecution/requestApproval',
                'item/fileChange/requestApproval',
                'item/permissions/requestApproval',
              ].includes(method)
            ) {
              const respond = (allow: boolean) =>
                this.respond(
                  message.id,
                  method === 'item/permissions/requestApproval'
                    ? {
                        permissions: allow
                          ? Object.fromEntries(
                              Object.entries(p.permissions ?? {}).filter(
                                ([, value]) => value != null,
                              ),
                            )
                          : {},
                        scope: 'turn',
                      }
                    : { decision: allow ? 'accept' : 'decline' },
                )
              if (this.permission === 'read-only' || this.permission === 'full')
                respond(this.permission === 'full')
              else {
                this.approvals.set(message.id, respond)
                this.event({
                  kind: 'approval',
                  session,
                  id: message.id,
                  command:
                    method === 'item/fileChange/requestApproval'
                      ? (this.fileChanges.get(p.itemId) ??
                        `File changes${p.grantRoot ? ` under ${p.grantRoot}` : ''}`)
                      : method === 'item/permissions/requestApproval'
                        ? JSON.stringify(p.permissions, null, 2)
                        : String(p.command ?? JSON.stringify(p.networkApprovalContext ?? {})),
                  cwd: String(p.cwd ?? ''),
                  reason: String(p.reason ?? ''),
                })
              }
            } else if (method === 'item/tool/requestUserInput')
              this.respond(message.id, { answers: {} })
            else this.respond(message.id, { decision: 'decline', action: 'decline', content: null })
          } else if (method === 'serverRequest/resolved') {
            this.approvals.delete(p.requestId)
            this.event({ kind: 'approval-resolved', session, id: p.requestId })
          } else if (method === 'turn/started')
            this.event({ kind: 'started', session, turn: p.turn.id })
          else if (method === 'turn/completed')
            this.event({
              kind: 'completed',
              session,
              status: p.turn.status,
              error: p.turn.error?.message,
            })
          else if (
            method === 'item/agentMessage/delta' ||
            method === 'item/commandExecution/outputDelta'
          )
            this.event({
              kind: 'message',
              session,
              id: p.itemId,
              role: method.includes('agentMessage') ? 'assistant' : 'tool',
              text: String(p.delta ?? ''),
              delta: true,
            })
          else if (method === 'item/started' || method === 'item/completed') {
            const item = p.item
            if (item.type === 'fileChange')
              this.fileChanges.set(item.id, JSON.stringify(item.changes, null, 2))
            if (
              ['agentMessage', 'commandExecution', 'mcpToolCall', 'fileChange'].includes(item.type)
            )
              this.event({
                kind: 'message',
                session,
                id: item.id,
                role: item.type === 'agentMessage' ? 'assistant' : 'tool',
                text: String(
                  item.text ??
                    `${item.command ?? item.type}\n${item.aggregatedOutput ?? item.status ?? ''}`,
                ),
                delta: false,
              })
          }
        } else {
          const pending = this.pending.get(message.id)
          if (!pending) return
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          if (message.error)
            pending.reject(new Error(message.error.message ?? 'Codex request failed'))
          else pending.resolve(message.result)
        }
      } catch {
        fail(new Error('Codex returned an incompatible protocol message. Update the Codex CLI.'))
      }
    })
    const result = await this.request('initialize', {
      clientInfo: { name: 'revui', title: 'RevUI', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    })
    this.version = String(result.userAgent ?? 'Codex app-server')
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
  }
  async start(
    cwd: string,
    session: string | null,
    instructions: string,
    background = false,
    selection?: AIModelSettings,
    permission: ChatPermission = 'read-only',
  ) {
    this.permission = background ? 'read-only' : permission
    const sandbox =
      this.permission === 'full'
        ? 'danger-full-access'
        : this.permission === 'read-only'
          ? 'read-only'
          : 'workspace-write'
    const approvalPolicy = ['read-only', 'full'].includes(this.permission) ? 'never' : 'on-request'
    const approvalsReviewer = this.permission === 'auto' ? 'auto_review' : 'user'
    const result = await this.request(session ? 'thread/resume' : 'thread/start', {
      cwd,
      sandbox,
      approvalPolicy,
      ...(background ? { ephemeral: true } : {}),
      approvalsReviewer,
      developerInstructions: instructions,
      ...(selection?.model ? { model: selection.model } : {}),
      config: {
        'features.apply_patch_freeform': this.permission !== 'read-only',
        ...(selection?.effort ? { model_reasoning_effort: selection.effort } : {}),
      },
      ...(session ? { threadId: session } : {}),
    })
    if (
      result.sandbox?.type !==
        (this.permission === 'full'
          ? 'dangerFullAccess'
          : this.permission === 'read-only'
            ? 'readOnly'
            : 'workspaceWrite') ||
      result.approvalPolicy !== approvalPolicy ||
      result.approvalsReviewer !== approvalsReviewer
    ) {
      this.close()
      throw new Error(
        'Codex cannot enforce the selected permissions. Update the CLI or choose a mode allowed by your organization; no commands were started.',
      )
    }
    return String(result.thread.id)
  }
  async send(session: string, text: string, schema?: unknown) {
    const result = await this.request('turn/start', {
      threadId: session,
      input: [{ type: 'text', text }],
      ...(schema ? { outputSchema: schema } : {}),
    })
    return String(result.turn.id)
  }
  async cancel(session: string, turn: string) {
    await this.request('turn/interrupt', { threadId: session, turnId: turn })
  }
  approve(id: string | number, allow: boolean) {
    const respond = this.approvals.get(id)
    if (!respond) return
    this.approvals.delete(id)
    respond(allow)
  }
  request(method: string, params: unknown): Promise<any> {
    if (!this.child) return Promise.reject(new Error('Codex is disconnected.'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex ${method} timed out. The session can be resumed.`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  respond(id: string | number, result: unknown) {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`)
  }
  close(error = new Error('Codex disconnected.')) {
    this.approvals.clear()
    this.fileChanges.clear()
    const child = this.child
    this.child = undefined
    child?.kill()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
