import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AIService, aiRequestSchema } from './ai'
import { ReviewService } from './review'
import { CodexHarness, type HarnessEvent, type ReviewHarness } from './codex'
import {
  defaultAITasks,
  type AIModelSettings,
  type AIState,
  type ChatPermission,
} from '../shared/ai'

const directories: string[] = []
const services: AIService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
class FixtureHarness implements ReviewHarness {
  version = 'fixture 0.146.0'
  requests: { method: string; params: any }[] = []
  responses: { id: string | number; result: any }[] = []
  closed = false
  policy = 'untrusted'
  constructor(
    public event: (event: HarnessEvent) => void,
    public failure: (error: Error) => void,
  ) {}
  async connect() {}
  async start(
    cwd: string,
    session: string | null,
    instructions: string,
    background = false,
    selection?: AIModelSettings,
    permission: ChatPermission = 'read-only',
  ) {
    this.requests.push({
      method: session ? 'thread/resume' : 'thread/start',
      params: { cwd, threadId: session, instructions, background, selection, permission },
    })
    return 'session-1'
  }
  async send(session: string, text: string, outputSchema?: unknown) {
    this.requests.push({ method: 'turn/start', params: { session, text, outputSchema } })
    return 'turn-1'
  }
  async cancel(session: string, turn: string) {
    this.requests.push({ method: 'turn/interrupt', params: { session, turn } })
  }
  approve(id: string | number, allow: boolean) {
    this.responses.push({ id, result: { decision: allow ? 'accept' : 'decline' } })
  }

  close() {
    this.closed = true
  }
  complete(text: string, status = 'completed') {
    this.event({
      kind: 'message',
      session: 'session-1',
      id: 'answer-' + randomUUID(),
      role: 'assistant',
      text,
      delta: false,
    })
    this.event({ kind: 'completed', session: 'session-1', status })
  }
}
const output = {
  findings: [
    {
      path: 'file.ts',
      side: 'additions',
      start: 1,
      end: 1,
      severity: 'high',
      body: 'Value causes a regression.',
      replacement: 'export const value = 3',
    },
  ],
  walkthrough: [],
}
async function fixture(
  taskSettings = structuredClone(defaultAITasks),
  language = () => '',
  mrContext = () => 'No merge request',
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revui-ai-')))
  directories.push(root)
  const repository = join(root, 'repo')
  await mkdir(repository)
  const git = (...args: string[]) =>
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ])
      .toString()
      .trim()
  git('init', '-b', 'main')
  await writeFile(join(repository, 'file.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-m', 'base')
  await writeFile(join(repository, 'file.ts'), 'export const value = 2\n')
  git('commit', '-am', 'change')
  const reviews = new ReviewService(join(root, 'data'))
  let snapshot = await reviews.open(repository, {
    base: { kind: 'commit', ref: 'HEAD~1' },
    target: { kind: 'commit', ref: 'HEAD' },
    mode: 'direct',
  })
  let harness!: FixtureHarness,
    latest!: AIState,
    stamp = 'clean'
  const create = () => {
    const service = new AIService(
      root,
      reviews,
      async () => repository,
      async () => stamp,
      (state) => {
        latest = state
      },
      (event, failure) => (harness = new FixtureHarness(event, failure)),
      () => taskSettings,
      language,
      mrContext,
    )
    services.push(service)
    return service
  }
  const service = create()
  const send = (mode: 'review' | 'chat' = 'review') =>
    service.handle({
      kind: 'send',
      snapshot: snapshot.id,
      workspace: null,
      mode,
      text: 'Explain the change',
      attachments: [],
    })
  return {
    root,
    repository,
    reviews,
    service,
    create,
    send,
    git,
    get snapshot() {
      return snapshot
    },
    set snapshot(value) {
      snapshot = value
    },
    get harness() {
      return harness
    },
    get latest() {
      return latest
    },
    set stamp(value: string) {
      stamp = value
    },
  }
}

it('runs review separately from active chat and automatically creates deduplicated AI comments', async () => {
  const f = await fixture()
  await f.send('chat')
  const chat = f.harness
  const messages = structuredClone(f.latest.record.messages)
  await f.service.handle({ kind: 'review', snapshot: f.snapshot.id })
  const review = f.harness
  expect(review.requests[0].params).toMatchObject({ background: true, threadId: null })
  expect(f.latest.running).toBe(true)
  review.event({
    kind: 'message',
    id: 'background',
    role: 'assistant',
    text: 'Reading changes',
    delta: true,
  })
  review.event({
    kind: 'approval',
    id: 99,
    command: 'git diff',
    cwd: f.repository,
    reason: 'inspect',
  })
  expect(review.responses.at(-1)?.result.decision).toBe('decline')
  review.complete(JSON.stringify(output))
  await expect.poll(() => f.latest.review.running).toBe(false)
  expect(f.latest.review.error).toBeNull()
  expect(f.latest.record.messages).toEqual(messages)
  expect(f.latest.record.session).toBe('session-1')
  expect(f.latest.running).toBe(true)
  const records = await f.reviews.records(f.snapshot.id)
  expect(records.threads).toHaveLength(1)
  expect(records.threads[0].messages[0]).toMatchObject({
    author: 'AI',
    body: expect.stringContaining('Value causes a regression.'),
  })
  await f.send()
  f.harness.complete(JSON.stringify(output))
  await expect.poll(() => f.latest.review.running).toBe(false)
  expect((await f.reviews.records(f.snapshot.id)).threads).toHaveLength(1)
  expect(f.latest.review.comments).toBe(0)
  chat.complete('Chat answer')
  await expect.poll(() => f.latest.running || f.latest.review.running).toBe(false)
  await f.service.close()
  const reopened = f.create()
  await reopened.handle({
    kind: 'send',
    snapshot: f.snapshot.id,
    workspace: null,
    mode: 'chat',
    text: 'Continue',
    attachments: [],
  })
  expect(f.harness.requests[0].method).toBe('thread/resume')
  expect((await f.reviews.records(f.snapshot.id)).threads[0].messages[0].author).toBe('AI')
})

