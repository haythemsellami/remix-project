import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import solc from 'solc'
import { BrowserProvider, Contract, Interface, toBeHex, toQuantity, ZeroAddress, ZeroHash } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider } from '../src/provider'
import { RpcError } from '../src/types'

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const source = readFileSync('libs/remix-monad/examples/EventQueries.sol', 'utf8')
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'EventQueries.sol': { content: source } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode']} } }
})))
assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), [])
const artifact = compiled.contracts['EventQueries.sol'].EventQueries
const abi = new Interface(artifact.abi)
const topic = abi.getEvent('Updated').topicHash
const upper = (value: string) => '0x' + value.slice(2).toUpperCase()
const invalid = (error: any) => error instanceof RpcError && error.code === -32602
const missing = (error: any) => error instanceof RpcError && error.code === -32000 && /Filter not found/.test(error.message)

async function fixture(fork: 'monad-ten' | 'monad-next', stateDb?: unknown) {
  const engine = new Engine(fork, 1337)
  const local = new MonadProvider({ fork, stateDb }, engine)
  try { await local.init() } catch (error) { engine.free(); throw error }
  const request = (method: string, ...params: any[]) => local.request({ method, params })
  const [from] = await request('eth_accounts')
  const calls: { method: string; result: any }[] = []
  const web3 = new BrowserProvider({ request: async payload => {
    const result = await local.request({ method: payload.method, params: payload.params as any[] })
    calls.push({ method: payload.method, result })
    return result
  } }, undefined, { cacheTimeout: -1, pollingInterval: 20 })
  const send = async (input: any) => {
    const hash = await request('eth_sendTransaction', { from, gas: '0x493e0', ...input })
    return request('eth_getTransactionReceipt', hash)
  }
  const invoke = (address: string, method: string, args: any[] = []) => send({ to: address, data: abi.encodeFunctionData(method, args) })
  return { engine, local, request, from, web3, calls, send, invoke,
    deploy: async () => (await send({ data: '0x' + artifact.evm.bytecode.object, gas: '0x2dc6c0' })).contractAddress as string,
    save: () => request('eth_getStateDb'), close: () => { web3.destroy(); engine.free() } }
}

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 10_000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), message)
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: event queries match block references, addresses, topics and anonymous events`, async () => {
    const f = await fixture(fork)
    try {
      const a = await f.deploy()
      const b = await f.deploy()
      const first = await f.invoke(a, 'store', [1, 11, 'first'])
      const second = await f.invoke(b, 'store', [2, 22, 'second'])
      const third = await f.invoke(a, 'store', [3, 33, 'third'])
      const all = [...first.logs, ...second.logs, ...third.logs]
      const get = (filter: any) => f.request('eth_getLogs', filter)
      assert.deepEqual(await get({}), third.logs, 'omitted range selects the latest block')
      for (const toBlock of ['latest', 'safe', 'finalized', 'pending', third.blockNumber, '0xffffffffffffffffffff']) {
        assert.deepEqual(await get({ fromBlock: 'earliest', toBlock }), all)
      }
      for (const fromBlock of ['latest', 'safe', 'finalized']) assert.deepEqual(await get({ fromBlock }), third.logs)
      assert.deepEqual(await get({ fromBlock: first.blockNumber, toBlock: second.blockNumber }), [...first.logs, ...second.logs])
      assert.deepEqual(await get({ fromBlock: 'pending' }), [])
      assert.deepEqual(await get({ fromBlock: '0xffffffffffffffff', toBlock: '0xffffffffffffffff' }), [])
      assert.deepEqual(await get({ blockHash: upper(second.blockHash) }), second.logs)
      assert.deepEqual(await get({ fromBlock: 'earliest', address: upper(a) }), [...first.logs, ...third.logs])
      assert.deepEqual(await get({ fromBlock: 'earliest', address: [b, upper(a)]}), all, 'results retain chain order')
      assert.deepEqual(await get({ fromBlock: 'earliest', address: []}), all)
      assert.deepEqual(await get({ fromBlock: 'earliest', topics: [upper(topic), null, [toBeHex(1, 32), toBeHex(3, 32)]]}), [first.logs[0], third.logs[0]])
      for (const topics of [[null], [[]], [[null, topic]], [topic, upper(toBeHex(f.from, 32))]]) {
        assert.deepEqual(await get({ fromBlock: 'earliest', topics }), [first.logs[0], second.logs[0], third.logs[0]], 'wildcards still require that topic position to exist')
      }
      assert.deepEqual(await get({ fromBlock: 'earliest', topics: [topic, null, null, null]}), [])
      assert.deepEqual(await get({ fromBlock: 'earliest', address: ZeroAddress }), [])
      const detached = await get({ blockHash: first.blockHash })
      detached[0].topics[0] = ZeroHash
      detached[0].data = '0x'
      detached.reverse()
      assert.deepEqual(await get({ blockHash: first.blockHash }), first.logs, 'queries cannot mutate retained receipts')
      const contract = new Contract(a, artifact.abi, f.web3)
      const decoded = await contract.queryFilter(contract.filters.Updated(f.from, [1, 3]), 0, 'latest')
      assert.deepEqual(decoded.map((log: any) => Array.from(log.args)), [[f.from, 1n, 11n, 'first'], [f.from, 3n, 33n, 'third']])
    } finally { f.close() }
  })

  test(`${fork}: invalid log queries and filter calls return RPC errors`, async () => {
    const f = await fixture(fork)
    try {
      for (const filter of [null, [], 1, '0x0', { unknown: true }, { fromBlock: 'bad' }, { fromBlock: '0x00' },
        { fromBlock: -1 }, { toBlock: {} }, { fromBlock: '0x2', toBlock: '0x1' }, { address: 1 }, { address: [null]},
        { address: '0x12' }, { blockHash: '0x0' }, { blockHash: ZeroHash, fromBlock: 'earliest' }, { blockHash: ZeroHash, toBlock: 'latest' },
        { topics: '0x' }, { topics: [1]}, { topics: ['0x12']}, { topics: [[[]]]}, { topics: [null, null, null, null, null]}]) {
        for (const method of ['eth_getLogs', 'eth_newFilter']) await assert.rejects(f.request(method, filter), invalid, JSON.stringify(filter))
      }
      for (const method of ['eth_getLogs', 'eth_newFilter']) {
        await assert.rejects(f.request(method, { blockHash: ZeroHash }), error => error instanceof RpcError && error.code === -32001)
      }
      for (const method of ['eth_getLogs', 'eth_newFilter', 'eth_getFilterChanges', 'eth_getFilterLogs', 'eth_uninstallFilter']) {
        await assert.rejects(f.request(method), invalid)
        await assert.rejects(f.request(method, {}, {}), invalid)
      }
      for (const method of ['eth_getFilterChanges', 'eth_getFilterLogs', 'eth_uninstallFilter']) {
        for (const id of [null, 1, {}, 'unknown', '0x00']) await assert.rejects(f.request(method, id), invalid)
      }
      await assert.rejects(f.request('eth_newBlockFilter', {}), invalid)
      await assert.rejects(f.request('eth_getFilterChanges', '0x1'), missing)
      assert.equal(await f.request('eth_uninstallFilter', '0x1'), false)
      assert.deepEqual(await f.request('eth_getLogs', { fromBlock: 'earliest' }), [], 'invalid requests leave the provider usable')
    } finally { f.close() }
  })

  test(`${fork}: polling filters deliver intervening logs once and keep historical queries independent`, async () => {
    const f = await fixture(fork)
    try {
      const address = await f.deploy()
      const before = await f.invoke(address, 'store', [1, 1, 'before'])
      const input = { fromBlock: 'earliest', address: [address], topics: [topic]}
      const id = await f.request('eth_newFilter', input)
      input.address[0] = ZeroAddress
      input.topics[0] = ZeroHash
      const live = await f.request('eth_newFilter', { address, topics: [topic]})
      const pending = await f.request('eth_newFilter', { address, fromBlock: 'pending', topics: [topic]})
      const historical = await f.request('eth_newFilter', { blockHash: before.blockHash })
      assert.deepEqual(await f.request('eth_getFilterLogs', historical), before.logs)
      const head = BigInt(await f.request('eth_blockNumber'))
      const limited = await f.request('eth_newFilter', { address, fromBlock: toQuantity(head + 2n), toBlock: toQuantity(head + 2n), topics: [topic]})
      assert.deepEqual(await f.request('eth_getFilterChanges', id), [], 'new filters do not backfill old logs')
      assert.deepEqual(await f.request('eth_getFilterLogs', id), [before.logs[0]])
      const first = await f.invoke(address, 'store', [2, 2, 'first'])
      const second = await f.invoke(address, 'store', [3, 3, 'second'])
      const all = [before.logs[0], first.logs[0], second.logs[0]]
      assert.deepEqual(await f.request('eth_getFilterLogs', id), all)
      assert.deepEqual(await f.request('eth_getFilterLogs', id), all, 'historical reads do not consume changes')
      assert.deepEqual(await f.request('eth_getFilterChanges', upper(id)), all.slice(1))
      assert.deepEqual(await f.request('eth_getFilterChanges', id), [])
      assert.deepEqual(await f.request('eth_getFilterChanges', live), all.slice(1), 'latest is anchored at creation for change polling')
      assert.deepEqual(await f.request('eth_getFilterChanges', pending), all.slice(1), 'pending starts at the next committed block')
      assert.deepEqual(await f.request('eth_getFilterChanges', historical), [], 'a fixed historical hash never delivers new blocks')
      assert.deepEqual(await f.request('eth_getFilterLogs', live), [second.logs[0]], 'getFilterLogs evaluates the original latest query')
      assert.deepEqual(await f.request('eth_getFilterChanges', limited), [second.logs[0]])
      const third = await f.invoke(address, 'store', [4, 4, 'third'])
      const changes = await f.request('eth_getFilterChanges', id)
      changes[0].topics[0] = ZeroHash
      assert.deepEqual(await f.request('eth_getLogs', { blockHash: third.blockHash, topics: [topic]}), [third.logs[0]])
      assert.deepEqual(await f.request('eth_getFilterChanges', limited), [], 'fixed upper bounds stop delivery')
      assert.equal(await f.request('eth_uninstallFilter', id), true)
      assert.equal(await f.request('eth_uninstallFilter', id), false)
      await assert.rejects(f.request('eth_getFilterChanges', id), missing)
      await assert.rejects(f.request('eth_getFilterLogs', id), missing)
    } finally { f.close() }
  })

  test(`${fork}: block filters include empty blocks while event filters discard simulated and reverted logs`, async () => {
    const f = await fixture(fork)
    try {
      const address = await f.deploy()
      const blocks = await f.request('eth_newBlockFilter')
      const logs = await f.request('eth_newFilter', { address })
      assert.deepEqual(await f.request('eth_getFilterChanges', blocks), [])
      await assert.rejects(f.request('eth_getFilterLogs', blocks), invalid)
      const simulation = { from: f.from, to: address, data: abi.encodeFunctionData('store', [1, 11, 'simulation']) }
      await f.request('eth_call', simulation)
      await f.request('eth_estimateGas', simulation)
      await assert.rejects(f.request('eth_call', { ...simulation, data: abi.encodeFunctionData('reject', [2]) }), /revert/)
      assert.deepEqual(await f.request('eth_getFilterChanges', blocks), [])
      assert.deepEqual(await f.request('eth_getFilterChanges', logs), [])
      const reverted = await f.invoke(address, 'reject', [3])
      assert.equal(reverted.status, '0x0')
      assert.deepEqual(reverted.logs, [])
      const empty = await f.send({ to: f.from, value: '0x0' })
      const transition = await f.request('monad_stakingTransition', { kind: 'snapshot' })
      const caught = await f.invoke(address, 'catchFailure', [4])
      assert.equal(caught.logs.length, 1)
      assert.equal(abi.parseLog(caught.logs[0]).args.note, 'caught')
      assert.deepEqual(await f.request('eth_getFilterChanges', blocks), [reverted.blockHash, empty.blockHash, transition.blockHash, caught.blockHash])
      assert.deepEqual(await f.request('eth_getFilterChanges', blocks), [])
      assert.deepEqual(await f.request('eth_getFilterChanges', logs), caught.logs)
      assert.deepEqual(await f.request('eth_getLogs', { fromBlock: 'earliest' }), caught.logs)
    } finally { f.close() }
  })

  test(`${fork}: reset and restored providers invalidate filters but preserve committed event history`, async () => {
    const f = await fixture(fork)
    let restored: Awaited<ReturnType<typeof fixture>>
    let fresh: Awaited<ReturnType<typeof fixture>>
    try {
      const address = await f.deploy()
      const id = await f.request('eth_newFilter', { fromBlock: 'earliest', address })
      const blockId = await f.request('eth_newBlockFilter')
      const written = await f.invoke(address, 'store', [1, 42, 'saved'])
      const saved = await f.save()
      restored = await fixture(fork, saved)
      fresh = await fixture(fork)
      for (const other of [restored, fresh]) {
        const replacement = await other.request('eth_newFilter', { address })
        assert.notEqual(replacement, id)
        await assert.rejects(other.request('eth_getFilterChanges', id), missing)
        await assert.rejects(other.request('eth_getFilterChanges', blockId), missing)
        assert.equal(await other.request('eth_uninstallFilter', id), false)
        assert.deepEqual(await other.request('eth_getFilterChanges', replacement), [])
      }
      assert.deepEqual(await fresh.request('eth_getLogs', { fromBlock: 'earliest' }), [])
      assert.deepEqual(await restored.request('eth_getLogs', { blockHash: written.blockHash }), written.logs)
      const history = await restored.request('eth_newFilter', { fromBlock: 'earliest', address })
      assert.deepEqual(await restored.request('eth_getFilterLogs', history), written.logs)
      const next = await restored.invoke(address, 'store', [2, 43, 'continued'])
      assert.deepEqual(await restored.request('eth_getFilterChanges', history), next.logs)
      assert.deepEqual(await restored.request('eth_getFilterLogs', history), [...written.logs, ...next.logs])
    } finally { restored?.close(); fresh?.close(); f.close() }
  })

  test(`${fork}: ethers listeners decode events, fire once and uninstall polling filters`, async () => {
    const f = await fixture(fork)
    try {
      const address = await f.deploy()
      const contract = new Contract(address, artifact.abi, f.web3)
      const events: any[] = []
      const once: any[] = []
      const listener = (sender, key, value, note, event) => events.push({ sender, key, value, note, hash: event.log.transactionHash })
      await contract.on('Updated', listener)
      await contract.once('Updated', (...args) => once.push(args.slice(0, 4)))
      await until(() => f.calls.some(call => call.method === 'eth_getFilterChanges') && f.calls.some(call => call.method === 'eth_blockNumber'), 'listener completed its first poll and established a block baseline')
      const first = await f.invoke(address, 'store', [1, 11, 'one'])
      await until(() => events.length === 1 && once.length === 1, 'listeners receive the first event')
      const second = await f.invoke(address, 'store', [2, 22, 'two'])
      await until(() => events.length === 2, 'listener receives the second event')
      assert.deepEqual(events, [
        { sender: f.from, key: 1n, value: 11n, note: 'one', hash: first.transactionHash },
        { sender: f.from, key: 2n, value: 22n, note: 'two', hash: second.transactionHash }
      ])
      assert.deepEqual(once, [[f.from, 1n, 11n, 'one']])
      await contract.off('Updated', listener)
      await until(() => f.calls.some(call => call.method === 'eth_uninstallFilter'), 'removing the final listener uninstalls the filter')
      assert.equal(await contract.listenerCount('Updated'), 0)
      await f.invoke(address, 'store', [3, 33, 'after removal'])
      assert.equal(events.length, 2)
      const queried = await contract.queryFilter('Updated', 0, 'latest')
      assert.deepEqual(queried.map((log: any) => log.args.value), [11n, 22n, 33n])
      assert.ok(f.calls.some(call => call.method === 'eth_getFilterChanges'))
    } finally { f.close() }
  })
}
