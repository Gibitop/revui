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
