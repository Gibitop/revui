import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  CancellationTokenSource,
} from 'vscode-jsonrpc/node'
import type { IntelligenceRequest, IntelligenceResult, CodeLocation } from '../shared/intelligence'
import type { ReviewService } from './review'
import { workspaceGit, workspaceMatches, type WorkspaceService } from './workspace'

const require = createRequire(import.meta.url)
type Position = { line: number; character: number }
type Location = { uri: string; range: { start: Position; end: Position } }
type LocationLink = { targetUri: string; targetSelectionRange: { start: Position; end: Position } }
type HoverContent = string | { value: string; language?: string }

// One read-only server per active review; no speculative documents or source writes.
export class IntelligenceService {
  private generation = 0
  private session?: {
    key: string
    child: ReturnType<typeof spawn>
    connection: ReturnType<typeof createMessageConnection>
    ready: Promise<unknown>
    documents: Map<string, string>
  }
  constructor(
    private reviews: ReviewService,
    private workspaces: WorkspaceService,
  ) {}

  close() {
    this.generation++
    const session = this.session
    this.session = undefined
    if (!session) return
    // Let the LSP server stop its tsserver child before terminating the transport.
    const timeout = setTimeout(() => {
      session.connection.dispose()
      session.child.kill('SIGINT')
    }, 1000)
    timeout.unref()
    session.child.once('exit', () => {
      clearTimeout(timeout)
      session.connection.dispose()
    })
    void session.connection
      .sendRequest('shutdown')
      .then(
        () => session.connection.sendNotification('exit'),
        () => session.child.kill('SIGINT'),
      )
      .catch(() => session.child.kill('SIGINT'))
  }

