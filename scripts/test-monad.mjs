import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

mkdirSync('tmp/monad-tests', { recursive: true })
await build({
  entryPoints: ['libs/remix-monad/test/integration.ts'], bundle: true,
  platform: 'node', format: 'esm', packages: 'external',
  outfile: 'tmp/monad-tests/integration.mjs',
  plugins: [{ name: 'legacy-package-paths', setup(build) {
    build.onResolve({ filter: /^(ethereum-cryptography|solc)\// }, args => ({ path: require.resolve(args.path), external: true }))
  } }],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
})
const result = spawnSync(process.execPath, ['--test', 'tmp/monad-tests/integration.mjs'], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
