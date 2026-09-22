import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const result = spawnSync(process.execPath, [join(import.meta.dirname, '../node_modules/@playwright/test/cli.js'), 'test', 'benchmark.spec.ts'], {
  stdio: 'inherit',
  env: { ...process.env, REVUI_BENCHMARK: '1' },
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
