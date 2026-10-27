# Typed transactions and delegation

Both Monad environments support transaction types 0, 1, 2 and 4 through `eth_sendTransaction`, `eth_sendRawTransaction`, `eth_call` and `eth_estimateGas`. Access lists and signed authorization tuples reach Rust unchanged in meaning; the engine validates and executes them. Transaction responses retain their type and lists. Calls and estimates leave committed state unchanged.

Compile [DelegatedAccount.sol](../examples/DelegatedAccount.sol) for Cancun and deploy it. In the selected account's menu, choose **Authorize Delegation** and enter the implementation address. Remix adds a delegated instance to **Deployed Contracts**. Call `store(42)` there: storage and events belong to the account, while the implementation supplies the code. Remove delegation using the account's delegation badge.

[delegated-transactions.js](../examples/delegated-transactions.js), run with Ethers v6 after compilation, signs and submits a type-4 transaction, a type-1 access-list transaction, a reverted call and a revocation. It prints the transaction hashes for debugging. The fixture exposes unrestricted methods for local testing.

Monad traces record the executed runtime code, so source highlighting and storage inspection remain available after delegation changes and after save/restore. Simulated authorizations can also be debugged without installing code in committed state. The recorded code is used only for Monad traces; ordinary `eth_getCode` still returns the requested account state.

Authorization processing precedes contract execution: an applied delegation and its nonce increment survive a caller revert, while execution writes and events roll back. Invalid signatures, wrong-chain tuples and stale nonces follow the engine's EIP-7702 skip rules. Malformed transaction envelopes are rejected atomically.

The provider supplies senders and recovered authorities from the local parent and grandparent blocks, and any preceding transaction for a simulated call in the current block. This preserves reserve enforcement after revocation and restoration. Delegated account code cannot execute `CREATE` or `CREATE2`; reserve violations and these failures remain inspectable. These are synthetic local blocks; remote canonical replay and staking transitions need additional integration.