it('denies unexpected command approvals and handles interruption and late events', async () => {
  const f = await fixture()
  await f.send('chat')
  const old = f.harness
  old.event({
    kind: 'approval',
    session: 'session-1',
    id: 91,
    command: 'npm test',
    cwd: f.repository,
    reason: 'Run checks',
  })
  expect(f.latest.approvals).toEqual([])
  expect(old.responses.at(-1)).toEqual({ id: 91, result: { decision: 'decline' } })
  await f.service.handle({ kind: 'cancel', snapshot: f.snapshot.id })
  expect(old.requests.at(-1)?.method).toBe('turn/interrupt')
  old.complete(JSON.stringify(output))
  expect(f.latest.record.findings).toHaveLength(0)
  await f.send()
  expect(f.harness.requests[0].method).toBe('thread/start')
  f.harness.complete(JSON.stringify(output))
  await expect.poll(() => f.latest.running || f.latest.review.running).toBe(false)
  expect(f.latest.record.findings).toHaveLength(1)
})

it.each([
  'not JSON',
  JSON.stringify({ ...output, findings: [{ ...output.findings[0], path: '../outside.ts' }] }),
  JSON.stringify({ ...output, findings: [{ ...output.findings[0], end: 999 }] }),
])('rejects invalid background output without chat messages or comments: %s', async (result) => {
  const f = await fixture()
  await f.send()
  f.harness.complete(result)
  await expect.poll(() => f.latest.running || f.latest.review.running).toBe(false)
  expect(f.latest.record.findings).toHaveLength(0)
  expect(f.latest.review.error).toContain('invalid or unanchored')
  expect(f.latest.record.messages).toEqual([])
  expect((await f.reviews.records(f.snapshot.id)).threads).toHaveLength(0)
})

it('keeps command-modified results stale and recovers after process failure', async () => {
  const f = await fixture()
  await f.send()
  f.stamp = 'changed'
  f.harness.complete(JSON.stringify(output))
  await expect.poll(() => f.latest.running || f.latest.review.running).toBe(false)
  expect(f.latest.review.error).toContain('workspace changed')
  expect(f.latest.record.findings).toHaveLength(0)
  await f.send()
  f.harness.failure(new Error('Codex crashed'))
  expect(f.latest.running).toBe(false)
  expect(f.latest.review.error).toBe('Codex crashed')
  await f.send('chat')
  expect(f.harness.requests[0].method).toBe('thread/start')
})

it('persists walkthrough completion and never changes the comparison file order', async () => {
  const f = await fixture()
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  f.harness.complete(
    JSON.stringify({
      sections: [
        { title: 'Behavior', rationale: 'Start at the changed export.', paths: ['file.ts'] },
      ],
    }),
  )
  await expect.poll(() => f.latest.order.running).toBe(false)
  const group = f.latest.record.walkthrough[0]
  await f.service.handle({ kind: 'walkthrough', snapshot: f.snapshot.id, id: group.id, done: true })
  await f.service.close()
  expect(
    (await f.create().handle({ kind: 'get', snapshot: f.snapshot.id })).record.walkthrough[0].done,
  ).toBe(true)
  expect(f.reviews.gitlabSnapshot(f.snapshot.id).files.map((file) => file.path)).toEqual([
    'file.ts',
  ])
})

it('rejects background findings if mutable files change during review', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'file.ts'), 'export const value = 4\n')
  f.snapshot = await f.reviews.open(f.repository, {
    base: { kind: 'commit', ref: 'HEAD' },
    target: { kind: 'working' },
    mode: 'direct',
  })
  await f.send()
  await writeFile(join(f.repository, 'new.ts'), 'new file\n')
  f.harness.complete(JSON.stringify(output))
  await expect.poll(() => f.latest.review.running).toBe(false)
  expect(f.latest.review.error).toContain('Local changes differ')
  expect((await f.reviews.records(f.snapshot.id)).threads).toHaveLength(0)
})

