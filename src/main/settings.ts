import { defaultAITasks } from '../shared/ai'
import { ideChoices } from '../shared/workspace'
import { commandsSchema } from './workspace'
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PreferencesPatch, Settings } from '../shared/desktop'

const modelSettingsSchema = z
  .object({
    model: z
      .string()
      .trim()
      .max(200)
      .refine((value) => !/[\r\n\0]/.test(value)),
    effort: z
      .string()
      .max(40)
      .regex(/^[a-z]*$/),
  })
  .strict()
const aiTasksSchema = z
  .object({
    chat: modelSettingsSchema,
    review: modelSettingsSchema,
    order: modelSettingsSchema,
  })
  .strict()
const preferencesSchema = z
  .object({
    preferredIDE: z.enum(
      Object.keys(ideChoices) as [keyof typeof ideChoices, ...Array<keyof typeof ideChoices>],
    ),
    workspaceCommands: commandsSchema,
    repositoryCommands: z.record(z.string(), commandsSchema),
    theme: z.enum(['system', 'light', 'dark']),
    diffLayout: z.enum(['auto', 'split', 'unified']),
    reviewLayout: z.enum(['continuous', 'focused']),
    wrapLines: z.boolean(),
    fileView: z.enum(['tree', 'flat']),
    sidebarCollapsed: z.boolean(),
    sidebarWidth: z.number().int().min(190).max(600),
    aiTasks: aiTasksSchema,
    aiLanguage: z
      .string()
      .trim()
      .max(100)
      .refine((value) => !/[\r\n\0]/.test(value)),
    aiPanelOpen: z.boolean(),
    aiPanelWidth: z.number().int().min(380).max(800),
  })
  .strict()
export const preferencesPatchSchema = preferencesSchema.partial()
const settingsSchema = preferencesSchema
  .extend({
    preferredIDE: preferencesSchema.shape.preferredIDE.default('vscode'),
    workspaceCommands: commandsSchema.default({ script: '' }),
    repositoryCommands: z.record(z.string(), commandsSchema).default({}),
    wrapLines: z.boolean().default(false),
    fileView: preferencesSchema.shape.fileView.default('tree'),
    sidebarCollapsed: z.boolean().default(false),
    sidebarWidth: z.number().int().min(190).max(600).default(270),
    aiPanelWidth: z
      .number()
      .int()
      .min(280)
      .max(800)
      .default(380)
      .transform((width) => Math.max(380, width)),
    aiTasks: aiTasksSchema.default(defaultAITasks),
    aiLanguage: preferencesSchema.shape.aiLanguage.default(''),
    version: z.literal(1),
    recentRepositories: z.array(z.string().min(1)).max(10),
  })
  .strict() satisfies z.ZodType<Settings>

export class SettingsStore {
  private settings: Settings = {
    preferredIDE: 'vscode',
    workspaceCommands: { script: '' },
    repositoryCommands: {},
    aiTasks: structuredClone(defaultAITasks),
    aiLanguage: '',
    version: 1,
    theme: 'system',
    diffLayout: 'auto',
    reviewLayout: 'continuous',
    sidebarWidth: 270,
    sidebarCollapsed: false,
    fileView: 'tree',
    wrapLines: false,
    aiPanelOpen: false,
    aiPanelWidth: 380,
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
      // Migrate retired panel preferences and platform-specific setup commands.
      if (parsed && typeof parsed === 'object') {
        delete (parsed as Record<string, unknown>).terminalPanelOpen
        delete (parsed as Record<string, unknown>).terminalHeight
        const value = parsed as Record<string, unknown>
        if (value.preferredIDE === 'custom') value.preferredIDE = 'vscode'
        const overrides = value.repositoryCommands
        const commands = [
          value.workspaceCommands,
          ...(overrides && typeof overrides === 'object' ? Object.values(overrides) : []),
        ]
        for (const entry of commands) {
          if (!entry || typeof entry !== 'object') continue
          const command = entry as Record<string, unknown>
          if (!('script' in command) && ('mac' in command || 'windows' in command))
            command.script = command[process.platform === 'win32' ? 'windows' : 'mac']
          delete command.mac
          delete command.windows
          delete command.ide
        }
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
