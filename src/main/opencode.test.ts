import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { OpenCodeHarness } from './opencode'
import type { HarnessEvent } from './codex'

const harnesses: OpenCodeHarness[] = []
const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const harness of harnesses.splice(0)) harness.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'revui-opencode-'))
  directories.push(cwd)
  execFileSync('git', ['init', '-q', cwd])
  const events: HarnessEvent[] = [],
    failures: Error[] = []
  const harness = new OpenCodeHarness(
    (event) => events.push(event),
    (error) => failures.push(error),
    process.execPath,
    [resolve('tests/fixtures/opencode-server.cjs')],
  )
  harnesses.push(harness)
  await harness.connect(cwd)
  return { cwd, events, failures, harness }
}
it('starts the v2 server, discovers models, streams tools/text and resumes without replay', async () => {
  const { harness, cwd, events } = await fixture()
  expect(harness.version).toBe('opencode v2.0.18')
  expect(await harness.models()).toEqual([
    {
      model: 'fixture/model',
      displayName: 'fixture/Claude Fixture',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'low' },
        { reasoningEffort: 'high', description: 'high' },
        { reasoningEffort: 'default', description: 'default' },
      ],
    },
  ])
  const session = await harness.start(cwd, null, 'Review safely', false, {
    model: 'fixture/model',
    effort: 'high',
  })
  await harness.send(session, 'Explain')
  await expect.poll(() => events.some((e) => e.kind === 'completed')).toBe(true)
  expect(events.some((e) => e.kind === 'message' && e.role === 'tool')).toBe(true)
  expect(events.some((e) => e.kind === 'message' && e.text === 'OpenCode streamed answer')).toBe(
    true,
  )
  await harness.start(cwd, session, 'Resume')
  expect(JSON.stringify(events)).not.toContain('Replayed content')
})
it('denies edits in read only and supports explicit approval and denial', async () => {
  const { harness, cwd, events } = await fixture()
  const session = await harness.start(cwd, null, '')
  await harness.send(session, 'Edit now')
  await expect
    .poll(() => events.some((e) => e.kind === 'message' && e.text === 'Denied tool'))
    .toBe(true)
  expect(events.some((e) => e.kind === 'approval')).toBe(false)
  await harness.start(cwd, session, '', false, undefined, 'ask')
  for (const allow of [true, false]) {
    events.length = 0
    await harness.send(session, 'Approval now')
    await expect.poll(() => events.some((e) => e.kind === 'approval')).toBe(true)
    harness.approve('per_test', allow)
    await expect
      .poll(() =>
        events.some(
          (e) => e.kind === 'message' && e.text === (allow ? 'Approved tool' : 'Denied tool'),
        ),
      )
      .toBe(true)
  }
  await expect(harness.start(cwd, session, '', false, undefined, 'auto')).rejects.toThrow(
    'automatic approval',
  )
})
it('reads Git through MCP and rejects mutating Git commands', async () => {
  const { harness, cwd, events } = await fixture()
  await writeFile(join(cwd, 'file.txt'), 'change')
  const session = await harness.start(cwd, null, '')
  await harness.send(session, 'Inspect Git now')
  await expect
    .poll(() => events.some((e) => e.kind === 'message' && e.text.includes('file.txt')))
    .toBe(true)
  events.length = 0
  await harness.send(session, 'Unsafe Git now')
  await expect
    .poll(() =>
      events.some((e) => e.kind === 'message' && e.text.includes('Unsupported read-only Git')),
    )
    .toBe(true)
})
it('cancels a pending prompt and reports crashes for recovery', async () => {
  const { harness, cwd, events, failures } = await fixture()
  const session = await harness.start(cwd, null, '')
  await harness.send(session, 'Hold now')
  await harness.cancel(session)
  await expect
    .poll(() => events.some((e) => e.kind === 'completed' && e.status === 'interrupted'))
    .toBe(true)
  await harness.send(session, 'Crash now')
  await expect.poll(() => failures.length).toBe(1)
  expect(failures[0].message).toContain('exited')
})
it('requests JSON for structured background results', async () => {
  const { harness, cwd, events } = await fixture()
  const session = await harness.start(cwd, null, '', true)
  await harness.send(session, 'Review', {
    type: 'object',
    properties: { findings: { type: 'array' } },
  })
  await expect
    .poll(() => events.some((e) => e.kind === 'message' && e.text === '{"findings":[]}'))
    .toBe(true)
})
it.runIf(process.env.REVUI_LIVE_OPENCODE === '1')(
  'negotiates the installed OpenCode and selects the restricted review agent',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'revui-opencode-live-'))
    directories.push(cwd)
    execFileSync('git', ['init', '-q', cwd])
    const harness = new OpenCodeHarness(
      () => {},
      () => {},
    )
    harnesses.push(harness)
    await harness.connect(cwd)
    expect(harness.version).toBeTruthy()
    const models = await harness.models()
    expect(models).not.toHaveLength(0)
    if (process.env.REVUI_LIVE_OPENROUTER === '1') {
      for (const name of [/kimi.*k3/i, /opus.*5[.-]5/i, /gpt.*6.*astra/i, /deepseek.*v4.*flash/i]) {
        const model = models.find(
          (model) => model.model.startsWith('openrouter/') && name.test(model.model),
        )
        expect(model, String(name)).toBeDefined()
        expect(
          await harness.start(cwd, null, 'Read-only review', true, {
            model: model!.model,
            effort: '',
          }),
        ).toBeTruthy()
      }
    }
    const session = await harness.start(cwd, null, 'Read-only review')
    expect(session).toBeTruthy()
    const client = (harness as any).connection.client
    const denied = await client.permission.create({
      sessionID: session,
      action: 'bash',
      resources: ['touch forbidden.txt'],
    })
    expect(denied.effect).toBe('deny')
    harness.close()
    const resumed = new OpenCodeHarness(
      () => {},
      () => {},
    )
    harnesses.push(resumed)
    await resumed.connect(cwd)
    expect(await resumed.start(cwd, session, 'Resume read-only review')).toBe(session)
  },
  60000,
)

