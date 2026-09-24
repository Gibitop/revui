import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore, preferencesPatchSchema } from './settings'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('settings persistence', () => {
  it('serializes concurrent changes and preserves them after reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revui-settings-'))
    directories.push(directory)
    const store = new SettingsStore(directory)
    await store.load()
    await Promise.all([
      store.updatePreferences({ theme: 'dark' }),
      store.updatePreferences({ diffLayout: 'unified' }),
      store.rememberRepository('/work/project'),
      store.updatePreferences({ aiPanelOpen: true }),
    ])
    const reopened = new SettingsStore(directory)
    await reopened.load()
    expect(reopened.get()).toMatchObject({
      theme: 'dark',
      diffLayout: 'unified',
      aiPanelOpen: true,
      recentRepositories: ['/work/project'],
    })
    expect(await readdir(directory)).toEqual(['settings.json'])
    const snapshot = reopened.get()
    snapshot.recentRepositories.push('/injected')
    expect(reopened.get().recentRepositories).toEqual(['/work/project'])
  })

  it('keeps invalid settings as a backup and recovers with defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revui-settings-'))
    directories.push(directory)
    await writeFile(join(directory, 'settings.json'), '{broken')
    const store = new SettingsStore(directory)
    await store.load()
    expect(store.get().theme).toBe('system')
    expect(store.warning).toContain('preserved')
    const backup = (await readdir(directory))[0]
    expect(await readFile(join(directory, backup), 'utf8')).toBe('{broken')
    await store.updatePreferences({ theme: 'light' })
    expect((await readdir(directory)).length).toBe(2)
  })

  it('refuses a newer schema without modifying the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revui-settings-'))
    directories.push(directory)
    const original = JSON.stringify({ version: 2, futureSetting: true })
    await writeFile(join(directory, 'settings.json'), original)
    await expect(new SettingsStore(directory).load()).rejects.toThrow('another version')
    expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(original)
  })

  it('does not update memory on write failure and allows a later retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revui-settings-'))
    directories.push(directory)
    const store = new SettingsStore(directory)
    await store.load()
    await mkdir(join(directory, 'settings.json'))
    await expect(store.updatePreferences({ theme: 'dark' })).rejects.toThrow()
    expect(store.get().theme).toBe('system')
    await rm(join(directory, 'settings.json'), { recursive: true })
    await expect(store.updatePreferences({ theme: 'dark' })).resolves.toMatchObject({
      theme: 'dark',
    })
    expect(await readdir(directory)).toEqual(['settings.json'])
  })

  it('deduplicates recent repositories and limits the list to ten', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'revui-settings-'))
    directories.push(directory)
    const store = new SettingsStore(directory)
    await store.load()
    for (let i = 0; i < 12; i++) await store.rememberRepository(`/work/${i}`)
    await store.rememberRepository('/work/5')
    expect(store.get().recentRepositories).toHaveLength(10)
    expect(store.get().recentRepositories[0]).toBe('/work/5')
    expect(new Set(store.get().recentRepositories).size).toBe(10)
  })

  it('rejects invalid values and renderer attempts to change protected settings', () => {
    expect(preferencesPatchSchema.safeParse({ theme: 'unknown' }).success).toBe(false)
    expect(preferencesPatchSchema.safeParse({ recentRepositories: ['/private'] }).success).toBe(
      false,
    )
    expect(preferencesPatchSchema.safeParse({ version: 2 }).success).toBe(false)
    expect(preferencesPatchSchema.safeParse({ aiPanelOpen: 'yes' }).success).toBe(false)
  })
})

it('retains workspace command overrides across unrelated preferences and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revui-tool-settings-'))
  directories.push(directory)
  const store = new SettingsStore(directory)
  await store.load()
  const commands = { script: 'echo setup' }
  await store.updatePreferences({
    workspaceCommands: commands,
    repositoryCommands: { '/project': commands },
    sidebarWidth: 320,
  })
  await store.updatePreferences({ theme: 'light' })
  const reopened = new SettingsStore(directory)
  await reopened.load()
  expect(reopened.get()).toMatchObject({
    workspaceCommands: commands,
    repositoryCommands: { '/project': commands },
    sidebarWidth: 320,
  })
})

it('loads retired panel preferences without resetting existing settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revui-legacy-settings-'))
  directories.push(directory)
  const store = new SettingsStore(directory)
  await store.load()
  await writeFile(
    join(directory, 'settings.json'),
    JSON.stringify({ ...store.get(), theme: 'dark', terminalPanelOpen: true, terminalHeight: 320 }),
  )
  await store.load()
  expect(store.warning).toBeNull()
  expect(store.get().theme).toBe('dark')
  expect(store.get()).not.toHaveProperty('terminalPanelOpen')
  expect(store.get()).not.toHaveProperty('terminalHeight')
  await store.updatePreferences({ wrapLines: true })
  expect(await readFile(join(directory, 'settings.json'), 'utf8')).not.toContain('terminal')
})

it('migrates global and repository setup scripts to the current machine command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revui-script-migration-'))
  directories.push(directory)
  const store = new SettingsStore(directory)
  await store.load()
  const legacy = { mac: 'echo mac', windows: 'echo windows', ide: ['code', '{file}'] }
  await writeFile(
    join(directory, 'settings.json'),
    JSON.stringify({
      ...store.get(),
      preferredIDE: 'custom',
      workspaceCommands: legacy,
      repositoryCommands: {
        '/project': { ...legacy, mac: 'echo repo-mac', windows: 'echo repo-windows' },
      },
    }),
  )
  await store.load()
  expect(store.warning).toBeNull()
  const platform = process.platform === 'win32' ? 'windows' : 'mac'
  expect(store.get().preferredIDE).toBe('vscode')
  expect(store.get().workspaceCommands).toEqual({ script: `echo ${platform}` })
  expect(store.get().repositoryCommands['/project']).toEqual({
    script: `echo repo-${platform}`,
  })
  await store.updatePreferences({ theme: 'dark' })
  const reopened = new SettingsStore(directory)
  await reopened.load()
  expect(reopened.get().workspaceCommands).toEqual(store.get().workspaceCommands)
  expect(reopened.get().repositoryCommands).toEqual(store.get().repositoryCommands)
  expect(await readFile(join(directory, 'settings.json'), 'utf8')).not.toContain('"windows":')
})

it('migrates old settings and persists independent AI task choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'revui-ai-settings-'))
  directories.push(directory)
  const store = new SettingsStore(directory)
  const legacy: any = store.get()
  delete legacy.aiTasks
  delete legacy.aiLanguage
  delete legacy.fileView
  await writeFile(join(directory, 'settings.json'), JSON.stringify(legacy))
  await store.load()
  expect(store.warning).toBeNull()
  expect(store.get().aiLanguage).toBe('')
  expect(store.get().fileView).toBe('tree')
  expect(store.get().aiTasks.chat).toEqual({ model: '', effort: '' })
  const tasks = { ...store.get().aiTasks, review: { model: 'review-model', effort: 'high' } }
  await store.updatePreferences({ aiTasks: tasks, aiLanguage: 'Serbian', fileView: 'flat' })
  await store.updatePreferences({ theme: 'dark' })
  const reopened = new SettingsStore(directory)
  await reopened.load()
  expect(reopened.get().aiTasks).toEqual(tasks)
  expect(reopened.get().aiLanguage).toBe('Serbian')
  expect(reopened.get().fileView).toBe('flat')
  expect(
    preferencesPatchSchema.safeParse({
      aiTasks: { ...tasks, chat: { model: 'x', effort: 'not valid' } },
    }).success,
  ).toBe(false)
})
