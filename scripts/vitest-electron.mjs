// better-sqlite3 is compiled for Electron's ABI (see the postinstall script), so the tests run
// on Electron's bundled Node instead of the system Node, which could not load it.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const vitestCli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const child = spawn(electronBinary, [vitestCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
child.on('exit', code => process.exit(code ?? 1))