it.runIf(process.env.REVUI_LIVE_OPENCODE_TURN === '1')(
  'uses the installed model to inspect Git without source writes',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'revui-opencode-turn-'))
    directories.push(cwd)
    execFileSync('git', ['init', '-q', cwd])
    await writeFile(join(cwd, 'fixture.txt'), 'read-only fixture')
    const events: HarnessEvent[] = [],
      failures: Error[] = []
    const harness = new OpenCodeHarness(
      (event) => events.push(event),
      (error) => failures.push(error),
    )
    harnesses.push(harness)
    await harness.connect(cwd)
    const selected =
      process.env.REVUI_LIVE_OPENROUTER === '1'
        ? (await harness.models()).find(
            (model) =>
              model.model.startsWith('openrouter/') && /deepseek.*v4.*flash/i.test(model.model),
          )
        : undefined
    if (process.env.REVUI_LIVE_OPENROUTER === '1') expect(selected).toBeDefined()
    const session = await harness.start(
      cwd,
      null,
      'You are a read-only reviewer.',
      false,
      selected ? { model: selected.model, effort: '' } : undefined,
    )
    await harness.send(
      session,
      `Use the revui_git inspect tool to run git status --porcelain in ${cwd}. Reply with the untracked filename only. Do not use any other tools.`,
    )
    await expect
      .poll(() => events.some((event) => event.kind === 'completed') || failures.length > 0, {
        timeout: 55000,
      })
      .toBe(true)
    expect(failures).toEqual([])
    expect(
      events
        .flatMap((event) =>
          event.kind === 'message' && event.role === 'assistant' ? [event.text] : [],
        )
        .join(''),
    ).toContain('fixture.txt')
    expect(events.some((event) => event.kind === 'message' && event.role === 'tool')).toBe(true)
    expect(await readFile(join(cwd, 'fixture.txt'), 'utf8')).toBe('read-only fixture')
  },
  60000,
)

it('rejects OpenCode v1 before starting a server', async () => {
  vi.stubEnv('REVUI_TEST_OPENCODE_VERSION', '1.2.3')
  await expect(fixture()).rejects.toThrow('RevUI requires OpenCode v2')
})

it('keeps background review read-only even when full access is requested', async () => {
  const { harness, cwd } = await fixture()
  const session = await harness.start(cwd, null, 'Review', true, undefined, 'full')
  const info = await (harness as any).connection.client.session.get({ sessionID: session })
  expect(info.permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' })
})
