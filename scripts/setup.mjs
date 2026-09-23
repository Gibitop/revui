import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
execFileSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' })
const ptyDirectory = dirname(require.resolve('node-pty/package.json'))
execFileSync(process.execPath, [join(ptyDirectory, 'scripts/post-install.js')], {
  stdio: 'inherit',
})

// node-pty ships Node-API prebuilds for macOS/Windows. Some package-manager
// extractions lose the executable bit on the macOS helper.
if (process.platform === 'darwin') {
  for (const folder of ['build/Release', `prebuilds/darwin-${process.arch}`]) {
    const helper = join(ptyDirectory, folder, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
console.log('Desktop dependencies are ready. Run pnpm run test:native to verify terminal support.')