it('preserves corrupt records and validates IPC requests', async () => {
  const f = await fixture()
  await f.send()
  f.harness.complete(JSON.stringify(output))
  await expect.poll(() => f.latest.running || f.latest.review.running).toBe(false)
  await f.service.close()
  const file = join(f.root, 'ai', (await readdir(join(f.root, 'ai')))[0])
  await writeFile(file, '{broken')
  await expect(f.create().handle({ kind: 'get', snapshot: f.snapshot.id })).rejects.toThrow(
    'preserved',
  )
  expect(await readFile(file, 'utf8')).toBe('{broken')
  expect(
    aiRequestSchema.safeParse({
      kind: 'send',
      snapshot: f.snapshot.id,
      workspace: null,
      mode: 'review',
      text: '',
      attachments: [{ path: 'file.ts', start: -1 }],
    }).success,
  ).toBe(false)
})

it('transports JSON lines over stdio and reports process crashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-protocol-'))
  directories.push(root)
  const file = join(root, 'server.cjs')
  await writeFile(
    file,
    `const rl = require('node:readline').createInterface({input:process.stdin}); rl.on('line', line => { const m=JSON.parse(line); if(m.method==='initialize') process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture'}})+'\\n'); if(m.method==='thread/start') {process.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{itemId:'a',delta:'hello'}})+'\\n'); process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'t'}}})+'\\n');} if(m.method==='crash') process.exit(2); });`,
  )
  const events: HarnessEvent[] = []
  let failure: Error | undefined
  const harness = new CodexHarness(
    (event) => events.push(event),
    (error) => {
      failure = error
    },
    process.execPath,
    [file],
  )
  try {
    await harness.connect()
    expect(harness.version).toBe('fixture')
    expect(await harness.request('thread/start', {})).toEqual({ thread: { id: 't' } })
    expect(events[0]).toMatchObject({ kind: 'message', text: 'hello', delta: true })
    await expect(harness.request('crash', {})).rejects.toThrow('exited (2)')
    expect(failure?.message).toContain('exited (2)')
  } finally {
    harness.close()
  }
})

it('refuses providers that cannot enforce read-only execution without approvals', async () => {
  const harness = new CodexHarness(
    () => undefined,
    () => undefined,
  )
  harness.request = async () => ({
    thread: { id: 'unsafe' },
    sandbox: { type: 'dangerFullAccess' },
    approvalPolicy: 'never',
    approvalsReviewer: 'auto_review',
  })
  await expect(harness.start('/tmp', null, 'Review')).rejects.toThrow('cannot enforce')
})

it('automatically rejects command escalation and file edits in the protocol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-approval-'))
  directories.push(root)
  const file = join(root, 'server.cjs')
  await writeFile(
    file,
    `const rl=require('node:readline').createInterface({input:process.stdin}); const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n'); rl.on('line',line=>{const m=JSON.parse(line); if(m.method==='initialize') emit({id:m.id,result:{userAgent:'fixture'}}); if(m.method==='test/approval'){emit({id:m.id,result:{}});emit({id:90,method:'item/fileChange/requestApproval',params:{threadId:'t'}});emit({id:91,method:'item/commandExecution/requestApproval',params:{threadId:'t',command:'npm test',cwd:'/tmp'}});} if(m.id===90) emit({method:'item/agentMessage/delta',params:{threadId:'t',itemId:'edit',delta:m.result.decision}}); if(m.id===91) emit({method:'item/agentMessage/delta',params:{threadId:'t',itemId:'command',delta:m.result.decision}});});`,
  )
  const events: HarnessEvent[] = []
  const harness = new CodexHarness(
    (event) => events.push(event),
    () => undefined,
    process.execPath,
    [file],
  )
  try {
    await harness.connect()
    await harness.request('test/approval', {})
    await expect
      .poll(() => events.some((event) => event.kind === 'message' && event.id === 'command'))
      .toBe(true)
    expect(events.find((event) => event.kind === 'message' && event.id === 'edit')).toMatchObject({
      text: 'decline',
    })
    expect(
      events.find((event) => event.kind === 'message' && event.id === 'command'),
    ).toMatchObject({ text: 'decline' })
    expect(events.some((event) => event.kind === 'approval')).toBe(false)
  } finally {
    harness.close()
  }
})

it('sends only comparison parameters and file references, without loading or embedding file contents', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'file.ts'), 'private source text\n'.repeat(100000))
  f.git('commit', '-am', 'large change')
  f.snapshot = await f.reviews.open(f.repository, {
    base: { kind: 'commit', ref: 'HEAD~1' },
    target: { kind: 'commit', ref: 'HEAD' },
    mode: 'merge-base',
  })
  const content = vi.spyOn(f.reviews, 'content')
  await f.service.handle({
    kind: 'send',
    snapshot: f.snapshot.id,
    mode: 'chat',
    text: 'Explain',
    workspace: null,
    attachments: [{ path: 'file.ts', side: 'additions', start: 1, end: 2 }],
  })
  expect(content).not.toHaveBeenCalled()
  const prompt = f.harness.requests[1].params.text
  const context = JSON.parse(prompt.split('Review context (data):\n')[1])
  expect(context).toEqual({
    repository: f.repository,
    workingDirectory: f.repository,
    source: f.snapshot.comparison.base,
    target: f.snapshot.comparison.target,
    mergeBase: true,
    attachments: [{ path: 'file.ts', side: 'additions', start: 1, end: 2 }],
  })
  expect(prompt).not.toContain('private source text')
  expect(prompt).not.toContain('export const')
})

