# Save, reset and restore

The Monad provider uses Remix's existing state saving, named state forks, and environment reset controls. Saved state includes local account keys, the engine snapshot, blocks, receipts, and full execution records with traces, hash preimages, and before/after snapshots.

Version 1 remains the saved-state format. New saves also include call tags and the synthetic-call counter, so simulated calls remain discoverable by tag and subsequent calls get distinct hashes after restore. Older version 1 saves without these fields remain readable: their execution records are preserved, their missing tags cannot be recovered, and the call counter starts above the recorded call count.

Restore validates the backend, version, Monad specification, chain ID, account keys, execution records, and their references before replacing engine state. Invalid imports leave the provider uninitialized and the engine unchanged. Imported and exported records are detached from live provider data.

A fresh environment restores the default accounts and funding and clears contracts, transactions, call tags, and debugging data. A saved environment restores its account keys, committed state, and execution records; new transactions continue from the saved nonces.

Execution records stay available for the lifetime of the session and are included in saves. The engine's existing per-trace limit still applies: incomplete traces fail explicitly when debugging is requested.
