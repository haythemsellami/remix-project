# Debugging history and saved state

The Monad provider retains debugging data for at most **100 executions** and **64 MiB** by default. Transactions and simulated calls share this budget. The byte count is the sum of each serialized `[hash, record]` entry in UTF-8, including its trace, KECCAK preimages, and before/after engine snapshots.

Entries expire in execution order. Reading a trace does not extend its lifetime. An execution larger than the byte budget is not retained and does not displace smaller entries. Retention does not change whether a transaction commits, reverts, or runs out of gas. The engine's existing per-trace limit still applies separately.

Embedding code can pass `historyLimits: { maxEntries, maxBytes }` to `MonadProvider`; omitted values use the defaults. Zero disables retention. These are provider options, not new Remix settings. Importing saved state always reapplies the current provider limits.

## What remains available

Eviction removes the trace, hash preimages, and historical snapshots together. Current account balances, nonces, code and storage remain in the engine. Blocks, transaction/call records, receipts, logs, and execution summaries remain available.

`debug_traceTransaction` and `debug_storageRangeAt` return an explicit history-limit error for an expired execution. Historical account reads also fail explicitly once their block's snapshot expires. `debug_preimage` searches retained history and returns `null` when the requested preimage is unavailable. An unknown transaction remains distinct from a known transaction with expired debugging data.

This bounds retained debugging payloads, not total browser memory: current chain state, transaction metadata, transient execution/serialization buffers, and copies held by the UI or callers have separate lifetimes.

## Save, reset and restore

Remix's existing state saving, named state forks, and environment reset controls work with this provider. Version 2 saves separate execution metadata from retained debugging history and preserve call tags and the synthetic-call counter. Version 1 saves are imported and migrated; newly saved files use version 2.

Restore validates the backend, format version, Monad specification, chain ID, account keys, and history references before replacing engine state. The provider releases its reference to the imported object after initialization and exports detached data. Only history within the current budget remains retained after restore.

A fresh environment resets accounts to their initial funding and clears contracts, transactions, call tags and debugging history. Restoring a saved environment recovers its account keys, committed state, receipts and retained debugging data; new executions continue from the saved nonces and call counter.
