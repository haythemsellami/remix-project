# Browser tests and CI

The Monad workflow runs on pull requests targeting `master` or `monad` and pushes to either branch. It tests the installed package and provider, checks types, runs existing debugger regressions, builds Remix once and shares that build across four Chromium shards.

Use the Node version in `.nvmrc`. From the repository root:

```sh
yarn install --frozen-lockfile
yarn test:monad
yarn nx build remix-ide --configuration=development
yarn playwright install chromium
yarn test:monad:browser
```

The browser suite starts its own server on `127.0.0.1:8090` and serves the pinned Solidity compiler locally. Tests exercise deployment, storage and debugging on Monad Ten, Monad Next and Ethereum Osaka. Monad Next also checks extension instruction stepping. Each test uses a fresh browser context; retries are disabled.

Build the IDE again after changing application or library sources. Reports and failure traces are written under `playwright-report/monad` and `test-results/monad`.
