import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { aiTasks, aiProviders, type AIProvider, type AIModel } from '../../shared/ai'
import { AIIcon, AISelect } from './AISelect'
import gitlabLogo from './assets/gitlab/gitlab.svg'
import { GitLabSettings } from './GitLab'
import { WorktreeSettings } from './WorktreeSettings'
import { useRef, useState } from 'react'
import { Tabs } from '@base-ui/react/tabs'
import { FolderCog, FolderGit2, Paintbrush, Bot, X } from 'lucide-react'
import type { Settings, PreferencesPatch, Repository } from '../../shared/desktop'
import type { ToolCommands } from '../../shared/workspace'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const sections = {
  appearance: 'Appearance',
  gitlab: 'GitLab',
  workspace: 'Workspace',
  worktrees: 'Worktrees',
  providers: 'AI Providers',
  ai: 'AI Scenarios',
} as const

export function SettingsDialog({
  platform,
  open,
  onOpenChange,
  settings,
  repository,
  onChange,
  error,
}: {
  platform: string
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
  repository: Repository | null
  onChange: (patch: PreferencesPatch) => void
  error: Error | null
}) {
  const [section, setSection] = useState<keyof typeof sections>('appearance')
  const scrollArea = useRef<HTMLDivElement>(null)
  const providers = Object.keys(aiProviders) as AIProvider[]
  const providerQueries = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ['ai-models', provider, settings.aiProviders[provider]],
      queryFn: () => window.desktop.aiModels(provider),
      staleTime: 300_000,
      refetchInterval: 300_000,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (document.querySelector('[data-model-search-popup]')) event.preventDefault()
        }}
        className="h-[min(620px,calc(100dvh-64px))] max-w-3xl overflow-hidden p-0"
      >
        <DialogDescription className="sr-only">
          Manage appearance, GitLab connections, workspace preferences, worktrees, AI providers, and
          AI scenarios.
        </DialogDescription>
        <Tabs.Root
          value={section}
          onValueChange={(value) => {
            setSection(value as keyof typeof sections)
            if (scrollArea.current) scrollArea.current.scrollTop = 0
          }}
          orientation="vertical"
          className="flex h-full min-h-0"
        >
          <aside className="flex w-44 shrink-0 flex-col border-r bg-muted/30 p-3">
            <DialogTitle className="px-3 pt-3 pb-7 font-semibold">Settings</DialogTitle>
            <Tabs.List activateOnFocus aria-label="Settings sections" className="space-y-1">
              <Tabs.Tab
                value="appearance"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-active:bg-accent data-active:font-semibold data-active:text-foreground"
              >
                <Paintbrush className="size-4" aria-hidden="true" />
                Appearance
              </Tabs.Tab>
              <Tabs.Tab
                value="gitlab"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-active:bg-accent data-active:font-semibold data-active:text-foreground"
              >
                <span
                  aria-hidden="true"
                  className="size-4 shrink-0 bg-current"
                  style={{ mask: `url("${gitlabLogo}") center / contain no-repeat` }}
                />
                GitLab
              </Tabs.Tab>
              <Tabs.Tab
                value="workspace"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-active:bg-accent data-active:font-semibold data-active:text-foreground"
              >
                <FolderCog className="size-4" aria-hidden="true" />
                Workspace
              </Tabs.Tab>
              <Tabs.Tab
                value="worktrees"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-active:bg-accent data-active:font-semibold data-active:text-foreground"
              >
                <FolderGit2 className="size-4" aria-hidden="true" />
                Worktrees
              </Tabs.Tab>
              <Tabs.Tab
                value="providers"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-active:bg-accent data-active:font-semibold data-active:text-foreground"
              >
                <Bot className="size-4" aria-hidden="true" />
                AI Providers
              </Tabs.Tab>
              <Tabs.Tab
                value="ai"
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-active:bg-accent data-active:font-semibold data-active:text-foreground"
              >
                <Bot className="size-4" aria-hidden="true" />
                AI Scenarios
              </Tabs.Tab>
            </Tabs.List>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex shrink-0 items-start gap-4 border-b bg-background p-6">
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">{sections[section]}</h2>
              </div>
              <DialogClose className="-mt-1 -mr-1 shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
                <X aria-hidden="true" className="size-4" />
                <span className="sr-only">Close settings</span>
              </DialogClose>
            </header>
            <div ref={scrollArea} className="min-h-0 flex-1 overflow-y-auto">
              <Tabs.Panel value="gitlab" className="h-full outline-none">
                <GitLabSettings />
              </Tabs.Panel>
              <Tabs.Panel
                value="appearance"
                keepMounted
                className="p-6 outline-none data-hidden:hidden"
              >
                <div className="divide-y">
                  {(
                    [
                      {
                        key: 'theme',
                        label: 'Theme',
                        description: 'Choose a color scheme for the app.',
                        options: [
                          { value: 'light', label: 'Light' },
                          { value: 'dark', label: 'Dark' },
                          { value: 'system', label: 'System' },
                        ],
                      },
                      {
                        key: 'diffLayout',
                        label: 'Diff layout',
                        description: 'Auto uses split view, switching to unified in narrow panes.',
                        options: [
                          { value: 'auto', label: 'Auto' },
                          { value: 'split', label: 'Split' },
                          { value: 'unified', label: 'Unified' },
                        ],
                      },
                      {
                        key: 'reviewLayout',
                        label: 'Review layout',
                        description: 'Browse all changed files or focus on one at a time.',
                        options: [
                          { value: 'continuous', label: 'Continuous' },
                          { value: 'focused', label: 'Focused file' },
                        ],
                      },
                    ] as const
                  ).map(({ key, label, description, options }) => (
                    <fieldset key={key} className="py-5 first:pt-0">
                      <legend className="sr-only">{label}</legend>
                      <p className="font-semibold" aria-hidden="true">
                        {label}
                      </p>
                      <p className="mt-1 text-muted-foreground">{description}</p>
                      <RadioGroup
                        aria-label={label}
                        className="mt-3"
                        value={settings[key]}
                        onValueChange={(value) => onChange({ [key]: value })}
                      >
                        {options.map((option) => (
                          <RadioGroupItem key={option.value} value={option.value}>
                            {option.label}
                          </RadioGroupItem>
                        ))}
                      </RadioGroup>
                    </fieldset>
                  ))}
                  <div className="flex items-center justify-between gap-4 py-5">
                    <div>
                      <label htmlFor="settings-wrap-lines" className="cursor-pointer font-semibold">
                        Wrap long lines
                      </label>
                      <p id="settings-wrap-description" className="mt-1 text-muted-foreground">
                        Keep long lines within the code pane.
                      </p>
                    </div>
                    <Switch
                      id="settings-wrap-lines"
                      aria-describedby="settings-wrap-description"
                      checked={settings.wrapLines}
                      onCheckedChange={(checked) => onChange({ wrapLines: checked })}
                    />
                  </div>
                </div>
              </Tabs.Panel>
              <Tabs.Panel
                value="workspace"
                keepMounted
                className="p-6 outline-none data-hidden:hidden"
              >
                <WorkspaceSettings
                  key={repository?.path ?? ''}
                  settings={settings}
                  repository={repository}
                />
              </Tabs.Panel>
              <Tabs.Panel value="worktrees" className="p-6 outline-none">
                <WorktreeSettings platform={platform} />
              </Tabs.Panel>
              <Tabs.Panel value="providers" className="p-6 outline-none">
                {providers.map((provider, index) => (
                  <ProviderSettings
                    key={provider}
                    provider={provider}
                    status={providerQueries[index]}
                    settings={settings}
                    onChange={onChange}
                  />
                ))}
              </Tabs.Panel>
              <Tabs.Panel value="ai" className="p-6 outline-none">
                <AISettings
                  settings={settings}
                  onChange={onChange}
                  modelQueries={providerQueries}
                />
              </Tabs.Panel>
              {error && (
                <p className="px-6 pb-5" role="alert">
                  {error.message}
                </p>
              )}
            </div>
          </div>
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  )
}

