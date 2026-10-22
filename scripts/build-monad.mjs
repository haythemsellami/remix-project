import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const crate = path.join(root, 'libs/remix-monad/wasm')
const output = path.join(root, 'libs/remix-monad/pkg')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
const version = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' })
if (version.stdout?.trim() !== 'wasm-bindgen 0.2.128') {
  throw new Error('Install the matching bindings tool: cargo +1.91 install wasm-bindgen-cli --version 0.2.128 --locked')
}
run('cargo', ['+1.91', 'build', '--manifest-path', path.join(crate, 'Cargo.toml'), '--target-dir', path.join(crate, 'target'), '--locked', '--release', '--target', 'wasm32-unknown-unknown'])
mkdirSync(output, { recursive: true })
run('wasm-bindgen', [path.join(crate, 'target/wasm32-unknown-unknown/release/remix_monad_wasm.wasm'), '--target', 'web', '--out-dir', output, '--out-name', 'remix_monad_wasm'])
writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: '@remix-project/monad-wasm', private: true, type: 'module', version: '0.1.0' }, null, 2) + '\n')
