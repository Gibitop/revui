import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
execFileSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' })
console.log('Desktop dependencies are ready.')
