# Save, reset and restore

The Monad provider uses Remix's existing state saving, named state forks, and environment reset controls. Saved state includes local account keys, the engine snapshot, blocks, receipts, and full execution records with traces, hash preimages, and before/after snapshots.

With **Save environment state** enabled, Remix writes `.states/vm-monad-ten/state.json` or `.states/vm-monad-next/state.json` in the current workspace. After a reload, select the same environment to restore it. Compile the saved source and use **Add Contract** with its address to resume interaction; saved transaction hashes can also be entered in the debugger. Polling filters belong to the previous worker session and must be recreated.

Disabling the setting leaves existing state files unchanged and starts a fresh VM on reload. Re-enabling it allows the last saved state to load again; transactions made while saving was disabled are absent from that file.

Version 1 remains the saved-state format. New saves also include call tags and the synthetic-call counter, so simulated calls remain discoverable by tag and subsequent calls get distinct hashes after restore. Older version 1 saves without these fields remain readable: their execution records are preserved, their missing tags cannot be recovered, and the call counter starts above the recorded call count.

Restore validates the backend, version, Monad specification, chain ID, account keys, execution records, and their references before replacing engine state. Invalid imports leave the provider uninitialized and the engine unchanged. Imported and exported records are detached from live provider data.

Historical calls use the selected block's saved post-state and execution context. Their debugging records preserve that historical pre-state even after later writes, staking transitions or delegation changes. Block timestamps and execution context are validated during import; the saved-state version remains 1. See [historical calls](historical-calls.md).

Staking saves also include `stakingTransitions`, keyed by the hash of each empty local transition block. Each record retains its action, result and before/after snapshots. Older version 1 saves may omit the field. Restore validates transition records and block references; epoch state, rewards and pending withdrawals live in the engine snapshot. Development balances set before the first execution remain readable at genesis after restore.

A fresh environment restores the default accounts and funding and clears contracts, transactions, call tags, and debugging data. A saved environment restores its account keys, committed state, and execution records; new transactions continue from the saved nonces.

Execution records stay available for the lifetime of the session and are included in saves. The engine's existing per-trace limit still applies: incomplete traces fail explicitly when debugging is requested.