  async query(request: IntelligenceRequest): Promise<IntelligenceResult> {
    const generation = this.generation
    await this.reviews.assertCurrent(request.snapshot)
    const snapshot = await this.reviews.workspaceSnapshot(request.snapshot)
    const workspace = request.workspace ? this.workspaces.get(request.workspace) : null
    if (workspace && workspace.repository !== snapshot.repository)
      throw new Error('Workspace belongs to a different repository.')
    if (workspace && workspace.phase !== 'ready')
      return { hover: '', locations: [], unavailable: true }
    const root = await realpath(workspace?.path ?? snapshot.repository)
    if (!(await workspaceMatches(snapshot, workspace?.path ?? snapshot.repository)))
      return { hover: '', locations: [], unavailable: true }
    if (snapshot.comparison.target.kind !== 'working') {
      const stagedCheckout = snapshot.comparison.target.kind === 'index' && !workspace
      const dirty = await workspaceGit(
        root,
        stagedCheckout
          ? ['diff-files', '--name-only']
          : ['status', '--porcelain', '--untracked-files=all'],
      )
      const untracked = stagedCheckout
        ? await workspaceGit(root, ['ls-files', '--others', '--exclude-standard'])
        : ''
      if (dirty || untracked)
        throw new Error(
          'The workspace has local changes. Use a clean workspace matching this review.',
        )
    }
    if (!snapshot.paths.includes(request.path)) throw new Error('File is not in the target review.')
    if (!/\.[cm]?[jt]sx?$/.test(request.path)) return { hover: '', locations: [] }
    const file = await realpath(resolve(root, request.path))
    const local = relative(root, file)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error('File resolves outside the review workspace.')
    const content = await this.reviews.content(snapshot.id, request.path, true)
    const text = content.newFile?.contents
    if (text === undefined || content.summary) return { hover: '', locations: [] }
    if ((await readFile(file, 'utf8')) !== text)
      throw new Error('File changed. Refresh or initialize a workspace matching this review.')
    const lines = text.split('\n')
    if (
      request.line >= lines.length ||
      request.character > lines[request.line].replace(/\r$/, '').length
    )
      throw new Error('Position is outside the file.')

    const key = `${snapshot.id}:${root}`
    if (generation !== this.generation && this.session?.key !== key)
      throw new Error('Review changed. Try again.')
    if (this.session?.key !== key) {
      this.close()
      const child = spawn(
        process.execPath,
        [require.resolve('typescript-language-server/lib/cli.mjs'), '--stdio'],
        {
          cwd: root,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      const connection = createMessageConnection(
        new StreamMessageReader(child.stdout!),
        new StreamMessageWriter(child.stdin!),
      )
      child.stderr!.resume()
      child.on('error', () => {
        if (this.session?.child === child) this.close()
      })
      child.on('exit', () => {
        if (this.session?.child === child) this.close()
      })
      connection.onRequest('workspace/configuration', (params: { items: unknown[] }) =>
        params.items.map(() => ({})),
      )
      connection.onRequest('client/registerCapability', () => null)
      connection.listen()
      const session = {
        key,
        child,
        connection,
        documents: new Map<string, string>(),
        ready: Promise.resolve<unknown>(null),
      }
      this.session = session
      session.ready = this.request(connection, 'initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: { textDocument: { hover: { contentFormat: ['markdown'] } } },
        initializationOptions: {
          hostInfo: 'RevUI',
          disableAutomaticTypingAcquisition: true,
          tsserver: {
            useSyntaxServer: 'never',
            fallbackPath: require.resolve('typescript-fallback/lib/tsserver.js'),
          },
          preferences: { includePackageJsonAutoImports: 'off' },
        },
      }).then(() => connection.sendNotification('initialized', {}))
      // Prevent an unhandled rejection if the review closes during initialization.
      void session.ready.catch(() => {
        if (this.session === session) this.close()
      })
    }
    const session = this.session!
    await session.ready
    if (this.session !== session) throw new Error('Review changed.')
    const uri = pathToFileURL(file).href
    if (!session.documents.has(uri)) {
      await session.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: /tsx$/.test(file)
            ? 'typescriptreact'
            : /jsx$/.test(file)
              ? 'javascriptreact'
              : /\.[cm]?ts$/.test(file)
                ? 'typescript'
                : 'javascript',
          version: 1,
          text,
        },
      })
      session.documents.set(uri, text)
    }
    let result = await this.request(session.connection, `textDocument/${request.kind}`, {
      textDocument: { uri },
      position: { line: request.line, character: request.character },
      ...(request.kind === 'references' ? { context: { includeDeclaration: true } } : {}),
    })
    // Clicking a declaration itself reveals its usages, like an IDE.
    if (request.kind === 'definition') {
      const definitions = (Array.isArray(result) ? result : result ? [result] : []) as (
        Location | LocationLink
      )[]
      if (
        definitions.some((item) => {
          const target = 'targetUri' in item ? item.targetUri : item.uri
          const range = 'targetUri' in item ? item.targetSelectionRange : item.range
          return (
            target === uri &&
            range.start.line === request.line &&
            range.end.line === request.line &&
            range.start.character <= request.character &&
            range.end.character >= request.character
          )
        })
      ) {
        result = await this.request(session.connection, 'textDocument/references', {
          textDocument: { uri },
          position: { line: request.line, character: request.character },
          context: { includeDeclaration: false },
        })
      }
    }
    if (this.session !== session) throw new Error('Review changed.')
    await this.reviews.assertCurrent(request.snapshot)
    if ((await readFile(file, 'utf8')) !== text)
      throw new Error('File changed. Refresh this comparison.')
    if (request.kind === 'hover') {
      const contents = (result as { contents?: HoverContent | HoverContent[] } | null)?.contents
      return {
        hover: (Array.isArray(contents) ? contents : contents ? [contents] : [])
          .map((item) => (typeof item === 'string' ? item : item.value))
          .join('\n\n'),
        locations: [],
      }
    }
    const locations: CodeLocation[] = []
    for (const item of (Array.isArray(result) ? result : result ? [result] : []) as (
      Location | LocationLink
    )[]) {
      const uri = 'targetUri' in item ? item.targetUri : item.uri
      if (!uri.startsWith('file:')) continue
      const path = relative(root, fileURLToPath(uri)).split(sep).join('/')
      // Navigation stays inside the reviewed target, including unchanged files.
      if (!snapshot.paths.includes(path)) continue
      const position = 'targetUri' in item ? item.targetSelectionRange.start : item.range.start
      if (
        !locations.some(
          (item) =>
            item.path === path &&
            item.line === position.line + 1 &&
            item.character === position.character,
        )
      )
        locations.push({ path, line: position.line + 1, character: position.character })
    }
    return { hover: '', locations }
  }

  private async request(
    connection: ReturnType<typeof createMessageConnection>,
    method: string,
    params: object,
  ): Promise<unknown> {
    const cancellation = new CancellationTokenSource()
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        connection.sendRequest(method, params, cancellation.token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            cancellation.cancel()
            reject(new Error('TypeScript server timed out. Try again after project setup.'))
          }, 20000)
        }),
      ])
    } finally {
      clearTimeout(timer)
      cancellation.dispose()
    }
  }
}