function WorkspaceSettings({
  settings,
  repository,
}: {
  settings: Settings
  repository: Repository | null
}) {
  const [scope, setScope] = useState(() =>
    repository && settings.repositoryCommands[repository.path] ? 'repository' : 'global',
  )
  return (
    <div>
      {repository ? (
        <>
          <RadioGroup aria-label="Workspace settings scope" value={scope} onValueChange={setScope}>
            <RadioGroupItem value="global">All repositories</RadioGroupItem>
            <RadioGroupItem value="repository">This repository</RadioGroupItem>
          </RadioGroup>
          <p
            className="mt-2 truncate text-muted-foreground"
            title={scope === 'repository' ? repository.path : undefined}
          >
            {scope === 'repository' ? repository.path : 'Default commands for every repository.'}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">
          Defaults for all repositories. Open a repository to configure its overrides.
        </p>
      )}
      <WorkspaceCommands
        key={`${scope}:${repository?.path ?? ''}`}
        settings={settings}
        repository={scope === 'repository' ? repository : null}
      />
    </div>
  )
}

function WorkspaceCommands({
  settings,
  repository,
}: {
  settings: Settings
  repository: Repository | null
}) {
  const existing = repository
    ? settings.repositoryCommands[repository.path]
    : settings.workspaceCommands
  const [override, setOverride] = useState(!!existing)
  const [commands, setCommands] = useState<ToolCommands>(existing ?? settings.workspaceCommands)
  const [saved, setSaved] = useState(() =>
    JSON.stringify({
      override: !!existing,
      commands: existing ?? settings.workspaceCommands,
    }),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedMessage, setSavedMessage] = useState(false)
  const dirty = JSON.stringify({ override, commands }) !== saved
  const inherited = !!repository && !override
  const displayed = inherited ? settings.workspaceCommands : commands
  return (
    <form
      className="mt-5 space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        setError('')
        setBusy(true)
        void (async () => {
          try {
            if (repository) {
              const overrides = { ...settings.repositoryCommands }
              if (override) overrides[repository.path] = commands
              else delete overrides[repository.path]
              await window.desktop.updatePreferences({ repositoryCommands: overrides })
            } else await window.desktop.updatePreferences({ workspaceCommands: commands })
            setSaved(JSON.stringify({ override, commands }))
            setSavedMessage(true)
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
          } finally {
            setBusy(false)
          }
        })()
      }}
    >
      {repository && (
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <label htmlFor="repository-command-override" className="cursor-pointer font-semibold">
              Repository-specific commands
            </label>
            <p className="mt-1 text-muted-foreground">
              {override
                ? 'Use separate commands for this repository.'
                : 'Inheriting the defaults for all repositories.'}
            </p>
          </div>
          <Switch
            id="repository-command-override"
            checked={override}
            disabled={busy}
            onCheckedChange={setOverride}
          />
        </div>
      )}
      <fieldset disabled={busy || inherited} className="space-y-3 disabled:opacity-50">
        <legend className="sr-only">Workspace setup</legend>
        <label className="block space-y-2">
          <span className="font-semibold">Post-checkout script</span>
          <Textarea
            value={displayed.script}
            onChange={(event) => setCommands({ ...commands, script: event.target.value })}
            className="min-h-24 font-mono"
            placeholder="pnpm install"
            spellCheck={false}
            aria-describedby="post-checkout-description"
          />
        </label>
        <p id="post-checkout-description" className="text-muted-foreground">
          Runs on this machine in the prepared workspace. Leave empty to skip setup.
        </p>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="sticky bottom-0 -mx-6 -mb-6 flex items-center justify-between gap-3 border-t bg-background px-6 py-4">
        <span role="status" className="text-muted-foreground">
          {dirty ? 'Unsaved changes' : savedMessage ? 'Changes saved' : ''}
        </span>
        <Button type="submit" disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save commands'}
        </Button>
      </div>
    </form>
  )
}