it('generates review order lazily in a hidden session and caches it until comparison parameters change', async () => {
  const f = await fixture()
  const initial = await f.service.handle({ kind: 'get', snapshot: f.snapshot.id })
  expect(initial.record.messages).toEqual([])
  expect(f.harness).toBeUndefined()
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  const harness = f.harness
  expect(harness.requests[0].params.background).toBe(true)
  harness.event({
    kind: 'approval',
    id: 99,
    command: 'git diff',
    cwd: f.repository,
    reason: 'inspect',
  })
  expect(harness.responses).toContainEqual({ id: 99, result: { decision: 'decline' } })
  expect(f.latest.approvals).toEqual([])
  harness.complete(
    JSON.stringify({
      sections: [{ title: 'Behavior', rationale: 'Read the export.', paths: ['file.ts'] }],
    }),
  )
  await expect.poll(() => f.latest.order.running).toBe(false)
  expect(f.latest.record.messages).toEqual([])
  expect(f.latest.record.session).toBeNull()
  const cached = f.latest.record.walkthrough
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness).toBe(harness)
  expect(f.latest.record.walkthrough).toEqual(cached)
  f.snapshot = await f.reviews.open(f.repository, f.snapshot.comparison)
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness).toBe(harness)
  f.snapshot = await f.reviews.open(f.repository, {
    base: { kind: 'commit', ref: 'HEAD' },
    target: { kind: 'commit', ref: 'HEAD~1' },
    mode: 'direct',
  })
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness).not.toBe(harness)
  expect(f.latest.record.walkthrough).toEqual([])
})

it('reuses mutable review order across reopen and regenerates after content changes', async () => {
  const f = await fixture()
  await writeFile(join(f.repository, 'file.ts'), 'working\n')
  f.snapshot = await f.reviews.open(f.repository, {
    base: { kind: 'commit', ref: 'HEAD' },
    target: { kind: 'working' },
    mode: 'direct',
  })
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  const first = f.harness
  first.complete(
    JSON.stringify({
      sections: [{ title: 'Behavior', rationale: 'Read it.', paths: ['file.ts'] }],
    }),
  )
  await expect.poll(() => f.latest.order.running).toBe(false)
  f.snapshot = await f.reviews.open(f.repository, f.snapshot.comparison)
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness).toBe(first)
  f.stamp = 'changed'
  await writeFile(join(f.repository, 'file.ts'), 'changed\n')
  f.snapshot = await f.reviews.open(f.repository, f.snapshot.comparison)
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness).not.toBe(first)
})

it.each([
  'invalid JSON',
  JSON.stringify({ sections: [] }),
  JSON.stringify({ sections: [{ title: 'Wrong', rationale: 'Wrong', paths: ['missing.ts'] }] }),
])('keeps invalid background responses out of chat: %s', async (text) => {
  const f = await fixture()
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  f.harness.complete(text)
  await expect.poll(() => f.latest.order.running).toBe(false)
  expect(f.latest.order.error).toBeTruthy()
  expect(f.latest.record.messages).toEqual([])
  expect(f.latest.record.walkthrough).toEqual([])
  expect(f.latest.record.walkthroughKey).toBeNull()
})

it('does not resume legacy sessions that previously received embedded file contents', async () => {
  const f = await fixture()
  await f.send('chat')
  await f.service.close()
  const path = join(f.root, 'ai', (await readdir(join(f.root, 'ai')))[0])
  const legacy = JSON.parse(await readFile(path, 'utf8'))
  delete legacy.parameterContext
  await writeFile(path, JSON.stringify(legacy))
  const reopened = f.create()
  const state = await reopened.handle({ kind: 'get', snapshot: f.snapshot.id })
  expect(state.record.session).toBeNull()
  expect(state.record.messages).toEqual(legacy.messages)
  await reopened.handle({
    kind: 'send',
    snapshot: f.snapshot.id,
    workspace: null,
    mode: 'chat',
    text: 'Continue',
    attachments: [],
  })
  expect(f.harness.requests[0].method).toBe('thread/start')
})

it('routes task settings to chat, review and hidden order, including settings changes', async () => {
  const settings = {
    chat: { model: 'chat-model', effort: 'low' },
    review: { model: 'review-model', effort: 'high' },
    order: { model: 'order-model', effort: 'medium' },
  }
  const f = await fixture(settings)
  await f.send('chat')
  expect(f.harness.requests[0].params.selection).toEqual(settings.chat)
  f.harness.complete('Hello')
  await expect.poll(() => f.latest.running || f.latest.review.running).toBe(false)
  await f.send('review')
  expect(f.harness.requests[0]).toMatchObject({
    method: 'thread/start',
    params: { selection: settings.review, background: true },
  })
  f.harness.complete(JSON.stringify(output))
  await expect.poll(() => f.latest.running || f.latest.review.running).toBe(false)
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness.requests[0].params).toMatchObject({
    background: true,
    selection: settings.order,
  })
  f.harness.complete(
    JSON.stringify({ sections: [{ title: 'Step', rationale: 'Reason', paths: ['file.ts'] }] }),
  )
  await expect.poll(() => f.latest.order.running).toBe(false)
  const oldHarness = f.harness
  settings.order = { model: 'other-model', effort: 'low' }
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness).not.toBe(oldHarness)
  expect(f.harness.requests[0].params.selection).toEqual(settings.order)
})

