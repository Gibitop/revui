import cursorDark from './assets/ide/cursor_dark.svg'
import cursorLight from './assets/ide/cursor_light.svg'
import vscode from './assets/ide/vscode.svg'
import idea from './assets/ide/intellijidea.svg'
import webstorm from './assets/ide/webstorm.svg'
import { useState } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Check, ChevronDown } from 'lucide-react'
import { ideChoices, type IDE } from '../../shared/workspace'
import type { Settings } from '../../shared/desktop'
import { Tooltip } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'

function IDEIcon({ ide }: { ide: IDE }) {
  if (ide === 'cursor')
    return (
      <>
        <img src={cursorLight} alt="" className="size-4 shrink-0 dark:hidden" />
        <img src={cursorDark} alt="" className="hidden size-4 shrink-0 dark:block" />
      </>
    )
  return <img src={{ vscode, idea, webstorm }[ide]} alt="" className="size-4 shrink-0" />
}

export function IDEButton({
  repository,
  workspaceId,
  path,
  line,
  settings,
  disabled = false,
}: {
  repository: string
  workspaceId: string | null
  path: string | null
  line: number
  settings: Settings
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = path ?? 'project'
  const selected = settings.preferredIDE
  const open = async (ide: IDE) => {
    setBusy(true)
    setError('')
    try {
      if (ide !== settings.preferredIDE)
        await window.desktop.updatePreferences({ preferredIDE: ide })
      await window.desktop.openWorkspaceIDE(repository, workspaceId, path, line, ide)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Tooltip
        label={
          disabled
            ? 'Initialize the workspace before opening the project in an IDE.'
            : `Open ${label} in ${ideChoices[selected]}`
        }
      >
        <div
          className="inline-flex shrink-0"
          role="group"
          tabIndex={disabled ? 0 : undefined}
          aria-label={`Open ${label} in IDE`}
        >
          <Button
            variant="ghost"
            size="icon"
            disabled={busy || disabled}
            aria-label={`Open ${label} in ${ideChoices[selected]}`}

            onClick={() => void open(selected)}
          >
            <IDEIcon ide={selected} />
          </Button>
          <Menu.Root>
            <Menu.Trigger
              render={<Button variant="ghost" size="icon" className="w-6" />}
              disabled={busy || disabled}
              aria-label={`Choose IDE for ${label}`}
              title="Choose IDE"
            >
              <ChevronDown aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner align="start" sideOffset={5} className="z-50">
                <Menu.Popup className="min-w-48 rounded-md border bg-background p-1 text-foreground shadow-lg">
                  {(Object.entries(ideChoices) as [IDE, string][]).map(([ide, name]) => (
                    <Menu.Item
                      key={ide}
                      className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-highlighted:bg-accent"
                      onClick={() => void open(ide)}
                    >
                      <IDEIcon ide={ide} />
                      <span className="flex-1">{name}</span>
                      {selected === ide && <Check className="size-3.5" aria-hidden="true" />}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </Tooltip>
      {error && (
        <span role="alert" className="max-w-96 break-words text-muted-foreground">
          {error}
        </span>
      )}
    </>
  )
}
