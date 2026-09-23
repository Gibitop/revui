import gitlabLogo from './assets/gitlab/gitlab.svg'
import { GitLabSettings } from './GitLab'
import { WorktreeSettings } from './WorktreeSettings'
import { useState } from 'react'
import { Tabs } from '@base-ui/react/tabs'
import { FolderCog, FolderGit2, Paintbrush } from 'lucide-react'
import type { Settings, PreferencesPatch, Repository } from '../../shared/desktop'
import type { ToolCommands } from '../../shared/workspace'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(620px,calc(100dvh-64px))] max-w-3xl overflow-hidden p-0">
        <DialogDescription className="sr-only">
          Manage appearance, GitLab connections, workspace preferences, and worktrees.
        </DialogDescription>
        <Tabs.Root defaultValue="appearance" orientation="vertical" className="flex h-full min-h-0">
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
            </Tabs.List>
          </aside>
          <div className="min-w-0 flex-1 overflow-y-auto">
            <Tabs.Panel value="gitlab" className="h-full outline-none">
              <GitLabSettings />
            </Tabs.Panel>
            <Tabs.Panel
              value="appearance"
              keepMounted
              className="p-6 outline-none data-hidden:hidden"
            >
              <h2 className="pr-10 font-semibold">Appearance</h2>
              <p className="mt-1 text-muted-foreground">Customize how you read and review code.</p>
              <div className="mt-7 divide-y">
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
                      description: 'Show changes side by side or in a single column.',
                      options: [
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
              <h2 className="pr-10 font-semibold">Workspace</h2>
              <p className="mt-1 text-muted-foreground">
                Configure setup scripts for your repositories.
              </p>
              <WorkspaceSettings settings={settings} repository={repository} />
            </Tabs.Panel>
            <Tabs.Panel value="worktrees" className="p-6 outline-none">
              <WorktreeSettings platform={platform} />
            </Tabs.Panel>
            {error && (
              <p className="px-6 pb-5" role="alert">
                {error.message}
              </p>
            )}
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
  const [scope, setScope] = useState('global')
  return (
    <div className="mt-6">
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
