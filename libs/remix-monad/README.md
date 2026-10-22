# Local Monad VM for Remix

This experimental integration executes contracts in `monad-revm` compiled to WebAssembly, inside Remix's existing VM Web Worker. The Rust wrapper owns execution and state; the TypeScript provider adapts results to Remix's transaction, account and debugger interfaces.

The engine is pinned to commit `eee0ba8ddb7c5f432d8cfb999d558502a7ae491c` from `category-labs/monad-revm` **main**. Keep the engine checkout on `main` and update the pinned revision deliberately with regression checks. The wrapper lives here so integration work does not require modifications to the engine repository.

## Build and test

Use the repository's Node version and install its dependencies. Install the Rust toolchain, browser target and matching binding generator once:

```sh
rustup toolchain install 1.91
rustup target add wasm32-unknown-unknown --toolchain 1.91
cargo +1.91 install wasm-bindgen-cli --version 0.2.128 --locked
yarn install --frozen-lockfile
```

From the repository root:

```sh
yarn build:monad
cargo +1.91 test --manifest-path libs/remix-monad/wasm/Cargo.toml --locked
yarn test:monad
yarn nx serve remix-ide
```

`build:monad` creates the ignored `pkg/` directory containing the WASM module, JavaScript loader and TypeScript declarations. The Nx dependency graph also builds this package when building or serving Remix. Commit the Rust lockfile; do not commit generated bindings or binaries. The WASM module is loaded on demand when a Monad environment is selected.

On macOS, Rust linking requires a working Xcode Command Line Tools SDK. If the selected SDK has linker compatibility problems, select a compatible installed SDK through `SDKROOT` for the build commands.

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
  -> wasm-bindgen bindings
  -> Engine (monad-revm, in-memory database and inspector)
```

The Rust API provides account funding and reads, execution with or without commit, block hashes, and versioned snapshot export/import. Inputs use JSON with exact hex quantities for 256-bit values. The provider serializes requests so transactions cannot race over nonces or state.

Execution returns status, return data, logs, created address, gas accounting and optional instruction traces. Traces contain the state **before** each instruction, real bytecode PCs, stack, memory, call depth, gas cost, and errors. Debugger changes preserve the two-byte extension encoding and its stack effects. Monad Ten and Next traces identify their specification explicitly.

This local chain has ID **1337**, five funded development accounts with **100 MON** each, a 30 million transaction gas cap and zero base fee. Transactions support legacy and EIP-1559 formats. These are local simulation settings, not public Monad network configuration.

Monad charges the submitted transaction gas limit. Receipts use `tx_gas_used()`; consumption uses `total_gas_spent()`. Estimation searches for a successful gas limit without committing state. Gas-sensitive contracts can be non-monotonic, so estimation is not a guarantee that a different future state will execute identically.

State export contains the engine snapshot, local development keys, blocks, receipts and recorded execution history. Restore validates the engine version, chain ID and specification. Remix's environment reset creates a new engine or restores the chosen snapshot.

## Current coverage and limits

Native Rust tests cover deployment, simulation, committed and reverted storage, full-limit charging, snapshot restore, hardfork gating, both extension instructions and SHA256. The WASM integration tests compile the example with solc and exercise the provider through ethers and Remix's debugger, including source-map indexing, nested calls, symbolic stack effects, call debugging, history, signed transactions and trace limits.

This is the first local execution and debugging slice. Remaining work includes:

- Remote RPC forking, historical `eth_call`, and canonical replay context, including reserve-balance metadata and staking system inputs.
- Access-list, authorization and blob transaction workflows; Hardhat console decoding; routing Remix Solidity unit tests and the CLI to this backend.
- A custom compiler or native Solidity syntax for extension instructions. Raw-bytecode examples have no Solidity source map for the extension itself.
- Production persistence and memory management. Each trace is capped at 100,000 steps or approximately 32 MiB, and incomplete traces fail explicitly. Local history retains snapshots and traces until reset; aggregate history is not yet bounded.
- Broader precompile and nested-call conformance tests, cancellation, and package release CI.

Blocks and receipts are synthetic local records. State, transaction and receipt roots and blooms are placeholders; they are not cryptographic proofs or full-node RPC equivalents. Calls have separate synthetic records for debugging and do not alter canonical local blocks or committed state. Unsupported RPC methods return an explicit error.

See the [five-area integration plan](../../docs/MONAD-WASM-INTEGRATION.md) for the remaining project scope.
