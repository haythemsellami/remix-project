# Historical calls

Compile [HistoricalCalls.sol](../examples/HistoricalCalls.sol), then run
[historical-calls.js](../examples/historical-calls.js) with Remix's Ethers v6 runner
on Monad Ten or Monad Next. The script stores `1` and then `2`, simulates a write
against the earlier block, and prints successful and reverted call hashes for
the debugger. The live value stays `2`.

`eth_call`, `eth_estimateGas`, and balance, code, nonce and storage reads accept
local block numbers, `earliest`, `latest`, `pending`, `safe`, and `finalized`.
They also accept [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898) references:

```js
await provider.send('eth_call', [transaction, { blockHash, requireCanonical: true }])
await provider.send('eth_call', [transaction, { blockNumber: '0x2' }])
await contract.simulate.staticCall(1, 11, { blockTag: 2 })
```

Choose exactly one of `blockHash` and `blockNumber`. `requireCanonical` is an
optional boolean for hash references. All retained local blocks are canonical;
the simulator has no reorgs or consensus finality. `safe` and `finalized` resolve
to the latest local block. Raw hash strings remain supported for compatibility.
Unknown blocks return `-32001`; malformed selectors return `-32602`. Synthetic
call hashes identify debugging records, not selectable canonical blocks.

Calls default to `latest`: the selected block's post-state, number, timestamp,
gas limit, fee fields, beneficiary, randomness and available ancestor hashes.
Reserve-balance decisions use participants from that block and its two ancestors.
This includes empty staking transition blocks and historical EIP-7702 delegation.

`pending` uses current state with the next local block number and a timestamp
at least as recent as the latest block. This VM mines each sent transaction
immediately and has no pending transaction pool. Gas estimation defaults to this
next-block context, as before; pass a selector to estimate at a retained block.
Future transactions can observe a later timestamp or different state.

Simulations restore live state even when execution or validation fails. Calls
retain separate debugging records, including failed calls; estimates retain none.
Simulated fees, nonce changes, storage writes and logs never enter committed state
or canonical block history. State and block overrides are unsupported.

Saved sessions preserve historical states and call traces. Source highlighting,
forward/backward stepping and storage decoding use the call's actual pre-state
and executed code, including delegation removed from the current state. Reset
clears local history; restoring a saved session makes it available again.

This API uses retained local history. Fetching state or replaying transactions
from a remote Monad chain is a separate feature.
