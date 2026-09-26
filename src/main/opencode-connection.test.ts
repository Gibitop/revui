import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenCodeConnection } from './opencode-connection'
import type { HarnessEvent } from './codex'

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) cleanup()
})
async function fixture() {
  const child = spawn(process.execPath, [resolve('tests/fixtures/opencode-server.cjs')], {
    stdio: 'pipe',
    env: { ...process.env, REVUI_TEST_CATALOG: 'router' },
  })
  const events: HarnessEvent[] = [],
    failures: Error[] = []
  const harness = new OpenCodeConnection(
    child,
    'test-password',
    'revui-test',
    [{ name: 'revui_git_test', url: 'http://127.0.0.1:1234', headers: {} }],
    (event) => events.push(event),
    (error) => failures.push(error),
  )
  cleanups.push(() => {
    harness.close()
    child.kill()
  })
  const requests: { path: string; method?: string; body?: any }[] = []
  const fetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    requests.push({
      path: new URL(String(url)).pathname,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return fetch(url, init)
  })
  await harness.connect()
  const calls = async () => requests
  return { harness, events, failures, calls }
}

it('waits for agent discovery, selects nested OpenRouter model IDs and enforces session restrictions before prompting', async () => {
  const { harness, calls } = await fixture()
  const models = await harness.models('/repo')
  expect(models.map((model) => model.model)).toEqual([
    'openrouter/moonshotai/kimi-k3',
    'openrouter/anthropic/opus-5.5',
  ])
  expect(models[0].supportedReasoningEfforts.map((item) => item.reasoningEffort)).toEqual([
    'high',
    'default',
  ])
  expect(models[1].supportedReasoningEfforts).toEqual([])
  expect((await calls()).some((call) => call.path === '/api/session')).toBe(false)
  await harness.start(
    '/repo',
    null,
    'Review',
    { model: models[0].model, effort: 'high' },
    'read-only',
  )
  const requests = await calls()
  expect(requests.filter((call) => call.path === '/api/agent')).toHaveLength(4)
  expect(requests.filter((call) => call.path === '/api/mcp')).toHaveLength(3)
  const create = requests.find((call) => call.path === '/api/session')!
  expect(create.body.model).toEqual({
    providerID: 'openrouter',
    id: 'moonshotai/kimi-k3',
    variant: 'high',
  })
  expect(create.body.agent).toBe('revui-test')
  expect(create.body.permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' })
  expect(create.body.permissions).toContainEqual({
    action: 'revui_git_test_*',
    resource: '*',
    effect: 'allow',
  })
  expect(requests.some((call) => call.path.endsWith('/prompt'))).toBe(false)
})

it('streams native tools and text, correlates completion, and requests structured output', async () => {
  const { harness, events } = await fixture()
  const session = await harness.start('/repo', null, 'Review instructions', undefined, 'read-only')
  await harness.send(session, 'Review', { type: 'object' })
  await expect.poll(() => events.filter((event) => event.kind === 'completed').length).toBe(1)
  expect(events.some((event) => event.kind === 'message' && event.text === '{"findings":[]}')).toBe(
    true,
  )
  expect(
    events.some(
      (event) =>
        event.kind === 'message' && event.role === 'tool' && event.text.includes('fixture.txt'),
    ),
  ).toBe(true)
  expect(events.at(-1)).toMatchObject({ kind: 'completed', status: 'completed' })
})

it('resumes without replay, replaces permissions and model, and rejects a mismatched directory', async () => {
  const { harness, events, calls } = await fixture()
  const session = await harness.start('/repo', null, '', undefined, 'full')
  await harness.start(
    '/repo',
    session,
    '',
    { model: 'openrouter/anthropic/opus-5.5', effort: '' },
    'read-only',
  )
  const requests = await calls()
  expect(requests.find((call) => call.method === 'PATCH')!.body.permissions[0].effect).toBe('deny')
  expect(
    requests.find((call) => call.path.endsWith('/model') && call.method === 'POST')!.body.model,
  ).toEqual({ providerID: 'openrouter', id: 'anthropic/opus-5.5' })
  expect(events).toEqual([])
  await expect(harness.start('/elsewhere', session, '', undefined, 'read-only')).rejects.toThrow(
    'different working directory',
  )
})

it('denies unsolicited permissions in read-only and forwards allow/deny choices in ask mode', async () => {
  const { harness, events } = await fixture()
  const session = await harness.start('/repo', null, '', undefined, 'read-only')
  await harness.send(session, 'Approval')
  await expect
    .poll(() => events.some((event) => event.kind === 'message' && event.text === 'Denied tool'))
    .toBe(true)
  expect(events.some((event) => event.kind === 'approval')).toBe(false)
  await harness.start('/repo', session, '', undefined, 'ask')
  for (const allow of [true, false]) {
    events.length = 0
    await harness.send(session, 'Approval')
    await expect.poll(() => events.some((event) => event.kind === 'approval')).toBe(true)
    harness.approve('per_test', allow)
    await expect
      .poll(() =>
        events.some(
          (event) =>
            event.kind === 'message' && event.text === (allow ? 'Approved tool' : 'Denied tool'),
        ),
      )
      .toBe(true)
  }
})

it('cancels active turns and surfaces provider failures and event disconnections', async () => {
  const { harness, events, failures } = await fixture()
  const session = await harness.start('/repo', null, '', undefined, 'read-only')
  await harness.send(session, 'Hold')
  await harness.cancel(session)
  await expect
    .poll(() =>
      events.some((event) => event.kind === 'completed' && event.status === 'interrupted'),
    )
    .toBe(true)
  events.length = 0
  await harness.send(session, 'Provider failure')
  await expect
    .poll(() =>
      events.some(
        (event) =>
          event.kind === 'completed' &&
          event.status === 'failed' &&
          event.error === 'OpenRouter rejected the request',
      ),
    )
    .toBe(true)
  await harness.send(session, 'Crash stream')
  await expect.poll(() => failures.length).toBe(1)
  expect(failures[0].message).toContain('disconnected')
})

it('rejects unavailable models and efforts without creating or prompting a session', async () => {
  const { harness, calls } = await fixture()
  await expect(
    harness.start('/repo', null, '', { model: 'missing', effort: '' }, 'read-only'),
  ).rejects.toThrow('unavailable')
  await expect(
    harness.start(
      '/repo',
      null,
      '',
      { model: 'openrouter/anthropic/opus-5.5', effort: 'ultra' },
      'read-only',
    ),
  ).rejects.toThrow('reasoning effort')
  expect(
    (await calls()).some((call) => call.path === '/api/session' || call.path.endsWith('/prompt')),
  ).toBe(false)
})

it('fails closed when the restricted agent never appears', async () => {
  const { harness, calls } = await fixture()
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(20000)
  await expect(harness.start('/repo', null, '', undefined, 'read-only')).rejects.toThrow(
    'No prompt was sent',
  )
  expect(
    (await calls()).some((call) => call.path === '/api/session' || call.path.endsWith('/prompt')),
  ).toBe(false)
})
