if (process.argv.includes('--version')) {
  console.log(process.env.REVUI_TEST_OPENCODE_VERSION ?? 'opencode v2.0.18')
  process.exit(0)
}
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}')
const agent = Object.keys(config.agents ?? {})[0] ?? 'revui-test'
const mcpServers = new Map()
const stored = () => {
  try {
    return JSON.parse(readFileSync(process.env.REVUI_OPENCODE_LOG + '.sessions.json', 'utf8'))
  } catch {
    return {}
  }
}
const { createServer } = require('node:http')
const streams = new Set()
const sessions = new Map(Object.entries(stored()))
const persist = () => {
  if (process.env.REVUI_OPENCODE_LOG)
    writeFileSync(
      process.env.REVUI_OPENCODE_LOG + '.sessions.json',
      JSON.stringify({ ...stored(), ...Object.fromEntries(sessions) }),
    )
}
const calls = []
let agentReads = 0
let mcpReads = 0
const models =
  process.env.REVUI_TEST_CATALOG === 'router'
    ? [
        {
          id: 'moonshotai/kimi-k3',
          providerID: 'openrouter',
          name: 'Kimi K3',
          enabled: true,
          variants: [{ id: 'high' }],
        },
        {
          id: 'anthropic/opus-5.5',
          providerID: 'openrouter',
          name: 'Opus 5.5',
          enabled: true,
          variants: [],
        },
      ]
    : [
        {
          id: 'model',
          providerID: 'fixture',
          name: 'Claude Fixture',
          enabled: true,
          variants: [{ id: 'low' }, { id: 'high' }],
        },
      ]
const emit = (type, data) => {
  for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, data })}\n\n`)
}
const server = createServer(async (req, res) => {
  if (
    req.headers.authorization !==
    `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? 'test-password'}`).toString('base64')}`
  )
    return res.writeHead(401).end()
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  let text = ''
  for await (const chunk of req) text += chunk
  const body = text ? JSON.parse(text) : undefined
  calls.push({ path, method: req.method, body, cwd: url.searchParams.get('location[directory]') })
  if (process.env.REVUI_OPENCODE_LOG)
    appendFileSync(process.env.REVUI_OPENCODE_LOG, JSON.stringify(calls.at(-1)) + '\n')
  const json = (data) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (path === '/api/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    streams.add(res)
    res.on('close', () => streams.delete(res))
    res.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`)
    return
  }
  if (path === '/test/calls') return json(calls)
  if (path === '/api/agent')
    return json({ data: ++agentReads < 4 ? [{ id: 'build' }] : [{ id: agent }] })
  if (path === '/api/model') return json({ data: models })
  if (path === '/api/model/default') return json({ data: models[0] })
  if (path === '/api/mcp')
    return json({
      data: [...mcpServers.keys()].map((name) => ({
        name,
        status: { status: ++mcpReads < 3 ? 'pending' : 'connected' },
      })),
    })
  if (path.startsWith('/api/experimental/mcp/')) {
    mcpServers.set(decodeURIComponent(path.split('/').at(-1)), body.config)
    return res.writeHead(204).end()
  }
  if (path === '/api/session') {
    const data = { id: `ses_${randomUUID()}`, ...body }
    sessions.set(data.id, data)
    persist()
    return json({ data })
  }
  const [, session, action] = path.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/) ?? []
  const data = sessions.get(session) ?? stored()[session]
  if (!data) return res.writeHead(404).end('{"message":"Session not found"}')
  if (!action) {
    if (req.method === 'PATCH') {
      Object.assign(data, body)
      sessions.set(session, data)
      persist()
      return res.writeHead(204).end()
    }
    return json({ data })
  }
  if (action === 'agent' || action === 'model') {
    Object.assign(data, body)
    sessions.set(session, data)
    persist()
    return res.writeHead(204).end()
  }
  if (action === 'prompt') {
    // A terminal event from a prior execution must not end the newly admitted turn.
    emit('session.execution.succeeded', { sessionID: session })
    emit('session.inbox.delivered', { sessionID: session, inboxID: body.id })
    if (body.text.includes('Crash stream')) {
      for (const stream of streams) stream.end()
      return json({ data: { id: body.id } })
    }
    const finish = (text) => {
      emit('session.text.delta', {
        sessionID: session,
        assistantMessageID: `msg_${randomUUID()}`,
        delta: text,
      })
      emit('session.execution.succeeded', { sessionID: session })
    }
    if (body.text.includes('Crash now')) setTimeout(() => process.exit(2), 50)
    else if (body.text.includes('Provider failure')) {
      emit('session.execution.failed', {
        sessionID: session,
        error: { message: 'OpenRouter rejected the request' },
      })
    } else if (body.text.includes('Approval') || body.text.includes('Edit now')) {
      emit('permission.asked', {
        sessionID: session,
        id: 'per_test',
        action: 'bash',
        resources: ['touch forbidden.txt'],
      })
    } else if (body.text.includes('Inspect Git now') || body.text.includes('Unsafe Git now')) {
      const mcp = [...mcpServers.values()][0]
      const response = await fetch(mcp.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...mcp.headers },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'inspect',
            arguments: {
              cwd: data.location.directory,
              command: body.text.includes('Unsafe Git now') ? 'checkout' : 'status',
              args: ['--porcelain'],
            },
          },
        }),
      })
      finish(JSON.stringify((await response.json()).result))
    } else if (!body.text.includes('Hold')) {
      emit('session.tool.input.started', { sessionID: session, id: 'tool', name: 'inspect' })
      emit('session.tool.success', {
        sessionID: session,
        id: 'tool',
        content: [{ type: 'text', text: 'fixture.txt' }],
      })
      finish(
        body.text.includes('JSON object')
          ? body.text.includes('sections')
            ? '{"sections":[{"title":"Public behavior","rationale":"Review the changed value","paths":["file.ts"]}]}'
            : process.env.REVUI_OPENCODE_FINDING
              ? '{"findings":[{"path":"file.ts","side":"additions","start":1,"end":1,"severity":"high","body":"The changed value breaks the existing contract.","replacement":null}]}'
              : '{"findings":[]}'
          : 'OpenCode streamed answer',
      )
    }
    return json({ data: { id: body.id } })
  }
  if (action === 'permission/per_test/reply') {
    emit('session.text.delta', {
      sessionID: session,
      assistantMessageID: 'msg_answer',
      delta: body.decision === 'once' ? 'Approved tool' : 'Denied tool',
    })
    emit('session.execution.succeeded', { sessionID: session })
    return res.writeHead(204).end()
  }
  if (action === 'interrupt') {
    emit('session.execution.interrupted', { sessionID: session })
    return json({ interrupted: true })
  }
  res.writeHead(404).end()
})
server.listen(0, '127.0.0.1', () =>
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })),
)
process.stdin.resume()
process.stdin.on('end', () => process.exit())