it('passes model and reasoning overrides into new and resumed Codex threads', async () => {
  const harness = new CodexHarness(
    () => {},
    () => {},
  )
  const request = vi.spyOn(harness, 'request').mockResolvedValue({
    thread: { id: 'test' },
    sandbox: { type: 'readOnly' },
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
  })
  const selection = { model: 'test-model', effort: 'high' }
  await harness.start('/repo', null, 'Review', false, selection)
  expect(request).toHaveBeenLastCalledWith(
    'thread/start',
    expect.objectContaining({
      sandbox: 'read-only',
      approvalPolicy: 'never',
      model: 'test-model',
      config: expect.objectContaining({ model_reasoning_effort: 'high' }),
    }),
  )
  await harness.start('/repo', 'test', 'Review', false, selection)
  expect(request).toHaveBeenLastCalledWith(
    'thread/resume',
    expect.objectContaining({
      sandbox: 'read-only',
      approvalPolicy: 'never',
      model: 'test-model',
      config: expect.objectContaining({ model_reasoning_effort: 'high' }),
    }),
  )
})

it('applies the preferred language to all tasks and invalidates cached order when it changes', async () => {
  let language = 'Serbian'
  const f = await fixture(structuredClone(defaultAITasks), () => language)
  for (const mode of ['chat', 'review'] as const) {
    await f.send(mode)
    expect(f.harness.requests[0].params.instructions).toContain('"Serbian"')
    f.harness.complete(mode === 'chat' ? 'Hello' : JSON.stringify(output))
    await expect.poll(() => f.latest.running || f.latest.review.running).toBe(false)
  }
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness.requests[0].params.instructions).toContain('"Serbian"')
  f.harness.complete(
    JSON.stringify({ sections: [{ title: 'Step', rationale: 'Reason', paths: ['file.ts'] }] }),
  )
  await expect.poll(() => f.latest.order.running).toBe(false)
  const prior = f.harness
  language = 'French'
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness).not.toBe(prior)
  expect(f.harness.requests[0].params.instructions).toContain('"French"')
})

it('always includes current MR metadata in system instructions for all tasks', async () => {
  let context = JSON.stringify({
    title: 'Fix exports',
    description: 'Keep API compatibility',
    discussions: [],
  })
  const f = await fixture(
    structuredClone(defaultAITasks),
    () => '',
    () => context,
  )
  await f.send('chat')
  expect(f.harness.requests[0].params.instructions).toContain(context)
  f.harness.complete('Answer')
  await expect.poll(() => f.latest.running).toBe(false)
  context = JSON.stringify({ title: 'Updated MR', description: 'New information' })
  await f.send('review')
  expect(f.harness.requests[0].params.instructions).toContain(context)
  await f.service.handle({ kind: 'cancel-review', snapshot: f.snapshot.id })
  const cancelled = f.harness
  cancelled.complete(JSON.stringify(output))
  expect((await f.reviews.records(f.snapshot.id)).threads).toHaveLength(0)
  await f.service.handle({ kind: 'order', snapshot: f.snapshot.id })
  expect(f.harness.requests[0].params.instructions).toContain(context)
})

it('keeps separate chat sessions, persists tabs, and closes chats', async () => {
  const f = await fixture()
  const snapshot = f.snapshot.id
  const first = await f.send('chat')
  const firstId = first.record.chatId
  f.harness.complete('First answer')
  await vi.waitFor(() => expect(f.latest.running).toBe(false))
  const second = await f.service.handle({ kind: 'new-chat', snapshot })
  const secondId = second.record.chatId
  expect(secondId).not.toBe(firstId)
  expect(second.record.session).toBeNull()
  expect(second.record.messages).toEqual([])
  expect(second.record.otherChats[0].messages.at(-1)?.text).toBe('First answer')
  await f.send('chat')
  expect(f.harness.requests[0].method).toBe('thread/start')
  f.harness.complete('Second answer')
  await vi.waitFor(() => expect(f.latest.running).toBe(false))
  await f.service.close()
  const reopened = f.create()
  const restored = await reopened.handle({ kind: 'get', snapshot })
  expect(restored.record.chatId).toBe(secondId)
  expect(restored.record.messages.at(-1)?.text).toBe('Second answer')
  const selected = await reopened.handle({ kind: 'select-chat', snapshot, id: firstId })
  expect(selected.record.messages.at(-1)?.text).toBe('First answer')
  await reopened.handle({
    kind: 'send',
    snapshot,
    workspace: null,
    mode: 'chat',
    text: 'Continue',
    attachments: [],
  })
  expect(f.harness.requests[0].method).toBe('thread/resume')
  await reopened.handle({ kind: 'cancel', snapshot })
  const closed = await reopened.handle({ kind: 'close-chat', snapshot, id: firstId })
  expect(closed.record.chatId).toBe(secondId)
  expect(closed.record.otherChats).toEqual([])
  expect(closed.record.messages.at(-1)?.text).toBe('Second answer')
  const empty = await reopened.handle({ kind: 'close-chat', snapshot, id: secondId })
  expect(empty.record.chatId).not.toBe(secondId)
  expect(empty.record.messages).toEqual([])
  expect(empty.record.session).toBeNull()
})

