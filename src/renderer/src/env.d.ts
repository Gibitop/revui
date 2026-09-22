import type { DesktopAPI } from '../../shared/desktop'

declare global {
  interface Window { desktop: DesktopAPI }
}