function AISettings({
  settings,
  onChange,
  modelQueries,
}: {
  modelQueries: UseQueryResult<AIModel[], Error>[]
  settings: Settings
  onChange: (patch: PreferencesPatch) => void
}) {
  const providers = Object.keys(aiProviders) as AIProvider[]
  return (
    <>
      <div className="space-y-2">
        <label htmlFor="ai-language" className="block font-semibold">
          Preferred response language
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="ai-language"
            key={settings.aiLanguage}
            defaultValue={settings.aiLanguage}
            maxLength={100}
            className="min-w-0 flex-1"
            placeholder="Automatic"
            aria-describedby="ai-language-help"
            onBlur={(event) => {
              const language = event.target.value.trim()
              if (language !== settings.aiLanguage) onChange({ aiLanguage: language })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.currentTarget.value = settings.aiLanguage
                event.currentTarget.blur()
              }
            }}
          />
          {settings.aiLanguage && (
            <Button
              variant="outline"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChange({ aiLanguage: '' })}
            >
              Use automatic
            </Button>
          )}
        </div>
        <p id="ai-language-help" className="text-muted-foreground">
          Used for chat, review comments, and review steps. Try “English” or “Serbian, Latin
          script”. Leave empty to follow the conversation’s language.
        </p>
      </div>
      <div className="mt-6 divide-y">
        {(
          [
            {
              key: 'autoAIReview',
              label: 'Automatically run AI review',
              description: 'Review changes in the background when you open a comparison.',
            },
            {
              key: 'autoAIReviewOrder',
              label: 'Automatically generate AI review order',
              description:
                'Prepare the review order when you open a comparison, reusing cached results.',
            },
          ] as const
        ).map(({ key, label, description }) => (
          <div key={key} className="flex items-center justify-between gap-4 py-5">
            <div>
              <label htmlFor={key} className="cursor-pointer font-semibold">
                {label}
              </label>
              <p id={`${key}-description`} className="mt-1 text-muted-foreground">
                {description}
              </p>
            </div>
            <Switch
              id={key}
              aria-describedby={`${key}-description`}
              checked={settings[key]}
              onCheckedChange={(checked) => onChange({ [key]: checked })}
            />
          </div>
        ))}
      </div>
      <div className="mt-6 space-y-6">
        {(Object.entries(aiTasks) as [keyof typeof aiTasks, string][]).map(([task, label]) => {
          const selection = settings.aiTasks[task]
          const provider = selection.provider ?? 'codex'
          const models = modelQueries[providers.indexOf(provider)]
          const selected = models.data?.find((item) => item.model === selection.model)
          const efforts = selected?.supportedReasoningEfforts ?? []
          return (
            <fieldset key={task} className="space-y-3">
              <legend className="font-semibold">{label}</legend>
              {models.isPending && models.isFetching && (
                <p role="status">Loading available models…</p>
              )}
              {models.error && (
                <div role="alert">
                  <p>{models.error.message}</p>
                  <Button variant="ghost" onClick={() => void models.refetch()}>
                    Retry loading models
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3">
                <AISelect
                  label="Provider"
                  ariaLabel={`${label} provider`}
                  value={provider}
                  provider={provider}
                  options={providers.map((id) => ({
                    value: id,
                    label: aiProviders[id],
                    provider: id,
                  }))}
                  onChange={(next) =>
                    onChange({
                      aiTasks: {
                        ...settings.aiTasks,
                        [task]: { provider: next as AIProvider, model: '', effort: '' },
                      },
                    })
                  }
                />
                <AISelect
                  label="Model"
                  searchable
                  ariaLabel={`${label} model`}
                  value={selection.model}
                  provider={provider}
                  options={[
                    { value: '', label: `${aiProviders[provider]} default` },
                    ...(selection.model && !selected
                      ? [
                          {
                            value: selection.model,
                            label: `${selection.model} (unavailable)`,
                            model: selection.model,
                          },
                        ]
                      : []),
                    ...(models.data ?? []).map((item) => ({
                      value: item.model,
                      label: item.displayName,
                      model: item.model + ' ' + item.displayName,
                    })),
                  ]}
                  onChange={(model) =>
                    onChange({
                      aiTasks: { ...settings.aiTasks, [task]: { ...selection, model, effort: '' } },
                    })
                  }
                />
                <AISelect
                  label="Reasoning effort"
                  reasoning
                  ariaLabel={`${label} reasoning effort`}
                  value={selection.effort}
                  disabled={!efforts.length}
                  options={[
                    { value: '', label: `${aiProviders[provider]} default` },
                    ...(selection.effort &&
                    !efforts.some((item) => item.reasoningEffort === selection.effort)
                      ? [{ value: selection.effort, label: `${selection.effort} (unavailable)` }]
                      : []),
                    ...efforts.map((item) => ({
                      value: item.reasoningEffort,
                      label: item.reasoningEffort,
                      description: item.description,
                    })),
                  ]}
                  onChange={(effort) =>
                    onChange({
                      aiTasks: { ...settings.aiTasks, [task]: { ...selection, effort } },
                    })
                  }
                />
              </div>
            </fieldset>
          )
        })}
      </div>
    </>
  )
}

