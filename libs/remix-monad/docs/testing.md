# Browser tests and CI

The `Monad integration` GitHub Actions workflow runs on pull requests targeting `master`, pushes to `master`, and manual dispatch. It tests the installed `monad-revmjs` package through the provider, checks types, runs the existing debugger tests, builds Remix, and runs the Chromium suite. The standard `test:libs` command also includes `remix-monad`.

Use the Node version in `.nvmrc` and install with `yarn install --frozen-lockfile`. From the repository root:

```sh
yarn test:monad
yarn nx build remix-ide --configuration=development
yarn playwright install chromium
yarn test:monad:browser
```

On Linux, use `yarn playwright install --with-deps chromium` to install browser system dependencies as well. Remix consumes the prebuilt engine package; these checks need no Rust toolchain or account credentials.

The dedicated Playwright configuration starts a fresh server on `127.0.0.1:8090`; leave that port free. It serves the compiler pinned by `yarn.lock` from a generated directory under `dist/apps/remix-ide/__monad-tests__` and supplies the installed Hardhat console library for imports. Each test starts with a fresh browser context and compiles its fixture for Cancun through the IDE. Normal Remix startup still fetches public configuration over the network.

All three environments (Monad Next, Monad Ten, and Ethereum Osaka) exercise deployment, constructor stepping, storage reads and writes, source highlighting, and decoded Solidity state. Monad Next also executes `CALLSTACKDEPTH` through a nested `STATICCALL`, checks instruction PCs `0` and `2`, and verifies stack values while stepping backward and forward. Fork-specific opcode rejection is covered by the provider integration suite.

The [NestedCalls.sol](../examples/NestedCalls.sol) fixture covers nested calls and failure paths. Provider tests check `CALLSTACKDEPTH` and `CALLERN` through `CALL`, `STATICCALL`, and `DELEGATECALL`, calldata and return decoding, delegated storage, caught and propagated reverts, out-of-gas, and invalid extensions. They also check descendant rollback, source call-tree boundaries, and preservation of engine gas costs. Browser tests select nested calls in the call tree and verify source highlighting, decoded storage, and navigation across a revert; Monad Next additionally navigates the raw-bytecode probe. The workflow runs existing Ethereum debugger and storage-decoder regressions alongside these checks.

Saved-state tests cover accounts and execution records, call-hash continuity, older version 1 saves, detached imports and exports, malformed state, and fresh resets. Browser scenarios on Monad Next and Ten use the existing state-fork and reset controls, reopen a saved session, debug a saved Solidity storage write, and execute a new transaction. See [save, reset and restore](state.md) for the persistence contract.

Solidity runner tests cover hooks, passing/failing assertions, reverted transactions, read-only results, sender/value annotations, and fork-specific opcode execution. Browser scenarios verify the existing plugin's results and Debug buttons, source stepping, decoded storage, and console output in the terminal. Provider tests also cover legacy console signatures, malformed payloads, console output after trace truncation, and save/restore compatibility.

Signing tests compare EIP-712 signatures with ethers and recover them through the WASM precompile. They cover object/JSON payloads, nested arrays, integer boundaries, domain separation, RPC errors, message bytes, and restored account keys. Browser scenarios run JavaScript and TypeScript files through the published Ethers v6 runner, use the file-explorer signing action, and debug script storage writes and opcode transactions on both Monad forks. Browser setup downloads a pinned, checksum-verified runner into `tmp/monad-script-runner`; later runs reuse the cached files. The runner's source revision and asset checksums are recorded in `tests/monad/script-runner.ts`.

[FactoryDeployments.sol](../examples/FactoryDeployments.sol) covers Remix's automatic library deployment and linking, `CREATE` and `CREATE2` child addresses, constructor arguments, value transfers, storage and events. Provider tests verify constructor reverts and address collisions leave no child state changes or logs, while their execution remains debuggable. Browser scenarios on both Monad forks attach a child through **Deployed Contracts → Add Contract** (the At Address workflow), execute its linked library, and navigate successful and reverted constructors with source highlighting and decoded storage.

[PrecompileCalls.sol](../examples/PrecompileCalls.sol) covers SHA-256, signature recovery, BN254, KZG, BLS12-381 and P-256 through the provider on both forks. Tests check known outputs, gas, return-data memory, source locations, simulation isolation and caught/propagated failures. Browser scenarios execute SHA-256 and P-256, catch invalid curve inputs and insufficient gas, and inspect a reverted caller write. Precompiles have no bytecode frame: instruction stepping stays in the caller across `STATICCALL`. The engine repository separately compares all stateless precompiles between native default crypto and the packed WASM package. The Monad CI job allows 45 minutes for the build and expanded browser suite.

The workflow uploads `monad-browser-results`, containing the HTML report and failure screenshots, browser diagnostics, and Playwright traces. Locally, use:

```sh
yarn playwright show-report playwright-report/monad
yarn playwright show-trace test-results/monad/<failed-test>/trace.zip
```

The general Playwright configuration excludes this suite because it needs its dedicated compiler and server setup. Browser tests exercise the built application; rebuild Remix after changing application or library code.