it('runs concurrent chats and routes background replies, failures, and cancellation to their own tabs', async () => {
  const f = await fixture()
  const snapshot = f.snapshot.id
  const first = (await f.send('chat')).record.chatId
  const firstHarness = f.harness
  const second = (await f.service.handle({ kind: 'new-chat', snapshot })).record.chatId
  await f.send('chat')
  const secondHarness = f.harness
  expect(firstHarness.closed).toBe(false)
  expect(f.latest.chats[first].running).toBe(true)
  expect(f.latest.chats[second].running).toBe(true)
  firstHarness.complete('First background answer')
  await vi.waitFor(() => expect(f.latest.chats[first].running).toBe(false))
  expect(f.latest.record.chatId).toBe(second)
  expect(f.latest.running).toBe(true)
  expect(f.latest.record.messages.some((m) => m.text === 'First background answer')).toBe(false)
  expect(f.latest.record.otherChats[0].messages.at(-1)?.text).toBe('First background answer')
  await f.service.handle({ kind: 'select-chat', snapshot, id: first })
  expect(f.latest.record.messages.at(-1)?.text).toBe('First background answer')
  expect(f.latest.running).toBe(false)
  secondHarness.failure(new Error('Second chat failed'))
  expect(f.latest.error).toBeNull()
  expect(f.latest.chats[second].error).toBe('Second chat failed')
  await f.send('chat')
  const resumed = f.harness
  await f.service.handle({ kind: 'select-chat', snapshot, id: second })
  expect(f.latest.error).toBe('Second chat failed')
  await f.send('chat')
  const other = f.harness
  await f.service.handle({ kind: 'cancel', snapshot, chatId: first })
  expect(resumed.closed).toBe(true)
  expect(other.closed).toBe(false)
  expect(f.latest.chats[second].running).toBe(true)
  resumed.complete('Late reply must be ignored')
  await f.service.handle({ kind: 'close-chat', snapshot, id: second })
  other.complete('Closed reply must be ignored')
  expect(f.latest.record.chatId).toBe(first)
  expect(f.latest.record.messages.some((m) => m.text.includes('must be ignored'))).toBe(false)
  await f.service.close()
  const restored = await f.create().handle({ kind: 'get', snapshot })
  expect(restored.record.messages.some((m) => m.text === 'First background answer')).toBe(true)
  expect(restored.running).toBe(false)
})

it('keeps a delayed session start bound to its chat when switching or closing tabs', async () => {
  const f = await fixture()
  const snapshot = f.snapshot.id
  const first = (await f.service.handle({ kind: 'get', snapshot })).record.chatId
  let release!: (session: string) => void
  const start = vi.spyOn(FixtureHarness.prototype, 'start').mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        release = resolve
      }),
  )
  const sending = f.service.handle({
    kind: 'send',
    snapshot,
    chatId: first,
    mode: 'chat',
    workspace: null,
    text: 'Slow start',
    attachments: [],
  })
  const rejected = expect(sending).rejects.toThrow('Turn cancelled')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await f.service.handle({ kind: 'close-chat', snapshot, id: first })
  release('closed-session')
  await rejected
  const state = await f.service.handle({ kind: 'get', snapshot })
  expect(state.record.chatId).not.toBe(first)
  expect(state.record.session).toBeNull()
  expect(state.record.messages).toEqual([])
  start.mockRestore()
})

it('edits only the latest user message, preserves attachments and history, and replaces its answer', async () => {
  const f = await fixture()
  const snapshot = f.snapshot.id
  await f.send('chat')
  f.harness.complete('Earlier answer')
  await vi.waitFor(() => expect(f.latest.running).toBe(false))
  const earlier = f.latest.record.messages[0].id
  await f.service.handle({
    kind: 'send',
    snapshot,
    mode: 'chat',
    workspace: null,
    text: 'Original question',
    attachments: [{ path: 'file.ts' }],
  })
  f.harness.complete('Original answer')
  await vi.waitFor(() => expect(f.latest.running).toBe(false))
  const message = f.latest.record.messages.filter((m) => m.role === 'user').at(-1)!
  await expect(
    f.service.handle({
      kind: 'send',
      snapshot,
      editMessage: earlier,
      mode: 'chat',
      workspace: null,
      text: 'Invalid edit',
      attachments: [],
    }),
  ).rejects.toThrow('Only your latest')
  await f.service.handle({
    kind: 'send',
    snapshot,
    editMessage: message.id,
    mode: 'chat',
    workspace: null,
    text: 'Revised question',
    attachments: [],
  })
  expect(f.harness.requests[0].method).toBe('thread/start')
  const prompt = f.harness.requests.at(-1)!.params.text
  expect(prompt).toContain('Earlier answer')
  expect(prompt).toContain('Revised question')
  expect(prompt).toContain('"path":"file.ts"')
  expect(prompt).not.toContain('Original question')
  expect(prompt).not.toContain('Original answer')
  expect(f.latest.record.messages).toHaveLength(3)
  expect(f.latest.record.messages.at(-1)).toMatchObject({
    id: message.id,
    prompt: 'Revised question',
    attachments: [{ path: 'file.ts' }],
  })
  f.harness.complete('Revised answer')
  await vi.waitFor(() => expect(f.latest.running).toBe(false))
  await f.service.close()
  const restored = await f.create().handle({ kind: 'get', snapshot })
  expect(restored.record.messages.at(-1)?.text).toBe('Revised answer')
  expect(restored.record.messages[2].prompt).toBe('Revised question')
})

