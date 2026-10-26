# Browser tests and CI

The `Monad integration` GitHub Actions workflow runs on pull requests targeting `master`, pushes to `master`, and manual dispatch. It tests the installed `monad-revmjs` package through the provider, checks types, runs the existing disassembler tests, builds Remix, and runs the Chromium suite. The standard `test:libs` command also includes `remix-monad`.

Use the Node version in `.nvmrc` and install with `yarn install --frozen-lockfile`. From the repository root:

```sh
yarn test:monad
yarn nx build remix-ide --configuration=development
yarn playwright install chromium
yarn test:monad:browser
```

On Linux, use `yarn playwright install --with-deps chromium` to install browser system dependencies as well. Remix consumes the prebuilt engine package; these checks need no Rust toolchain or account credentials.

The dedicated Playwright configuration starts a fresh server on `127.0.0.1:8090`; leave that port free. It serves the compiler pinned by `yarn.lock` from a generated directory under `dist/apps/remix-ide/__monad-tests__`. Each test starts with a fresh browser context and compiles the shared `MonadDemo.sol` example for Cancun through the IDE. Normal Remix startup still fetches public configuration over the network.

All three environments (Monad Next, Monad Ten, and Ethereum Osaka) exercise deployment, constructor stepping, storage reads and writes, source highlighting, and decoded Solidity state. Monad Next also executes `CALLSTACKDEPTH` through a nested `STATICCALL`, checks instruction PCs `0` and `2`, and verifies stack values while stepping backward and forward. Fork-specific opcode rejection is covered by the provider integration suite.

The workflow uploads `monad-browser-results`, containing the HTML report and failure screenshots, browser diagnostics, and Playwright traces. Locally, use:

```sh
yarn playwright show-report playwright-report/monad
yarn playwright show-trace test-results/monad/<failed-test>/trace.zip
```

The general Playwright configuration excludes this suite because it needs its dedicated compiler and server setup. Browser tests exercise the built application; rebuild Remix after changing application or library code.
