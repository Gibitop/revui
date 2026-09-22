import { create } from 'zustand'
import type { Repository } from '../../shared/desktop'

type WorkspaceState = {
  repository: Repository | null
  settingsOpen: boolean
  setRepository: (repository: Repository) => void
  setSettingsOpen: (open: boolean) => void
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  repository: null,
  settingsOpen: false,
  setRepository: (repository) => set({ repository }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}))
