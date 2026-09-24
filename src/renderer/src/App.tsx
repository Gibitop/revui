import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  FolderGit2,
  FolderOpen,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
} from 'lucide-react'
import type { Bootstrap, PreferencesPatch, Repository } from '../../shared/desktop'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { SettingsDialog } from './SettingsDialog'
import { RepositoryDialog, RepositoryChoices } from './RepositoryDialog'
import { Review } from './Review'

export function App() {
  const [repositoriesOpen, setRepositoriesOpen] = useState(false)
  const queryClient = useQueryClient()
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => window.desktop.getBootstrap(),
  })
  const [repository, setRepository] = useState<Repository | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchToolbar, setSearchToolbar] = useState<HTMLDivElement | null>(null)
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const preferences = useMutation({
    mutationFn: (patch: PreferencesPatch) => window.desktop.updatePreferences(patch),
    scope: { id: 'preferences' },
  })
  const openRepository = useMutation({
    mutationFn: async (path?: string) => {
      if (repository && !(await window.desktop.leaveWorkspace(repository.path))) return null
      return path ? window.desktop.reopenRepository(path) : window.desktop.chooseRepository()
    },
    onSuccess: (result) => {
      if (result) {
        setRepository(result)
        setRepositoriesOpen(false)
      }
    },
  })

  useEffect(() => {
    const unsubscribeSettings = window.desktop.onSettingsChanged((settings) => {
      queryClient.setQueryData<Bootstrap>(['bootstrap'], (current) =>
        current ? { ...current, settings } : current,
      )
    })
    const unsubscribeTheme = window.desktop.onSystemThemeChanged((systemTheme) => {
      queryClient.setQueryData<Bootstrap>(['bootstrap'], (current) =>
        current ? { ...current, systemTheme } : current,
      )
    })
    return () => {
      unsubscribeSettings()
      unsubscribeTheme()
    }
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
      if (event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
      if (event.key.toLowerCase() === 'o' && !settingsOpen && !openRepository.isPending) {
        event.preventDefault()
        setRepositoriesOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    data?.platform,
    settingsOpen,
    openRepository.isPending,
    openRepository.mutate,
    setSettingsOpen,
  ])

  if (isPending)
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 p-6">
        <Loader2 className="size-4 animate-spin" />
        <span>Opening workspace…</span>
      </main>
    )
  if (error || !data)
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 p-6">
        <h1 className="font-semibold">Unable to open RevUI</h1>
        <p role="alert">{error?.message}</p>
        <Button onClick={() => void refetch()}>Try again</Button>
      </main>
    )

  const { settings } = data
  const commandKey = data.platform === 'darwin' ? '⌘' : 'Ctrl+'
  const recentRepositories = settings.recentRepositories.filter((path) => path !== repository?.path)

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh flex-col overflow-clip">
        <header
          className="toolbar flex h-12 shrink-0 items-center gap-2.5 border-b bg-surface px-3"
          aria-label="Repository toolbar"
        >
          {repository && (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label={settings.sidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'}
              title={`${settings.sidebarCollapsed ? 'Show file sidebar' : 'Hide file sidebar'} (Shift+F)`}
              aria-expanded={!settings.sidebarCollapsed}
              aria-controls="review-files-sidebar"
              onClick={() => preferences.mutate({ sidebarCollapsed: !settings.sidebarCollapsed })}
            >
              {settings.sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          )}
          <Tooltip
            label={`${repository ? 'Open another repository' : 'Open repository'} (${commandKey}O)`}
          >
            <Button
              variant="ghost"
              className="max-w-50 min-w-17.5 shrink [&_span]:overflow-hidden [&_span]:text-ellipsis"
              disabled={openRepository.isPending}
              onClick={() => setRepositoriesOpen(true)}
            >
              {openRepository.isPending ? <Loader2 className="animate-spin" /> : <FolderOpen />}
              <span>{repository?.name ?? 'Open repository'}</span>
            </Button>
          </Tooltip>
          {repository && <div ref={setToolbar} className="min-w-0 flex-[0_1_auto]" />}
          <div
            data-testid="window-drag-space"
            className="window-drag-space flex-[1_0_90px] self-stretch"
            aria-hidden="true"
          />
          {repository && <div ref={setSearchToolbar} className="flex shrink-0" />}
          <Tooltip label={`Settings (${commandKey},)`}>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 />
            </Button>
          </Tooltip>
        </header>

        {((openRepository.error && !repositoriesOpen) || preferences.error || data.warning) && (
          <div className="border-b bg-muted px-6 py-3" role="alert">
            {(!repositoriesOpen && openRepository.error?.message) ||
              preferences.error?.message ||
              data.warning}
          </div>
        )}
        <main data-testid="workspace" className="flex min-h-0 flex-1 flex-col overflow-clip">
          {repository ? (
            <Review
              toolbar={toolbar}
              searchToolbar={searchToolbar}
              key={repository.path}
              repository={repository}
              settings={settings}
              theme={settings.theme === 'system' ? data.systemTheme : settings.theme}
              preferences={(patch) => preferences.mutate(patch)}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-6 py-12 sm:py-20">
              <div className="mx-auto w-full max-w-130">
                <div className="mb-5 flex size-12 items-center justify-center rounded-xl border bg-surface">
                  <FolderGit2 className="size-6 text-muted-foreground" />
                </div>
                <h1 className="font-semibold">Welcome to RevUI</h1>
                <p className="mt-2 max-w-100 text-muted-foreground">
                  A quiet place to review your code. Open a local Git repository to compare changes
                  and leave review notes.
                </p>
                <div className="mt-6 flex flex-wrap items-center gap-4">
                  <Button
                    className="h-10 px-4"
                    disabled={openRepository.isPending}
                    onClick={() => openRepository.mutate()}
                  >
                    {openRepository.isPending ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <FolderOpen />
                    )}
                    {openRepository.isPending ? 'Opening repository…' : 'Open folder…'}
                  </Button>
                  <span className="text-muted-foreground">
                    <kbd className="rounded border bg-surface px-1.5 py-0.5 font-mono">
                      {commandKey}O
                    </kbd>{' '}
                    to browse repositories
                  </span>
                </div>

                {recentRepositories.length > 0 && (
                  <section className="mt-10" aria-labelledby="recent-heading">
                    <h2 id="recent-heading" className="font-semibold">
                      Recent repositories
                    </h2>
                    <div className="mt-3 rounded-lg border p-1">
                      <RepositoryChoices
                        paths={recentRepositories}
                        pending={openRepository.isPending}
                        onSelect={(path) => openRepository.mutate(path)}
                      />
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      <RepositoryDialog
        open={repositoriesOpen}
        onOpenChange={setRepositoriesOpen}
        paths={settings.recentRepositories}
        pending={openRepository.isPending}
        onSelect={(path) => openRepository.mutate(path)}
        error={openRepository.error}
      />
      <SettingsDialog
        platform={data.platform}
        repository={repository}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onChange={(patch) => preferences.mutate(patch)}
        error={preferences.error}
      />
    </TooltipProvider>
  )
}
