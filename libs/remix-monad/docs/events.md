# Events and polling filters

Compile [EventQueries.sol](../examples/EventQueries.sol), select either local Monad
fork, and run [event-listeners.js](../examples/event-listeners.js) with Ethers v6.
The script listens with `on` and `once`, decodes indexed arguments, removes its
listener with `off`, and queries earlier events with `queryFilter`. It also checks
that reverted transactions and simulated calls do not publish events.

## Queries

`eth_getLogs` accepts one filter object. `fromBlock` and `toBlock` default to
`latest`; use `fromBlock: 'earliest'` to include all retained history. Earlier
preview versions implicitly started at genesis when `fromBlock` was omitted.
Ranges are inclusive and accept exact hex quantities, `earliest`, `latest`, `safe`,
`finalized`, and `pending`. In this local chain, safe/finalized mean the latest
committed block. There is no pending log pool: a pending lower bound has no results,
and a pending upper bound includes committed blocks only. Future numeric bounds
are allowed; queries return only blocks that already exist.

Alternatively, specify one canonical local `blockHash`, without a block range.
Unknown hashes return an error, including synthetic block hashes used for debugging
simulated calls. Malformed addresses, hashes, topics, ranges and method parameters
return invalid-parameter errors.

`address` accepts one address or an array. Topics match by position, with OR arrays
within a position and `null` or an empty array as a wildcard. A wildcard still
requires that topic position to exist, so `[null]` excludes anonymous `LOG0` events.
Hex matching is case-insensitive. Results are detached copies in block/transaction/log
order. Only logs from committed transactions are queried; reverted frames and
simulations contribute no published logs. Explicit staking system transitions
remain separate records, without transaction receipts.

## Polling

- `eth_newFilter(filter)` creates a log filter.
- `eth_newBlockFilter()` creates a filter for newly committed block hashes,
  including empty blocks and blocks containing failed transactions.
- `eth_getFilterChanges(id)` returns matches committed since creation or the last
  poll. It never backfills earlier blocks and consumes only that filter's cursor.
- `eth_getFilterLogs(id)` repeats the original log query without consuming the
  cursor. Use an explicit lower bound for historical results; `latest` is evaluated
  at query time. This method accepts log filters only.
- `eth_uninstallFilter(id)` removes a filter and returns whether it existed.

The lower tag used for incremental delivery is anchored when the filter is created,
so delayed polling includes all intervening matching blocks. Fixed numeric upper
bounds stop delivery at that block. Ethers listeners use these RPC methods through
the existing Remix script runner; listener removal uninstalls its filter.

Filters live until uninstalled or the provider is replaced. They are session state
and are excluded from saved snapshots. Reset clears event history; restoring a saved
environment restores its committed logs, but clients must create new filters and
listeners. Old IDs cannot address filters in the replacement session. This interface
uses polling; push subscriptions and pending-transaction filters are not implemented.

## Debugging and tests

The provider tests execute the installed WASM package on both forks and cover
query validation, matching, polling, listener cleanup, rollback and restore. Browser
tests run the script in Remix, save/reset/restore through the environment controls,
then debug successful and reverted `LOG3` instructions with source highlighting,
decoded storage, and forward/backward stepping. They verify that the reverted
instruction remains debuggable while its log is absent from event queries.

Run `yarn test:monad` for provider tests. After building the IDE, run
`yarn test:monad:browser tests/monad/events.spec.ts` for the browser scenarios.
