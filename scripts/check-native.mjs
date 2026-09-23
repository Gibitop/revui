import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(
  require('electron'),
  [fileURLToPath(new URL('./native-smoke.cjs', import.meta.url))],
  {
    env: environment,
    stdio: 'inherit',
  },
)
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  if (signal) console.error(`Electron exited with ${signal}. Run this check in a desktop session.`)
  process.exitCode = code ?? 1
})