function ProviderSettings({
  provider,
  status,
  settings,
  onChange,
}: {
  provider: AIProvider
  status: UseQueryResult<AIModel[], Error>
  settings: Settings
  onChange: (patch: PreferencesPatch) => void
}) {
  const config = settings.aiProviders[provider]
  return (
    <section className="mt-6 rounded-lg border p-4 first:mt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-semibold">
          <AIIcon provider={provider} className="size-6" />
          {aiProviders[provider]}
        </h3>
      </div>
      <p className="mt-2 text-muted-foreground" role="status">
        {status.isFetching
          ? 'Checking availability…'
          : status.error
            ? status.error.message
            : status.data
              ? `Connected · ${status.data.length} models available`
              : 'Not checked'}
      </p>
      <details className="mt-3">
        <summary className="cursor-pointer">Configuration</summary>
        <label className="mt-3 block space-y-1">
          <span className="block">Binary path</span>
          <Input
            key={config.executable}
            className="w-full"
            aria-label={`${aiProviders[provider]} binary path`}
            defaultValue={config.executable}
            onBlur={(event) => {
              const executable = event.target.value.trim()
              if (executable && executable !== config.executable)
                onChange({
                  aiProviders: { ...settings.aiProviders, [provider]: { ...config, executable } },
                })
            }}
          />
        </label>
      </details>
      <Button
        className="mt-3"
        variant="outline"
        disabled={status.isFetching}
        onClick={() => void status.refetch()}
      >
        Check availability
      </Button>
    </section>
  )
}
