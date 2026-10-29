# Staking in the local Monad VM

Select **Monad Ten** or **Monad Next**, compile [StakingDemo.sol](../examples/StakingDemo.sol),
then run [staking-workflow.js](../examples/staking-workflow.js) with the Ethers v6 runner
in a fresh VM. The script funds a local account, registers a validator, delegates,
advances epochs, claims rewards and withdraws. It also exercises an early withdrawal
and a reverted caller. Its final terminal line includes the contract address and
transaction hashes for the debugger.

These are explicit local controls, available only through the Monad provider:

```js
await provider.send('monad_setBalance', [account, ethers.toQuantity(ethers.parseEther('30000000'))])
await provider.send('monad_stakingTransition', [{ kind: 'snapshot' }])
await provider.send('monad_stakingTransition', [{ kind: 'epochChange', epoch: '0x1' }])
await provider.send('monad_stakingTransition', [{ kind: 'reward', author, amount: '0xde0b6b3a7640000' }])
```

Balance setup accepts an existing local account before the first execution only.
Reset the VM to repeat setup. Default accounts still start with 100 MON; validator
setup needs a larger balance. Epochs and reward amounts use exact hex strings.

The Rust engine applies transitions and mints the backing reward balance atomically.
Failed requests leave both state and local history unchanged. Each successful
transition creates an empty local block and returns its hash, number, result and
system logs. It has no user transaction, fee, nonce increment or instruction trace.
System logs remain in the transition result and saved history; `eth_getLogs` returns
ordinary transaction logs. Transition timing is explicit, not a simulation of the
network's consensus scheduler.

All staking methods, including getters, require `CALL`. Use `eth_call` or Ethers
`contract.epoch.staticCall()` to simulate the Solidity caller without committing;
the Solidity implementation still uses `CALL`, not `STATICCALL`.

Debug the script's transaction hashes through Remix's debugger. Instruction stepping
stays in `StakingDemo` across the staking precompile call, with source highlighting,
return data and caller storage. Precompile internals have no EVM bytecode to step
through. The caught early withdrawal is a successful caller transaction; the later
`rejectAfterStake` transaction fails and rolls back its staking changes.

The existing state-fork and reset controls preserve staking storage, epoch state,
transition records and earlier transaction traces. Historical balance reads include
transition blocks; after restoring a saved session, another epoch can be applied.

The native engine still skips `addValidator` signature verification and uses
simplified key lookups, including `authAddress` as the reward author. The example
intentionally uses unverified signatures and local funds. It is not a public-network
validator registration example.
