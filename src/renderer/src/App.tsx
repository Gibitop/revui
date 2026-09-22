import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, GitBranch, Loader2, Settings2 } from 'lucide-react'
import type { Bootstrap, PreferencesPatch } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { useWorkspace } from './state'

export function App() {
  const queryClient = useQueryClient()
  const { data, error, isPending, refetch } = useQuery({ queryKey: ['bootstrap'], queryFn: () => window.desktop.getBootstrap() })
  const { repository, setRepository, settingsOpen, setSettingsOpen } = useWorkspace()
  const preferences = useMutation({
    mutationFn: (patch: PreferencesPatch) => window.desktop.updatePreferences(patch),
    scope: { id: 'preferences' },
  })
  const openRepository = useMutation({
    mutationFn: (path?: string) => path ? window.desktop.reopenRepository(path) : window.desktop.chooseRepository(),
    onSuccess: (result) => { if (result) setRepository(result) },
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
        event.preventDefault(); openRepository.mutate(undefined)
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
            <Button variant="ghost" className="repository-switch" disabled={openRepository.isPending} onClick={() => openRepository.mutate(undefined)}>
              {openRepository.isPending ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              <span>{repository?.name ?? 'Open repository'}</span>
            </Button>
          </Tooltip>
          {repository && <span className="branch"><GitBranch size={14} /><span>{repository.branch ?? 'Detached HEAD'}</span></span>}
          <Tooltip label={`Settings (${commandKey},)`}>
            <Button variant="ghost" size="icon" className="settings-button" aria-label="Settings" onClick={() => setSettingsOpen(true)}><Settings2 /></Button>
          </Tooltip>
        </header>

        {(openRepository.error || data.warning) && <div className="notice" role="alert">{openRepository.error?.message ?? data.warning}</div>}
        <main className="workspace">
          <div className="repository-content">
            <h1 className="text-label">{repository?.name ?? 'No repository open'}</h1>
            {repository ? <>
              <p className="text-code repository-path">{repository.path}</p>
              <p className="secondary-text">No comparison selected.</p>
            </> : <p className="secondary-text">Open a local Git repository from the toolbar or press {commandKey}O.</p>}

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
          </div>
        </main>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogTitle className="text-label">Settings</DialogTitle>
          <DialogDescription className="sr-only">Choose the application appearance.</DialogDescription>
          <fieldset className="appearance">
            <legend className="text-label">Appearance</legend>
            <div className="theme-options">
              {(['light', 'dark', 'system'] as const).map((theme) => <Button key={theme} variant="outline" aria-pressed={settings.theme === theme} onClick={() => preferences.mutate({ theme })}>
                {{ light: 'Light', dark: 'Dark', system: 'System' }[theme]}
              </Button>)}
            </div>
          </fieldset>
          {preferences.error && <p className="settings-error" role="alert">{preferences.error.message}</p>}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
