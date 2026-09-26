import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import type { AIModel, AIModelSettings, ChatPermission } from '../shared/ai'
import type { HarnessEvent, ReviewHarness } from './codex'
import { OpenCodeConnection } from './opencode-connection'

// OpenCode has no OS sandbox or native output-schema contract. A dedicated agent asks for every
// side-effecting tool; read-only reviews inspect Git through this constrained MCP tool.
export class OpenCodeHarness implements ReviewHarness {
  version = ''
  resume = false
  private child?: ChildProcessWithoutNullStreams
  private connection?: OpenCodeConnection
  private server?: Server
  private mcp: {
    name: string
    url: string
    headers: Record<string, string>
  }[] = []
  private cwd = ''
  private agent = `revui-${randomUUID()}`
  private gitServer = `revui_git_${randomUUID().replaceAll('-', '')}`
  constructor(
    private event: (event: HarnessEvent) => void,
    private failed: (error: Error) => void,
    private executable = 'opencode',
    private args: string[] = [],
  ) {}
  async connect(cwd = homedir()) {
    if (this.child) return
    this.cwd = cwd
    let executable = this.executable
    if (executable === 'opencode' && process.platform !== 'win32') {
      for (const path of [
        ...(process.env.PATH ?? '').split(delimiter),
        join(homedir(), '.opencode', 'bin'),
        join(homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ]) {
        const candidate = join(path, executable)
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
    const version = (
      await promisify(execFile)(executable, [...this.args, '--version'], { timeout: 10000 })
    ).stdout.trim()
    if (!/(?:^|\s)v?2\./.test(version))
      throw new Error(
        `RevUI requires OpenCode v2. Installed version: ${version || 'unknown'}. Configure a v2 binary in Settings → AI Providers.`,
      )
    const token = randomUUID()
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end()
        return
      }
      let id: unknown = null
      try {
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 65536) throw new Error('Request too large')
        }
        const message = JSON.parse(body)
        id = message.id
        if (id === undefined) {
          res.writeHead(202).end()
          return
        }
        let result: unknown
        if (message.method === 'initialize')
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'revui-git', version: '1' },
          }
        else if (message.method === 'ping') result = {}
        else if (message.method === 'tools/list')
          result = {
            tools: [
              {
                name: 'inspect',
                description:
                  'Read Git comparison data without shell execution. cwd must be an absolute repository/worktree path. Commands: diff, show, log, status, rev-parse, merge-base, ls-tree, ls-files, grep.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    cwd: { type: 'string' },
                    command: { type: 'string' },
                    args: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['cwd', 'command', 'args'],
                  additionalProperties: false,
                },
              },
            ],
          }
        else if (message.method === 'tools/call' && message.params.name === 'inspect') {
          try {
            const { cwd: directory, command, args } = message.params.arguments
            if (
              ![
                'diff',
                'show',
                'log',
                'status',
                'rev-parse',
                'merge-base',
                'ls-tree',
                'ls-files',
                'grep',
              ].includes(command) ||
              typeof directory !== 'string' ||
              !Array.isArray(args) ||
              args.length > 100 ||
              args.some(
                (arg: unknown) =>
                  typeof arg !== 'string' ||
                  arg.includes('\0') ||
                  (arg.startsWith('-') &&
                    !/^(--|--cached|--stage|--name-only|--name-status|--stat|--numstat|--raw|--binary|--no-ext-diff|--no-textconv|--porcelain(?:=v[12])?|--untracked-files=all|--verify|--short|--abbrev-ref|--show-toplevel|--all|--oneline|--format=.+|--max-count=\d+|--no-renames|-r|-z|-n|-l|-i|-F|-U\d+)$/.test(
                      arg,
                    )),
              )
            )
              throw new Error('Unsupported read-only Git arguments')
            const safe = ['diff', 'show', 'log'].includes(command)
              ? ['--no-ext-diff', '--no-textconv']
              : command === 'grep'
                ? ['--no-textconv']
                : []
            const { stdout } = await promisify(execFile)(
              'git',
              [
                '--no-pager',
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.hooksPath=/dev/null',
                command,
                ...safe,
                ...args,
              ],
              {
                cwd: directory,
                encoding: 'utf8',
                windowsHide: true,
                timeout: 30000,
                maxBuffer: 16 * 1024 * 1024,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
              },
            )
            result = { content: [{ type: 'text', text: stdout }] }
          } catch (error) {
            result = { isError: true, content: [{ type: 'text', text: (error as Error).message }] }
          }
        } else throw new Error('Unsupported MCP method')
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id, result }))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid read-only Git request' },
          }),
        )
      }
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as { port: number }
    this.mcp = [
      {
        name: this.gitServer,
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    ]
    const permissions = [
      { action: '*', resource: '*', effect: 'ask' },
      ...['read', 'glob', 'grep', 'list', `${this.gitServer}_*`].map((action) => ({
        action,
        resource: '*',
        effect: 'allow',
      })),
    ]
    const password = randomUUID()
    const child = spawn(
      executable,
      [...this.args, 'serve', '--stdio', '--port', '0', '--hostname', '127.0.0.1'],
      {
        cwd,
        stdio: 'pipe',
        windowsHide: true,
        env: {
          ...process.env,
          OPENCODE_PASSWORD: password,
          // The v2 config overlay adds our agent without copying or changing user config/auth.
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            agents: {
              [this.agent]: { description: 'RevUI review assistant', mode: 'primary', permissions },
            },
          }),
        },
      },
    )
    this.child = child
    const fail = (error: Error) => {
      if (this.child !== child) return
      this.close()
      this.failed(error)
    }
    child.on('error', () =>
      fail(
        new Error(
          'OpenCode could not start. Install OpenCode, run opencode auth login, or configure its binary path in Settings → AI Providers.',
        ),
      ),
    )
    child.on('exit', (code) =>
      fail(new Error(`OpenCode exited (${code ?? 'signal'}). Send again to resume.`)),
    )
    child.stdin.on('error', fail)
    child.stderr.resume()
    this.connection = new OpenCodeConnection(
      child,
      password,
      this.agent,
      this.mcp,
      this.event,
      fail,
    )
    try {
      await this.connection.connect()
      this.version = version
      this.resume = true
    } catch (error) {
      this.close()
      throw error
    }
  }
  async models(): Promise<AIModel[]> {
    if (!this.connection) throw new Error('OpenCode is disconnected.')
    return this.connection.models(this.cwd)
  }
  async start(
    cwd: string,
    session: string | null,
    instructions: string,
    background = false,
    selection?: AIModelSettings,
    permission: ChatPermission = 'read-only',
  ): Promise<string> {
    if (!this.connection) throw new Error('OpenCode is disconnected.')
    if (permission === 'auto' && !background)
      throw new Error(
        'OpenCode does not support automatic approval review. Choose Read only, Ask for approval, or Full access.',
      )
    return this.connection.start(
      cwd,
      session,
      instructions +
        `\nUse the inspect tool from MCP server ${this.gitServer} to inspect comparisons and pinned revisions. Shell commands and editing tools are unavailable in Read only mode.`,
      selection,
      background ? 'read-only' : permission,
    )
  }
  async send(session: string, text: string, schema?: unknown) {
    if (!this.connection) throw new Error('OpenCode is disconnected.')
    return this.connection.send(session, text, schema)
  }
  async cancel(session: string) {
    await this.connection?.cancel(session)
  }
  approve(id: string | number, allow: boolean) {
    this.connection?.approve(id, allow)
  }
  close() {
    this.connection?.close()
    this.connection = undefined
    const child = this.child
    this.child = undefined
    child?.kill()
    this.server?.close()
    this.server?.closeAllConnections()
    this.server = undefined
  }
}