it('editing a running response stops only its chat and ignores its late reply', async () => {
  const f = await fixture()
  const snapshot = f.snapshot.id
  const first = await f.send('chat')
  const old = f.harness
  const message = first.record.messages[0].id
  await f.service.handle({ kind: 'new-chat', snapshot })
  await f.send('chat')
  const other = f.harness
  await f.service.handle({
    kind: 'send',
    snapshot,
    chatId: first.record.chatId,
    editMessage: message,
    mode: 'chat',
    workspace: null,
    text: 'Edited while running',
    attachments: [],
  })
  expect(old.closed).toBe(true)
  expect(other.closed).toBe(false)
  old.complete('Discard this old reply')
  f.harness.complete('New reply')
  await vi.waitFor(() => expect(f.latest.chats[first.record.chatId].running).toBe(false))
  expect(f.latest.running).toBe(true)
  expect(f.latest.record.otherChats[0].messages.map((m) => m.text)).toEqual([
    'Edited while running',
    'New reply',
  ])
})

it('includes existing local threads in later reviews and accepts a clean review without comments', async () => {
  const f = await fixture()
  await f.send('review')
  f.harness.complete(JSON.stringify(output))
  await vi.waitFor(() => expect(f.latest.review.running).toBe(false))
  const records = await f.reviews.records(f.snapshot.id)
  expect(records.threads[0].messages[0].body).toMatch(/^\[P1\]/)
  await f.reviews.update(f.snapshot.id, {
    kind: 'reply',
    thread: records.threads[0].id,
    body: 'Already discussed; this is intentional.',
  })
  await f.reviews.update(f.snapshot.id, {
    kind: 'resolve',
    thread: records.threads[0].id,
    resolved: true,
  })
  await f.send('review')
  const instructions = f.harness.requests[0].params.instructions
  expect(instructions).toContain('Already discussed; this is intentional.')
  expect(instructions).toContain('"resolved":true')
  expect(instructions).toContain('do not repeat issues already raised')
  expect(instructions).toContain('Markdown')
  expect(instructions).toContain('```suggestion')
  expect(instructions).toContain('[P0]')
  expect(instructions).toContain('{"findings":[]}')
  f.harness.complete(JSON.stringify({ findings: [] }))
  await vi.waitFor(() => expect(f.latest.review.running).toBe(false))
  expect(f.latest.review.error).toBeNull()
  expect(f.latest.review.comments).toBe(0)
  expect((await f.reviews.records(f.snapshot.id)).threads).toHaveLength(1)
  expect(f.latest.record.messages).toEqual([])
})

it('preserves Markdown, explicit priority and GitLab suggestion blocks without duplicating suggestions', async () => {
  const f = await fixture()
  await f.send('review')
  const body = '[P2] **Fix the value**\n\n```suggestion:-0+0\nexport const value = 3\n```'
  f.harness.complete(JSON.stringify({ findings: [{ ...output.findings[0], body }] }))
  await vi.waitFor(() => expect(f.latest.review.running).toBe(false))
  expect(f.latest.review.error).toBeNull()
  expect((await f.reviews.records(f.snapshot.id)).threads[0].messages[0].body).toBe(body)
})

it.each([
  ['read-only', 'read-only', 'readOnly', 'never', 'user'],
  ['ask', 'workspace-write', 'workspaceWrite', 'on-request', 'user'],
  ['auto', 'workspace-write', 'workspaceWrite', 'on-request', 'auto_review'],
  ['full', 'danger-full-access', 'dangerFullAccess', 'never', 'user'],
] as const)(
  'enforces %s permissions on new and resumed chats',
  async (permission, sandbox, type, approvalPolicy, approvalsReviewer) => {
    const harness = new CodexHarness(
      () => {},
      () => {},
    )
    const request = vi.spyOn(harness, 'request').mockResolvedValue({
      thread: { id: 'thread' },
      sandbox: { type },
      approvalPolicy,
      approvalsReviewer,
    })
    for (const session of [null, 'thread']) {
      await harness.start('/repo', session, 'Help', false, undefined, permission)
      expect(request).toHaveBeenLastCalledWith(
        session ? 'thread/resume' : 'thread/start',
        expect.objectContaining({ sandbox, approvalPolicy, approvalsReviewer }),
      )
    }
    request.mockResolvedValue({
      thread: { id: 'review' },
      sandbox: { type: 'readOnly' },
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
    })
    await harness.start('/repo', null, 'Review', true, undefined, permission)
    expect(request).toHaveBeenLastCalledWith(
      'thread/start',
      expect.objectContaining({
        sandbox: 'read-only',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        ephemeral: true,
      }),
    )
  },
)

