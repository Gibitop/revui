import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, Loader2, Settings2 } from 'lucide-react'
import type { Bootstrap, PreferencesPatch } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { useWorkspace } from './state'
import { Review } from './Review'

export function App() {
  const [repositoriesOpen, setRepositoriesOpen] = useState(false)
  const queryClient = useQueryClient()
  const { data, error, isPending, refetch } = useQuery({ queryKey: ['bootstrap'], queryFn: () => window.desktop.getBootstrap() })
  const { repository, setRepository, settingsOpen, setSettingsOpen } = useWorkspace()
  const preferences = useMutation({
    mutationFn: (patch: PreferencesPatch) => window.desktop.updatePreferences(patch),
    scope: { id: 'preferences' },
  })
  const openRepository = useMutation({
    mutationFn: (path?: string) => path ? window.desktop.reopenRepository(path) : window.desktop.chooseRepository(),
    onSuccess: (result) => { if (result) { setRepository(result); setRepositoriesOpen(false) } },
  })

  useEffect(() => {
    const unsubscribeSettings = window.desktop.onSettingsChanged((settings) => {
      queryClient.setQueryData<Bootstrap>(['bootstrap'], (current) => current ? { ...current, settings } : current)
    })
    const unsubscribeTheme = window.desktop.onSystemThemeChanged((systemTheme) => {
      queryClient.setQueryData<Bootstrap>(['bootstrap'], (current) => current ? { ...current, systemTheme } : current)
    })
    return () => { unsubscribeSettings(); unsubscribeTheme() }
  }, [queryClient])

  useEffect(() => {
    if (!data) return
    const theme = data.settings.theme === 'system' ? data.systemTheme : data.settings.theme
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    document.documentElement.dataset.platform = data.platform
  }, [data])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = data?.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (!modifier) return
      if (event.key === ',') { event.preventDefault(); setSettingsOpen(true) }
      if (event.key.toLowerCase() === 'o' && !settingsOpen && !openRepository.isPending) {
        event.preventDefault(); setRepositoriesOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [data?.platform, settingsOpen, openRepository.isPending, openRepository.mutate, setSettingsOpen])

  if (isPending) return <main className="startup"><Loader2 className="size-4 animate-spin" /><span>Opening workspace…</span></main>
  if (error || !data) return (
    <main className="startup"><h1 className="text-label">Unable to open RevUI</h1><p role="alert">{error?.message}</p><Button onClick={() => void refetch()}>Try again</Button></main>
  )

  const { settings } = data
  const commandKey = data.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const recentRepositories = settings.recentRepositories.filter((path) => path !== repository?.path)

  return (
    <TooltipProvider delayDuration={300}>
      <div className="app-shell">
        <header className="toolbar" aria-label="Repository toolbar">
          <Tooltip label={`${repository ? 'Open another repository' : 'Open repository'} (${commandKey}O)`}>
            <Button variant="ghost" className="repository-switch" disabled={openRepository.isPending} onClick={() => setRepositoriesOpen(true)}>
              {openRepository.isPending ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              <span>{repository?.name ?? 'Open repository'}</span>
            </Button>
          </Tooltip>
          {repository && <div id="comparison-controls" />}
          <div className="window-drag-space" aria-hidden="true" />
          <Tooltip label={`Settings (${commandKey},)`}>
            <Button variant="ghost" size="icon" className="settings-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings2 /></Button>
          </Tooltip>
        </header>

        {(openRepository.error || preferences.error || data.warning) && <div className="notice" role="alert">{openRepository.error?.message ?? preferences.error?.message ?? data.warning}</div>}
        <main className="workspace">
          {repository ? <Review key={repository.path} repository={repository} settings={settings} theme={settings.theme === 'system' ? data.systemTheme : settings.theme} preferences={(patch) => preferences.mutate(patch)} /> : <div className="repository-content">
            <h1 className="text-label">No repository open</h1>
            <p className="secondary-text">Open a local Git repository from the toolbar or press {commandKey}O.</p>

            {recentRepositories.length > 0 && <section className="recent-repositories" aria-labelledby="recent-heading">
              <h2 id="recent-heading" className="text-label">Recent repositories</h2>
              <ul>
                {recentRepositories.map((path) => <li key={path}>
                  <button className="recent-repository" disabled={openRepository.isPending} onClick={() => openRepository.mutate(path)}>
                    <span className="text-label">{path.split(/[\\/]/).pop()}</span>
                    <span className="text-code secondary-text repository-path">{path}</span>
                  </button>
                </li>)}
              </ul>
            </section>}
          </div>}
        </main>
      </div>

      <Dialog open={repositoriesOpen} onOpenChange={setRepositoriesOpen}>
        <DialogContent closeLabel="Close repository picker" className="repository-dialog">
          <DialogTitle className="text-label">Open repository</DialogTitle>
          <DialogDescription className="sr-only">Select a recent repository or add one from your computer.</DialogDescription>
          <div className="repository-choices">
            {settings.recentRepositories.map((path) => <button key={path} className="recent-repository" disabled={openRepository.isPending} onClick={() => openRepository.mutate(path)}>
              <span className="text-label">{path.split(/[\\/]/).pop()}</span><span className="text-code secondary-text repository-path">{path}</span>
            </button>)}
          </div>
          <Button variant="outline" disabled={openRepository.isPending} onClick={() => openRepository.mutate(undefined)}><FolderOpen />Add repository</Button>
          {openRepository.error && <p role="alert" className="settings-error">{openRepository.error.message}</p>}
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogTitle className="text-label">Settings</DialogTitle>
          <DialogDescription className="sr-only">Choose application appearance and review layouts. These settings apply to all repositories.</DialogDescription>
          <fieldset className="appearance">
            <legend className="text-label">Appearance</legend>
            <div className="theme-options">
              {(['light', 'dark', 'system'] as const).map((theme) => <Button key={theme} variant="outline" aria-pressed={settings.theme === theme} onClick={() => preferences.mutate({ theme })}>
                {{ light: 'Light', dark: 'Dark', system: 'System' }[theme]}
              </Button>)}
            </div>
          </fieldset>
          <fieldset className="appearance">
            <legend className="text-label">Diff layout</legend>
            <LayoutTabs label="Diff layout" value={settings.diffLayout} options={['split', 'unified']} onChange={(diffLayout) => preferences.mutate({ diffLayout })} />
          </fieldset>
          <fieldset className="appearance">
            <legend className="text-label">Review layout</legend>
            <LayoutTabs label="Review layout" value={settings.reviewLayout} options={['continuous', 'focused']} onChange={(reviewLayout) => preferences.mutate({ reviewLayout })} />
          </fieldset>
          <div className="appearance">
            <label className="flex items-center gap-2"><input type="checkbox" checked={settings.wrapLines} onChange={(event) => preferences.mutate({ wrapLines: event.target.checked })} />Wrap long lines</label>
          </div>
          {preferences.error && <p className="settings-error" role="alert">{preferences.error.message}</p>}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

function LayoutTabs<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: T[]; onChange: (value: T) => void }) {
  return <div role="tablist" aria-label={label} className="layout-tabs">{options.map((option, index) => <button key={option} role="tab" aria-selected={value === option} tabIndex={value === option ? 0 : -1} onClick={() => onChange(option)} onKeyDown={(event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length
    onChange(options[next]); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus()
  }}>{option === 'focused' ? 'Focused file' : option[0].toUpperCase() + option.slice(1)}</button>)}</div>
}
