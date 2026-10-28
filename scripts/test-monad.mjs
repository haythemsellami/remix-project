import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

mkdirSync('tmp/monad-tests', { recursive: true })
await build({
  entryPoints: ['libs/remix-monad/test/integration.ts', 'libs/remix-monad/test/nested.ts', 'libs/remix-monad/test/state.ts', 'libs/remix-monad/test/console.ts', 'libs/remix-monad/test/solidity-tests.ts', 'libs/remix-monad/test/signing.ts', 'libs/remix-monad/test/deployment.ts', 'libs/remix-monad/test/precompiles.ts', 'libs/remix-monad/test/transactions.ts'], bundle: true,
  platform: 'node', format: 'esm', packages: 'external',
  outdir: 'tmp/monad-tests', outExtension: { '.js': '.mjs' },
  plugins: [{ name: 'legacy-package-paths', setup(build) {
    build.onResolve({ filter: /^(ethereum-cryptography|solc)\// }, args => ({ path: require.resolve(args.path), external: true }))
  } }],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' }
})
const result = spawnSync(process.execPath, ['--test', 'tmp/monad-tests/integration.mjs', 'tmp/monad-tests/nested.mjs', 'tmp/monad-tests/state.mjs', 'tmp/monad-tests/console.mjs', 'tmp/monad-tests/solidity-tests.mjs', 'tmp/monad-tests/signing.mjs', 'tmp/monad-tests/deployment.mjs', 'tmp/monad-tests/precompiles.mjs', 'tmp/monad-tests/transactions.mjs'], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