it('refuses automatic review when Codex returns a different reviewer', async () => {
  const harness = new CodexHarness(
    () => {},
    () => {},
  )
  vi.spyOn(harness, 'request').mockResolvedValue({
    thread: { id: 'thread' },
    sandbox: { type: 'workspaceWrite' },
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  })
  await expect(harness.start('/repo', null, 'Help', false, undefined, 'auto')).rejects.toThrow(
    'cannot enforce',
  )
})

it('persists permissions per chat and routes manual approvals to the correct running chat', async () => {
  const f = await fixture()
  const snapshot = f.snapshot.id
  const first = (await f.service.handle({ kind: 'get', snapshot })).record.chatId
  await f.service.handle({ kind: 'permission', snapshot, chatId: first, permission: 'ask' })
  await f.send('chat')
  const harness = f.harness
  expect(harness.requests[0].params.permission).toBe('ask')
  expect(harness.requests[0].params.instructions).toContain('may modify files')
  await expect(
    f.service.handle({ kind: 'permission', snapshot, chatId: first, permission: 'full' }),
  ).rejects.toThrow('Stop the response')
  const second = (await f.service.handle({ kind: 'new-chat', snapshot })).record.chatId
  expect(f.latest.record.permission).toBe('read-only')
  harness.event({
    kind: 'approval',
    id: 91,
    command: 'npm test',
    cwd: '/repo',
    reason: 'Run tests',
    session: 'session-1',
  })
  expect(f.latest.approvals).toEqual([])
  expect(f.latest.chats[first].approvals).toBe(1)
  await f.service.handle({ kind: 'select-chat', snapshot, id: first })
  const approval = f.latest.approvals[0]
  await expect(
    f.service.handle({ kind: 'approval', snapshot, chatId: second, id: approval.id, allow: true }),
  ).rejects.toThrow('no longer pending')
  await f.service.handle({
    kind: 'approval',
    snapshot,
    chatId: first,
    id: approval.id,
    allow: true,
  })
  expect(harness.responses.at(-1)).toEqual({ id: 91, result: { decision: 'accept' } })
  expect(f.latest.approvals).toEqual([])
  await f.service.handle({ kind: 'cancel', snapshot, chatId: first })
  await f.service.handle({ kind: 'permission', snapshot, chatId: second, permission: 'auto' })
  await f.service.close()
  const loaded = await f.create().handle({ kind: 'get', snapshot })
  expect(loaded.record.permission).toBe('ask')
  expect(loaded.record.otherChats[0].permission).toBe('auto')
  expect(loaded.approvals).toEqual([])
})

it('routes command, file-change and permission requests through manual approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'revui-manual-approval-'))
  directories.push(root)
  const file = join(root, 'server.cjs')
  await writeFile(
    file,
    `const rl = require('node:readline').createInterface({input: process.stdin});
const emit = m => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', line => { const m = JSON.parse(line);
if (m.method === 'initialize') emit({id:m.id,result:{userAgent:'fixture'}});
if (m.method === 'thread/start') emit({id:m.id,result:{thread:{id:'t'},sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request',approvalsReviewer:'user'}});
if (m.method === 'test/approvals') {
emit({id:m.id,result:{}});
emit({method:'item/started',params:{threadId:'t',item:{id:'edit',type:'fileChange',changes:[{path:'file.ts',diff:'replace value'}]}}});
emit({id:90,method:'item/fileChange/requestApproval',params:{threadId:'t',itemId:'edit'}});
emit({id:91,method:'item/commandExecution/requestApproval',params:{threadId:'t',command:'npm test'}});
emit({id:92,method:'item/permissions/requestApproval',params:{threadId:'t',permissions:{network:{enabled:true},fileSystem:null}}});
}
if ([90,91,92].includes(m.id) && m.result) emit({method:'item/agentMessage/delta',params:{threadId:'t',itemId:String(m.id),delta:JSON.stringify(m.result)}});
});`,
  )
  const events: HarnessEvent[] = []
  const harness = new CodexHarness(
    (event) => events.push(event),
    () => {},
    process.execPath,
    [file],
  )
  try {
    await harness.connect()
    await harness.start(root, null, 'Help', false, undefined, 'ask')
    await harness.request('test/approvals', {})
    await vi.waitFor(() =>
      expect(events.filter((event) => event.kind === 'approval')).toHaveLength(3),
    )
    expect(events.find((event) => event.kind === 'approval' && event.id === 90)).toMatchObject({
      command: expect.stringContaining('replace value'),
    })
    harness.approve(90, true)
    harness.approve(91, false)
    harness.approve(92, true)
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.kind === 'message' && ['90', '91', '92'].includes(event.id)),
      ).toHaveLength(3),
    )
    expect(events.find((event) => event.kind === 'message' && event.id === '90')).toMatchObject({
      text: '{"decision":"accept"}',
    })
    expect(events.find((event) => event.kind === 'message' && event.id === '91')).toMatchObject({
      text: '{"decision":"decline"}',
    })
    expect(events.find((event) => event.kind === 'message' && event.id === '92')).toMatchObject({
      text: '{"permissions":{"network":{"enabled":true}},"scope":"turn"}',
    })
  } finally {
    harness.close()
  }
})
