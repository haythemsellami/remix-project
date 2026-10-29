import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import solc from 'solc'
import { BrowserProvider, Interface, Wallet, hexlify, parseEther, toQuantity, ZeroAddress, ZeroHash } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider } from '../src/provider'
import { RpcError } from '../src/types'
/* eslint-disable @nrwl/nx/enforce-module-boundaries -- Validate historical calls with the IDE debugger. */
import { extendProvider } from '../../remix-debug/src/init'
import { Ethdebugger } from '../../remix-debug/src/Ethdebugger'
import { CompilerAbstract } from '@remix-project/remix-solidity'
import { convertOffsetToLineColumn, getLinebreakPositions } from '../../remix-debug/src/source/sourceMappingDecoder'
/* eslint-enable @nrwl/nx/enforce-module-boundaries */

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const file = 'HistoricalCalls.sol'
const source = readFileSync(`libs/remix-monad/examples/${file}`, 'utf8')
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [file]: { content: source } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'], '': ['ast'] } } }
})))
assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), [])
const artifact = compiled.contracts[file].HistoricalCalls
const abi = new Interface(artifact.abi)

async function fixture(fork: 'monad-ten' | 'monad-next', stateDb?: unknown) {
  const engine = new Engine(fork, 1337)
  const local = new MonadProvider({ fork, stateDb }, engine)
  try { await local.init() } catch (error) { engine.free(); throw error }
  const request = (method: string, ...params: any[]) => local.request({ method, params })
  const [from, authority, recipient] = await request('eth_accounts')
  const web3 = new BrowserProvider(local, undefined, { cacheTimeout: -1 })
  extendProvider(web3)
  const send = async (input: any) => {
    const hash = await request('eth_sendTransaction', { from, gas: '0x2dc6c0', ...input })
    const receipt = await request('eth_getTransactionReceipt', hash)
    assert.equal(receipt.status, '0x1')
    return receipt
  }
  const invoke = (address: string, method: string, args: any[] = []) => send({ to: address, data: abi.encodeFunctionData(method, args) })
  const call = async (address: string, selector: any = 'latest', method = 'read', args: any[] = []) => {
    const output = await request('eth_call', { from, to: address, data: abi.encodeFunctionData(method, args) }, selector)
    return Array.from(abi.decodeFunctionResult(method, output))
  }
  const debug = async (hash: string) => {
    const compilation = new CompilerAbstract('json', compiled, { target: file, sources: { [file]: { content: source } } })
    const instance = new Ethdebugger({ web3, compilationResult: async () => compilation,
      offsetToLineColumnConverter: { offsetToLineColumn: async location => convertOffsetToLineColumn(location, getLinebreakPositions(source)) } })
    const ready = new Promise<void>((resolve, reject) => {
      instance.callTree.event.register('callTreeReady', () => resolve())
      instance.callTree.event.register('callTreeBuildFailed', reject)
      instance.callTree.event.register('callTreeNotReady', reject)
    })
    await instance.debug((await web3.getTransaction(hash)).toJSON())
    await ready
    return instance
  }
  return { engine, local, request, web3, from, authority, recipient, send, invoke, call, debug,
    deploy: async () => (await send({ data: '0x' + artifact.evm.bytecode.object })).contractAddress as string,
    save: () => request('eth_getStateDb'), close: () => { web3.destroy(); engine.free() } }
}

