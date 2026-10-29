# Local Monad VM for Remix

This experimental integration executes contracts through the prebuilt `monad-revmjs` WebAssembly package, inside Remix's existing VM Web Worker. The package owns execution and state; the TypeScript provider adapts results to Remix's transaction, account and debugger interfaces.

The Rust wrapper, its native tests, bindings and package build live on `category-labs/monad-revm`'s **main** branch in [`crates/monad-revmjs`](https://github.com/category-labs/monad-revm/tree/main/crates/monad-revmjs). Remix pins a complete commit from that repository's `monad-revmjs-preview` distribution branch in `package.json` and `yarn.lock`. The distribution contains a ready-to-use npm package; its `build-info.json` records the source commit and build inputs. This preview can later be replaced by an exact npm registry version without changing the provider API.

## Build and test

Use the repository's Node version and install its dependencies. Remix does not require Rust, Cargo or wasm-bindgen:

```sh
yarn install --frozen-lockfile
```

From the repository root:

```sh
yarn test:monad
yarn nx serve remix-ide
```

The integration suite also runs with `yarn test:libs`. To test the built IDE in Chromium, run `yarn nx build remix-ide --configuration=development`, `yarn playwright install chromium`, then `yarn test:monad:browser`. See [browser tests and CI](docs/testing.md) for coverage and failure diagnostics.

The dependency supplies the WASM module, JavaScript loader and TypeScript declarations. The module is loaded on demand when a Monad environment is selected; the bundler emits its WASM asset. The provider uses the package's exported request and result types.

For engine changes, build and test `crates/monad-revmjs` in the engine repository, update the package pin, then rerun this integration's tests. Normal Remix builds consume the package without rebuilding it.

## Try the complete flow

1. Open the local Remix server, normally `http://localhost:8080`.
2. Copy [MonadDemo.sol](examples/MonadDemo.sol) into the Remix workspace. Compile it with Solidity 0.8.24 or newer, targeting Cancun.
3. In **Deploy & Run**, select **Monad Next (experimental)** and the **MonadDemo** contract, then deploy it.
4. Call `store(42)`. Read `value()` to confirm `42`. Use the transaction's **Debug** button to step through the Solidity storage assignment and inspect stack, memory and storage.
5. Call `recordDepth()`. Read `value()` again; it should be `1`. Debug this transaction, select the `recordDepth` call, open **Stack & Memory**, and expand **opcode** to enable instruction stepping. Select the nested `STATICCALL` in the execution trace and use **Step Into**. The oracle's first instruction is `CALLSTACKDEPTH` at PC `0`; the following `PUSH0` is at PC `2`.
6. Use backward/forward navigation to inspect the recorded execution. The parent contract has Solidity source maps. The small oracle uses raw bytecode and is debugged at the instruction level.

The constructor deploys an eight-byte oracle with runtime `ae005f5260205ff3`. `AE 00` is one extension instruction. It returns depth zero at the root of execution and one when called from `MonadDemo`. Solidity does not need to recognize a new builtin to deploy this bytecode.

**Monad Ten** is also available. It executes ordinary Solidity contracts but rejects the extension when `recordDepth()` reaches the oracle. **Monad Next** enables `CALLSTACKDEPTH` and `CALLERN` according to the pinned engine revision; it is explicitly experimental.

## Execution and debugging boundary

```text
Remix deploy / call / debug
  -> existing worker message protocol
  -> MonadProvider (local JSON-RPC and history)
  -> monad-revmjs package (JavaScript bindings and WASM)
  -> Engine (monad-revm, in-memory database and inspector)
```

The package API provides account funding and reads, execution with or without commit, block hashes, and versioned snapshot export/import. Inputs use JSON with exact hex quantities for 256-bit values. Remix supplies the local block gas limit, base fee, beneficiary and prevrandao explicitly. The provider serializes requests so transactions cannot race over nonces or state.

Execution returns status, return data, logs, created address, gas accounting and optional instruction traces. Traces contain the state **before** each instruction, real bytecode PCs, stack, memory, call depth, gas cost, and errors. Debugger changes preserve the two-byte extension encoding and its stack effects. Monad Ten and Next traces identify their specification explicitly.

