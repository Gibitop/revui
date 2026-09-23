import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PreferencesPatch, Settings } from '../shared/desktop'

const preferencesSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    diffLayout: z.enum(['split', 'unified']),
    reviewLayout: z.enum(['continuous', 'focused']),
    wrapLines: z.boolean(),
    sidebarCollapsed: z.boolean(),
    sidebarWidth: z.number().int().min(190).max(600),
    aiPanelOpen: z.boolean(),
    terminalPanelOpen: z.boolean(),
  })
  .strict()
export const preferencesPatchSchema = preferencesSchema.partial()
const settingsSchema = preferencesSchema
  .extend({
    wrapLines: z.boolean().default(false),
    sidebarCollapsed: z.boolean().default(false),
    sidebarWidth: z.number().int().min(190).max(600).default(270),
    version: z.literal(1),
    recentRepositories: z.array(z.string().min(1)).max(10),
  })
  .strict() satisfies z.ZodType<Settings>

export class SettingsStore {
  private settings: Settings = {
    version: 1,
    theme: 'system',
    diffLayout: 'split',
    reviewLayout: 'continuous',
    sidebarWidth: 270,
    sidebarCollapsed: false,
    wrapLines: false,
    aiPanelOpen: false,
    terminalPanelOpen: false,
    recentRepositories: [],
  }
  private queue: Promise<unknown> = Promise.resolve()
  warning: string | null = null

  constructor(private readonly directory: string) {}

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const path = join(this.directory, 'settings.json')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      // Never overwrite settings created by a newer application version.
      if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version !== 1) {
        throw new Error('unsupported-version')
      }
      this.settings = settingsSchema.parse(parsed)
    } catch (error) {
      if (error instanceof Error && error.message === 'unsupported-version') {
        throw new Error(
          'This settings file was created by another version of RevUI. Update the app before opening it.',
        )
      }
      const backup = `settings.invalid-${randomUUID()}.json`
      await rename(path, join(this.directory, backup))
      this.warning = `Your settings could not be read. Defaults are in use; the original file was preserved as ${backup}.`
    }
  }

  get(): Settings {
    return structuredClone(this.settings)
  }

  updatePreferences(patch: PreferencesPatch): Promise<Settings> {
    const validated = preferencesPatchSchema.parse(patch)
    return this.update((settings) => ({ ...settings, ...validated }))
  }

  rememberRepository(path: string): Promise<Settings> {
    return this.update((settings) => ({
      ...settings,
      recentRepositories: [
        path,
        ...settings.recentRepositories.filter((entry) => entry !== path),
      ].slice(0, 10),
    }))
  }

  private update(change: (settings: Settings) => Settings): Promise<Settings> {
    const operation = this.queue.then(async () => {
      const next = settingsSchema.parse(change(this.settings))
      const temporary = join(this.directory, `settings.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
          flag: 'wx',
        })
        await rename(temporary, join(this.directory, 'settings.json'))
      } finally {
        await rm(temporary, { force: true })
      }
      this.settings = next
      return this.get()
    })
    // A failed write must not poison subsequent updates.
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