async function inspect(f: Awaited<ReturnType<typeof fixture>>, hash: string, before: bigint, after: bigint) {
  const debug = await f.debug(hash)
  const steps = debug.getTrace()
  const store = steps.findIndex(step => step.op === 'SSTORE')
  assert.ok(store >= 0)
  const location = await debug.callTree.extractSourceLocation(store) as { start: number; length: number }
  assert.match(source.slice(location.start, location.start + location.length), /value = /)
  const value = async index => {
    const decoded = await debug.decodeStateAt(index, await debug.extractStateAt(index)) as any
    return BigInt(decoded.value.value)
  }
  assert.equal(await value(store), before)
  assert.equal(await value(store + 1), after)
  assert.equal(await value(store), before, 'backward navigation uses the historical pre-state')
  assert.equal(await value(steps.length - 1), after)
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: calls and estimates use the selected state, timestamp and block hashes`, async context => {
    let now = 1_800_000_000_000
    context.mock.method(Date, 'now', () => now)
    const f = await fixture(fork)
    try {
      const address = await f.deploy()
      now += 10_000
      const a = await f.invoke(address, 'store', [1])
      const blockA = await f.request('eth_getBlockByNumber', a.blockNumber, false)
      now += 10_000
      const b = await f.invoke(address, 'store', [2])
      const blockB = await f.request('eth_getBlockByHash', b.blockHash, false)
      now += 90_000
      const original = await f.save()
      for (const selector of [a.blockNumber, a.blockHash, { blockNumber: a.blockNumber }, { blockHash: a.blockHash },
        { blockHash: a.blockHash, requireCanonical: true }, { blockHash: a.blockHash.toUpperCase().replace('0X', '0x'), requireCanonical: false }]) {
        assert.deepEqual(await f.call(address, selector), [1n, BigInt(a.blockNumber), BigInt(blockA.timestamp), blockA.parentHash])
        assert.equal(BigInt(await f.request('eth_getStorageAt', address, ZeroHash, selector)), 1n)
        assert.equal(await f.request('eth_getCode', address, selector), '0x' + artifact.evm.deployedBytecode.object)
        assert.equal(await f.request('eth_getTransactionCount', f.from, selector), '0x2')
        assert.equal(await f.request('eth_getBalance', f.from, selector), JSON.parse(original.executions.find(([id]) => id === a.transactionHash)[1].after).accounts[f.from.toLowerCase()].balance)
      }
      for (const selector of [undefined, 'latest', 'safe', 'finalized', b.blockNumber, { blockHash: b.blockHash }]) {
        assert.deepEqual(await f.call(address, selector), [2n, BigInt(b.blockNumber), BigInt(blockB.timestamp), blockB.parentHash])
      }
      const pending = await f.request('eth_getBlockByNumber', 'pending', false)
      assert.equal(pending.hash, null)
      assert.equal(BigInt(pending.number), BigInt(b.blockNumber) + 1n)
      assert.deepEqual(await f.call(address, 'pending'), [2n, BigInt(pending.number), BigInt(now / 1000), b.blockHash])
      now = Number(BigInt(blockA.timestamp)) * 1000
      assert.deepEqual(await f.call(address, 'pending'), [2n, BigInt(pending.number), BigInt(blockB.timestamp), b.blockHash], 'pending timestamps cannot move backwards')
      for (const selector of ['earliest', '0x0', { blockHash: original.blocks[0].hash }]) {
        assert.equal(await f.request('eth_call', { to: address, data: abi.encodeFunctionData('read') }, selector), '0x')
        assert.equal(await f.request('eth_getCode', address, selector), '0x')
        assert.equal(await f.request('eth_getTransactionCount', f.from, selector), '0x0')
      }
      const input = { from: f.from, to: address, data: abi.encodeFunctionData('simulate', [1, 11]) }
      const beforeEstimates = await f.save()
      const gas = await f.request('eth_estimateGas', input, { blockHash: a.blockHash })
      assert.ok(BigInt(gas) > 21000n)
      assert.equal(await f.request('eth_call', { ...input, gas }, a.blockNumber), abi.encodeFunctionResult('simulate', [11, BigInt(a.blockNumber), BigInt(blockA.timestamp), blockA.parentHash]))
      await assert.rejects(f.request('eth_estimateGas', input, 'latest'), /revert/)
      const contextual = { ...input, data: abi.encodeFunctionData('requireContext', [BigInt(a.blockNumber), BigInt(blockA.timestamp), blockA.parentHash]) }
      await f.request('eth_estimateGas', contextual, a.blockNumber)
      await assert.rejects(f.request('eth_estimateGas', contextual), /revert/)
      await f.request('eth_estimateGas', { ...input, data: abi.encodeFunctionData('simulate', [2, 22]) })
      const after = await f.save()
      assert.equal(after.engine, original.engine)
      assert.deepEqual(after.blocks, original.blocks)
      assert.deepEqual(after.stakingTransitions, original.stakingTransitions)
      assert.equal(after.executions.length, beforeEstimates.executions.length + 1, 'estimates do not retain executions')
      assert.equal(after.callCounter, beforeEstimates.callCounter + 1)
      const exposed = await f.request('eth_getBlockByNumber', a.blockNumber, true)
      exposed.timestamp = '0x0'
      exposed.transactions[0].from = ZeroAddress
      assert.deepEqual(await f.request('eth_getBlockByNumber', a.blockNumber, false), blockA)
      assert.notEqual((await f.request('eth_getTransactionByHash', a.transactionHash)).from, ZeroAddress)
    } finally { f.close() }
  })

  test(`${fork}: historical success and revert debugging survive save, reset and restore`, async () => {
    const f = await fixture(fork)
    let restored: Awaited<ReturnType<typeof fixture>>
    try {
      const address = await f.deploy()
      const a = await f.invoke(address, 'store', [1])
      await f.invoke(address, 'store', [2])
      const current = f.engine.snapshot()
      await f.request('eth_registerCallId', 'historical-success')
      assert.equal((await f.call(address, { blockHash: a.blockHash }, 'simulate', [1, 11]))[0], 11n)
      const success = await f.request('eth_getHashFromTagBySimulator', 'historical-success')
      const callBlock = (await f.request('eth_getTransactionReceipt', success)).blockHash
      await assert.rejects(f.call(address, { blockHash: callBlock }), /Unknown local block/, 'debugging records are not canonical blocks')
      await f.request('eth_registerCallId', 'historical-revert')
      await assert.rejects(f.call(address, a.blockNumber, 'reject'), error => error instanceof RpcError && error.code === 3 && error.data === abi.encodeErrorResult('Rejected', [1]))
      const reverted = await f.request('eth_getHashFromTagBySimulator', 'historical-revert')
      assert.equal(f.engine.snapshot(), current)
      assert.equal((await f.request('eth_getLogs', { fromBlock: 'earliest' })).length, 2, 'simulated logs do not enter canonical history')
      await inspect(f, success, 1n, 11n)
      await inspect(f, reverted, 1n, 99n)
      const beforeInvalid = f.engine.snapshot()
      await assert.rejects(f.request('eth_call', { to: address, nonce: 999, data: abi.encodeFunctionData('read') }, a.blockNumber), /validation failed/)
      assert.equal(f.engine.snapshot(), beforeInvalid)
      const saved = await f.save()
      const reset = await fixture(fork)
      try {
        await assert.rejects(reset.call(address, a.blockNumber), /Unknown local block/)
        await assert.rejects(reset.request('debug_traceTransaction', success), /Unknown local transaction/)
      } finally { reset.close() }
      restored = await fixture(fork, saved)
      assert.deepEqual(await restored.save(), saved)
      for (const hash of [success, reverted]) assert.deepEqual(await restored.request('debug_traceTransaction', hash), await f.request('debug_traceTransaction', hash))
      await inspect(restored, success, 1n, 11n)
      await inspect(restored, reverted, 1n, 99n)
      assert.equal((await restored.call(address, a.blockNumber))[0], 1n)
      assert.equal((await restored.call(address))[0], 2n)
      await restored.invoke(address, 'store', [3])
      assert.equal((await restored.call(address, a.blockNumber))[0], 1n)
      assert.equal((await restored.call(address))[0], 3n)
    } finally { restored?.close(); f.close() }
  })

  test(`${fork}: historical delegation and reserve context remain available after revocation`, async () => {
    const f = await fixture(fork)
    let restored: Awaited<ReturnType<typeof fixture>>
    try {
      await f.request('monad_setBalance', f.authority, toQuantity(parseEther('12')))
      const target = await f.deploy()
      const wallet = new Wallet(hexlify(await f.request('eth_getPKey', f.authority)))
      const authorize = async address => wallet.authorize({ address, chainId: 1337, nonce: Number(BigInt(await f.request('eth_getTransactionCount', f.authority))) })
      const delegated = await f.send({ to: f.authority, type: 4, authorizationList: [await authorize(target)], data: abi.encodeFunctionData('store', [1]) })
      await f.invoke(f.authority, 'store', [2])
      const revoked = await f.send({ to: f.authority, type: 4, authorizationList: [await authorize(ZeroAddress)] })
      const spend = { from: f.authority, to: f.recipient, value: toQuantity(parseEther('4')), gasPrice: '0x0' }
      await f.send({ to: f.from })
      await f.send({ to: f.from })
      const live = f.engine.snapshot()
      await assert.rejects(f.request('eth_call', spend, revoked.blockNumber), /ReserveBalanceViolation/)
      assert.equal(await f.request('eth_call', spend, 'pending'), '0x', 'the next block is beyond the retained reserve window')
      await f.request('eth_registerCallId', 'old-delegation')
      assert.equal((await f.call(f.authority, { blockHash: delegated.blockHash }, 'simulate', [1, 11]))[0], 11n)
      const hash = await f.request('eth_getHashFromTagBySimulator', 'old-delegation')
      assert.equal(await f.request('eth_getCode', f.authority), '0x')
      assert.equal(await f.request('eth_getCode', f.authority, { blockNumber: delegated.blockNumber }), '0xef0100' + target.slice(2).toLowerCase())
      assert.equal(f.engine.snapshot(), live)
      await inspect(f, hash, 1n, 11n)
      restored = await fixture(fork, await f.save())
      await inspect(restored, hash, 1n, 11n)
      assert.equal((await restored.call(f.authority, delegated.blockNumber))[0], 1n)
      await assert.rejects(restored.request('eth_call', spend, { blockHash: revoked.blockHash }), /ReserveBalanceViolation/)
      assert.equal(restored.engine.snapshot(), live)
    } finally { restored?.close(); f.close() }
  })

  test(`${fork}: calls select staking state before and after empty transition blocks`, async () => {
    const f = await fixture(fork)
    let restored: Awaited<ReturnType<typeof fixture>>
    try {
      const address = await f.deploy()
      const epoch = new Interface(['function getEpoch() returns (uint64,bool)'])
      const input = { from: f.from, to: '0x0000000000000000000000000000000000001000', data: epoch.encodeFunctionData('getEpoch') }
      const snapshot = await f.request('monad_stakingTransition', { kind: 'snapshot' })
      const changed = await f.request('monad_stakingTransition', { kind: 'epochChange', epoch: '0x1' })
      restored = await fixture(fork, await f.save())
      const live = restored.engine.snapshot()
      for (const [selector, expected] of [['earliest', [0n, false]], [{ blockHash: snapshot.blockHash }, [0n, true]],
        [{ blockNumber: changed.blockNumber }, [1n, false]]] as const) {
        const output = await restored.request('eth_call', input, selector)
        assert.deepEqual(Array.from(epoch.decodeFunctionResult('getEpoch', output)), expected)
        await restored.request('eth_estimateGas', input, selector)
      }
      const context = await restored.request('eth_getBlockByHash', changed.blockHash, false)
      assert.deepEqual(await restored.call(address, changed.blockNumber), [0n, BigInt(changed.blockNumber), BigInt(context.timestamp), snapshot.blockHash])
      assert.equal(restored.engine.snapshot(), live)
      assert.equal(await restored.request('eth_getTransactionCount', f.from), '0x1')
    } finally { restored?.close(); f.close() }
  })

  test(`${fork}: invalid block selectors and saved block contexts fail without changing live state`, async () => {
    const f = await fixture(fork)
    try {
      const address = await f.deploy()
      const before = await f.save()
      const input = { to: address, data: abi.encodeFunctionData('read') }
      const invalid = [null, 1, [], {}, '1', '0x', '-1', '0x01', 'unknown', { blockNumber: 'latest' },
        { blockNumber: '0x0', blockHash: before.blocks[0].hash }, { blockNumber: '0x0', requireCanonical: true },
        { blockHash: before.blocks[0].hash, requireCanonical: 1 }, { blockHash: '0x00' }, { blockHash: before.blocks[0].hash, extra: true }]
      for (const selector of invalid) {
        for (const [method, params] of [['eth_call', [input, selector]], ['eth_estimateGas', [input, selector]],
          ['eth_getBalance', [address, selector]], ['eth_getCode', [address, selector]], ['eth_getStorageAt', [address, ZeroHash, selector]],
          ['eth_getTransactionCount', [f.from, selector]]] as const) {
          await assert.rejects(f.request(method, ...params), error => error instanceof RpcError && error.code === -32602)
        }
      }
      for (const selector of ['0xffffffffffffffff', { blockNumber: '0x' + 'f'.repeat(64) }, { blockHash: ZeroHash, requireCanonical: true }]) {
        await assert.rejects(f.request('eth_call', input, selector), error => error instanceof RpcError && error.code === -32001)
      }
      await assert.rejects(f.request('eth_call', input, 'latest', {}), /overrides/)
      await assert.rejects(f.request('eth_estimateGas', input, 'latest', {}), /overrides/)
      assert.deepEqual(await f.save(), before)
      for (const mutate of [
        state => { state.blocks[0].timestamp = '0x20000000000000' },
        state => { state.blocks[1].gasLimit = 'bad' },
        state => { state.blocks[0].mixHash = '0x' },
        state => { state.blocks[1].timestamp = '0x0' },
        state => { state.executions[0][1].block.timestamp = '0x0' },
        state => { state.executions[0][1].tx.blockNumber = '0x0' }
      ]) {
        const corrupt = structuredClone(before)
        mutate(corrupt)
        await assert.rejects(fixture(fork, corrupt), /saved Monad state/)
      }
      assert.deepEqual(await f.save(), before)
    } finally { f.close() }
  })
}