Both debugger decoders explicitly map `monad-ten` and `monad-next` to EthereumJS's Osaka opcode baseline, matching `MonadHardfork::into_eth_spec` in `monad-revm`. The original Monad fork controls extension decoding; execution, gas accounting and state remain in Rust/WASM. Other fork names pass through EthereumJS validation, so unsupported Monad forks are rejected.

This local chain has ID **1337**, five funded development accounts with **100 MON** each, a 30 million transaction gas cap and zero base fee. Transactions support legacy, EIP-2930 access lists, EIP-1559 and EIP-7702 delegation. These are local simulation settings, not public Monad network configuration.

Monad charges the submitted transaction gas limit. Receipts use `tx_gas_used()`; consumption uses `total_gas_spent()`. Estimation searches for a successful gas limit without committing state. Gas-sensitive contracts can be non-monotonic, so estimation is not a guarantee that a different future state will execute identically.

State export contains the engine snapshot, local development keys, blocks, receipts, execution history and call metadata. Restore validates saved state and preserves debugging records; reset creates a fresh engine. See [save, reset and restore](docs/state.md) for saved-state compatibility.

The Solidity Unit Testing plugin uses the selected Monad VM. Test results and contract executions include Hardhat console output, and test transactions and simulated calls can be opened in the debugger. See [Solidity tests and console output](docs/unit-testing.md).

JavaScript and TypeScript scripts use the selected Monad provider through Remix's Ethers v6 runner. The provider supports message and EIP-712 signing, including the file explorer's signing action. See [scripts and signing](docs/scripts-and-signing.md) for examples and debugging instructions.

The account menu's existing delegation controls also work on both Monad forks. See [typed transactions and delegation](docs/transactions.md) for access lists, signed transactions, reserve rules and debugging after revocation.

Local staking workflows support explicit epoch transitions and validator rewards. See [staking](docs/staking.md) for the runnable example, setup controls and debugging across save/reset/restore.

Contract calls and estimates can use retained local blocks, with historical state, block context and debugging. See [historical calls](docs/historical-calls.md) for block selectors and the runnable Ethers example.

Event queries and polling filters support Ethers listeners through the script runner. See [events and polling filters](docs/events.md) for query semantics, listener cleanup, saved history and debugging event emission.

[FactoryDeployments.sol](examples/FactoryDeployments.sol) exercises linked libraries and child contracts. Deploy `FactoryDeployments` to have Remix deploy and link `LinkedValues`, then use `create` or `create2` to deploy a child. Select `FactoryChild`, open **Deployed Contracts → Add Contract**, and enter `lastChild()`'s address to interact with it. Debug the factory transaction to inspect its child constructor, or call `storeWithLibrary` on the child and debug its library call. `rejectCreate2` catches a constructor revert, leaving its failed execution available in the debugger.

## Current coverage and limits

Native Rust and packed-installation tests live with `monad-revmjs`. This repository's WASM integration tests consume the installed package, compile the example with solc and exercise the provider through ethers and Remix's debugger, including source-map indexing, nested calls, symbolic stack effects, call debugging, history, signed transactions and trace limits.

This is the first local execution and debugging slice. Remaining work includes:

- Remote RPC forking and canonical replay context, including remote reserve-balance metadata and staking system inputs.
- Routing the Remix test CLI to this backend. Blob transactions remain unsupported by Monad.
- A custom compiler or native Solidity syntax for extension instructions. Raw-bytecode examples have no Solidity source map for the extension itself.
- Production persistence and memory management. Each trace is capped at 100,000 steps or approximately 32 MiB, and incomplete traces fail explicitly. Local history retains snapshots and traces until reset; aggregate history is not yet bounded.
- Cancellation and registry release automation. Native/WASM parity covers stateless precompiles and local staking; [Remix debugging tests](docs/testing.md) run on both Monad forks. Canonical system-transition scheduling remains outside the local simulator.

Blocks and receipts are synthetic local records. State, transaction and receipt roots and blooms are placeholders; they are not cryptographic proofs or full-node RPC equivalents. Calls have separate synthetic records for debugging and do not alter canonical local blocks or committed state. Unsupported RPC methods return an explicit error.
