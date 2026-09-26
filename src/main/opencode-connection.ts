import {
  OpenCode,
  type OpenCodeClient,
  type OpenCodeEvent,
  type ModelInfo,
  type ModelRef,
  type PermissionRuleset,
} from '@opencode/client'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import type { AIModel, AIModelSettings, ChatPermission } from '../shared/ai'
import type { HarnessEvent } from './codex'

type Mcp = { name: string; url: string; headers: Record<string, string> }

export class OpenCodeConnection {
  private client!: OpenCodeClient
  private abort = new AbortController()
  private catalog: ModelInfo[] = []
  private sessions = new Map<
    string,
    { cwd: string; permission: ChatPermission; instructions: string }
  >()
  private turns = new Map<
    string,
    { id: string; started: boolean; cancelled: boolean; admitted: boolean }
  >()
  private approvals = new Map<string, string>()
  private registered = new Set<string>()
  private children = new Map<string, string>()
  private tools = new Map<string, string>()
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private password: string,
    private agent: string,
    private mcp: Mcp[],
    private event: (event: HarnessEvent) => void,
    private failed: (error: Error) => void,
  ) {}

  async connect() {
    const url = await new Promise<string>((resolve, reject) => {
      let url = ''
      const lines = createInterface({ input: this.child.stdout })
      const timer = setTimeout(() => done(new Error('OpenCode server startup timed out.')), 30000)
      const done = (error?: Error) => {
        clearTimeout(timer)
        this.child.off('exit', exited)
        this.child.off('error', done)
        lines.off('line', ready)
        if (error) reject(error)
        else resolve(url)
      }
      const exited = () => done(new Error('OpenCode exited before starting its local server.'))
      const ready = (line: string) => {
        try {
          const message = JSON.parse(line)
          if (!message.url) return
          const endpoint = new URL(message.url)
          if (
            endpoint.protocol !== 'http:' ||
            !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
          )
            return done(new Error('OpenCode returned a non-local server address.'))
          url = endpoint.origin
          done()
        } catch {
          /* startup log, not the readiness message */
        }
      }
      lines.on('line', ready)
      this.child.once('exit', exited)
      this.child.once('error', done)
    })
    this.client = OpenCode.make({
      baseUrl: url,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
      },
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([
            this.abort.signal,
            ...(init?.signal ? [init.signal] : []),
            ...(new URL(String(input)).pathname === '/api/event'
              ? []
              : [AbortSignal.timeout(30000)]),
          ]),
        }),
    })
    // Start the SDK stream before admitting prompts: prompt responses only acknowledge admission.
    const stream = this.client.event
      .subscribe({ signal: this.abort.signal })
      [Symbol.asyncIterator]()
    const timer = setTimeout(
      () => this.abort.abort(new Error('OpenCode event connection timed out.')),
      30000,
    )
    try {
      const first = await stream.next()
      if (first.done) throw new Error('OpenCode event stream disconnected during startup.')
      this.receive(first.value)
    } finally {
      clearTimeout(timer)
    }
    void (async () => {
      while (!this.abort.signal.aborted) {
        const next = await stream.next()
        if (next.done) {
          if (!this.abort.signal.aborted)
            throw new Error('OpenCode event stream disconnected. Send again to resume.')
          return
        }
        this.receive(next.value)
      }
    })().catch((error) => {
      if (!this.abort.signal.aborted) this.failed(error)
    })
  }

  async models(cwd: string): Promise<AIModel[]> {
    const deadline = Date.now() + 15000
    do {
      const result = await this.client.model.list({ location: { directory: cwd } })
      this.catalog = result.data.filter((model) => model.enabled)
      if (this.catalog.length)
        return this.catalog.map((model) => ({
          model: `${model.providerID}/${model.id}`,
          displayName: `${model.providerID}/${model.name}`,
          supportedReasoningEfforts: model.variants.length
            ? [...new Set([...model.variants.map((v) => v.id), 'default'])].map((id) => ({
                reasoningEffort: id,
                description: id,
              }))
            : [],
        }))
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline && !this.abort.signal.aborted)
    throw new Error('OpenCode has no available models. Check its provider configuration.')
  }

  async start(
    cwd: string,
    session: string | null,
    instructions: string,
    selection: AIModelSettings | undefined,
    permission: ChatPermission,
  ) {
    const existing = session ? await this.client.session.get({ sessionID: session }) : undefined
    if (existing && resolve(existing.location.directory) !== resolve(cwd))
      throw new Error('OpenCode session belongs to a different working directory.')
    // The stored directory is authoritative for resumed sessions, including its lexical form.
    cwd = existing?.location.directory ?? cwd
    const deadline = Date.now() + 15000
    let ready = false
    do {
      const agents = await this.client.agent.list({ location: { directory: cwd } })
      ready = agents.data.some((agent) => agent.id === this.agent)
      if (ready) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline && !this.abort.signal.aborted)
    if (!ready)
      throw new Error(
        'OpenCode did not load the RevUI review agent within 15 seconds. No prompt was sent. Check OpenCode configuration.',
      )
    // Session rules override saved user approvals, so read-only stays read-only on resume.
    const permissions: PermissionRuleset = [
      {
        action: '*',
        resource: '*',
        effect: permission === 'full' ? 'allow' : permission === 'read-only' ? 'deny' : 'ask',
      },
      ...['read', 'glob', 'grep', 'list', ...this.mcp.map((server) => `${server.name}_*`)].map(
        (action) => ({ action, resource: '*', effect: 'allow' as const }),
      ),
    ]
    let model: ModelRef | undefined
    if (selection?.model || selection?.effort) {
      await this.models(cwd)
      const selected = selection.model
        ? this.catalog.find((model) => `${model.providerID}/${model.id}` === selection.model)
        : (await this.client.model.default({ location: { directory: cwd } })).data
      if (!selected)
        throw new Error(
          'The selected OpenCode model is unavailable. Choose an available model in Settings → AI Scenarios.',
        )
      if (
        selection.effort &&
        selection.effort !== 'default' &&
        !selected.variants.some((variant) => variant.id === selection.effort)
      )
        throw new Error(
          'OpenCode does not support this model’s selected reasoning effort. Choose an available effort in Settings → AI Scenarios.',
        )
      model = {
        providerID: selected.providerID,
        id: selected.id,
        ...(selection.effort && selection.effort !== 'default'
          ? { variant: selection.effort }
          : {}),
      }
    }
    if (!this.registered.has(cwd)) {
      for (const server of this.mcp)
        await this.client.mcp.add({
          server: server.name,
          location: { directory: cwd },
          config: {
            type: 'remote',
            url: server.url,
            headers: server.headers,
            oauth: false,
            codemode: false,
          },
        })
      const deadline = Date.now() + 15000
      while (true) {
        const servers = await this.client.mcp.list({ location: { directory: cwd } })
        let connected = true
        for (const server of this.mcp) {
          const status = servers.data.find((item) => item.name === server.name)?.status
          if (status?.status === 'connected') continue
          connected = false
          if ((status && status.status !== 'pending') || Date.now() >= deadline)
            throw new Error(
              `OpenCode could not connect the review Git tool: ${(status && 'error' in status ? status.error : undefined) ?? status?.status ?? 'unavailable'}. No prompt was sent.`,
            )
        }
        if (connected) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      // v2.0 McpTool reconciles a connected server’s ToolsChanged
      // through a 100 ms debounce. Allow that registry update before the first turn.
      await new Promise((resolve) => setTimeout(resolve, 250))
      this.registered.add(cwd)
    }
    if (session) {
      await this.client.session.update({ sessionID: session, permissions })
      await this.client.session.switchAgent({ sessionID: session, agent: this.agent })
      if (model) await this.client.session.switchModel({ sessionID: session, model })
    } else {
      session = (
        await this.client.session.create({
          location: { directory: cwd },
          agent: this.agent,
          permissions,
          ...(model ? { model } : {}),
        })
      ).id
    }
    this.sessions.set(session!, { cwd, permission, instructions })
    return session!
  }

  async send(session: string, text: string, schema?: unknown) {
    const settings = this.sessions.get(session)
    if (!settings) throw new Error('OpenCode session is not ready.')
    if (this.turns.has(session)) throw new Error('OpenCode already has an active turn.')
    const id = `msg_${randomUUID().replaceAll('-', '')}`
    const turn = { id, started: false, cancelled: false, admitted: false }
    this.turns.set(session, turn)
    this.event({ kind: 'started', session, turn: id })
    try {
      await this.client.session.prompt({
        sessionID: session,
        id,
        text: `${settings.instructions}\n\n${text}${schema ? `\nReturn ONLY a JSON object matching this schema, without Markdown fences or commentary:\n${JSON.stringify(schema)}` : ''}`,
      })
      turn.admitted = true
      if (turn.cancelled) await this.cancel(session)
    } catch (error) {
      this.turns.delete(session)
      throw error
    }
    return id
  }

  private receive(event: OpenCodeEvent) {
    if (
      event.type === 'session.created' &&
      event.data.parentID &&
      (this.turns.has(event.data.parentID) || this.children.has(event.data.parentID))
    )
      this.children.set(
        event.data.sessionID,
        this.children.get(event.data.parentID) ?? event.data.parentID,
      )
    const owner =
      'sessionID' in event.data && typeof event.data.sessionID === 'string'
        ? event.data.sessionID
        : event.type === 'form.created'
          ? event.data.form.sessionID
          : undefined
    if (!owner) return
    const session = this.children.get(owner) ?? owner
    const turn = this.turns.get(session)
    if (!turn) return
    if (event.type === 'session.inbox.delivered' && event.data.inboxID === turn.id)
      turn.started = true
    if (event.type === 'session.text.delta') {
      this.event({
        kind: 'message',
        session,
        id: event.data.assistantMessageID,
        role: 'assistant',
        text: event.data.delta,
        delta: true,
      })
    } else if (event.type === 'permission.asked') {
      const data = event.data
      this.approvals.set(data.id, owner)
      const permission = this.sessions.get(session)?.permission
      if (permission !== 'ask') this.approve(data.id, permission === 'full')
      else
        this.event({
          kind: 'approval',
          session,
          id: data.id,
          command: `${data.action}\n${data.resources.join('\n')}`,
          cwd: this.sessions.get(session)!.cwd,
          reason: 'OpenCode requests permission to use this tool.',
        })
    } else if (event.type === 'permission.replied') {
      this.approvals.delete(event.data.requestID)
      this.event({ kind: 'approval-resolved', id: event.data.requestID })
    } else if (event.type === 'form.created') {
      void this.client.session.form
        .cancel({ sessionID: owner, formID: event.data.form.id })
        .catch((error) => this.failed(error))
    } else if (
      event.type === 'session.tool.input.started' ||
      event.type === 'session.tool.called' ||
      event.type === 'session.tool.progress' ||
      event.type === 'session.tool.success' ||
      event.type === 'session.tool.failed'
    ) {
      const data = event.data
      if ('name' in data) this.tools.set(data.id, data.name)
      this.event({
        kind: 'message',
        session,
        id: data.id,
        role: 'tool',
        delta: false,
        text: [
          this.tools.get(data.id),
          event.type.split('.').at(-1),
          'error' in data ? data.error.message : '',
          ...('content' in data ? (data.content ?? []) : []).flatMap((item) =>
            item.type === 'text' ? [item.text] : [],
          ),
        ]
          .filter(Boolean)
          .join('\n'),
      })
    } else if (
      owner === session &&
      turn.started &&
      (event.type === 'session.execution.succeeded' ||
        event.type === 'session.execution.failed' ||
        event.type === 'session.execution.interrupted')
    ) {
      this.turns.delete(session)
      this.tools.clear()
      this.event({
        kind: 'completed',
        session,
        status:
          event.type === 'session.execution.succeeded'
            ? 'completed'
            : event.type === 'session.execution.interrupted'
              ? 'interrupted'
              : 'failed',
        ...(event.type === 'session.execution.failed' ? { error: event.data.error.message } : {}),
      })
    }
  }

  async cancel(session: string) {
    const turn = this.turns.get(session)
    if (turn) turn.cancelled = true
    for (const [id, owner] of this.approvals) if (owner === session) this.approve(id, false)
    const result = await this.client.session.interrupt({ sessionID: session })
    if (turn?.admitted && !turn.started && !result.interrupted) {
      // Remove an admitted input which has not begun execution.
      await this.client.session.inbox
        .cancel({ sessionID: session, inboxID: turn.id })
        .catch(() => {})
      this.turns.delete(session)
      this.event({ kind: 'completed', session, status: 'interrupted' })
    }
  }

  approve(id: string | number, allow: boolean) {
    const session = this.approvals.get(String(id))
    if (!session) return
    this.approvals.delete(String(id))
    void this.client.permission
      .reply({ sessionID: session, requestID: String(id), decision: allow ? 'once' : 'reject' })
      .catch((error) => {
        if (!this.abort.signal.aborted) this.failed(error)
      })
    this.event({ kind: 'approval-resolved', id })
  }

  close() {
    this.abort.abort()
    this.sessions.clear()
    this.turns.clear()
    this.approvals.clear()
    this.tools.clear()
    this.children.clear()
    this.registered.clear()
  }
}
