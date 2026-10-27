import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { keccak256, Wallet, ZeroHash } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider, MonadProviderOptions } from '../src/provider'
import { DEFAULT_HISTORY_LIMITS } from '../src/history'

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const hashFor = (value: number) => '0x' + value.toString(16).padStart(64, '0')
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength
const retainedBytes = state => state.history.reduce((total, entry) => total + bytes(entry), 0)
const expired = (error: any) => error.code === -32000 && /no longer retained/.test(error.message)

async function fixture(options: Partial<MonadProviderOptions> = {}) {
  const engine = new Engine(options.fork || 'monad-next', 1337)
  const local = new MonadProvider({ fork: 'monad-next', ...options }, engine)
  try { await local.init() } catch (error) { engine.free(); throw error }
  const request = (method: string, ...params: any[]) => local.request({ method, params })
  const [from] = await request('eth_accounts')
  const send = (to: string, data = '0x') => request('eth_sendTransaction', { from, to, data, gas: '0x186a0' })
  const deploy = async () => {
    // Store the calldata word, record its KECCAK preimage, and emit one log.
    const runtime = '5f355f555f355f5260205f205060205fa000'
    const length = (runtime.length / 2).toString(16).padStart(2, '0')
    const hash = await request('eth_sendTransaction', { from, data: `0x60${length}600c60003960${length}6000f3${runtime}`, gas: '0xf4240' })
    return { hash, address: (await request('eth_getTransactionReceipt', hash)).contractAddress }
  }
  const save = () => request('eth_getStateDb')
  return { engine, local, request, from, send, deploy, save, close: () => engine.free() }
}

test('FIFO eviction preserves committed state, receipts and logs while expiring debugging data', async () => {
  const f = await fixture({ historyLimits: { maxEntries: 2 } })
  try {
    const deployment = await f.deploy()
    const first = await f.send(deployment.address, hashFor(11))
    const firstReceipt = await f.request('eth_getTransactionReceipt', first)
    const second = await f.send(deployment.address, hashFor(22))
    await f.request('debug_traceTransaction', first)
    const third = await f.send(deployment.address, hashFor(33))
    const state = await f.save()
    assert.deepEqual(state.history.map(([hash]) => hash), [second, third], 'reading an older trace does not change FIFO order')
    assert.equal(state.executions.length, 4)
    assert.ok(state.executions.every(([, record]) => !('before' in record) && !('after' in record) && !('structLogs' in record.result) && !('preimages' in record.result)))
    assert.equal(await f.request('eth_getStorageAt', deployment.address, '0x0'), hashFor(33))
    assert.deepEqual(await f.request('eth_getTransactionReceipt', first), firstReceipt)
    assert.equal((await f.request('eth_getBlockByNumber', firstReceipt.blockNumber, true)).transactions[0].hash, first)
    assert.equal((await f.request('eth_getLogs', {})).length, 3)
    assert.equal((await f.request('eth_getExecutionResultFromSimulator', first)).exceptionError, null)
    await assert.rejects(f.request('debug_traceTransaction', first), expired)
    await assert.rejects(f.request('debug_storageRangeAt', firstReceipt.blockHash, 0, deployment.address), expired)
    await assert.rejects(f.request('eth_getStorageAt', deployment.address, '0x0', firstReceipt.blockNumber), expired)
    assert.equal(await f.request('debug_preimage', keccak256(hashFor(11))), null)
    assert.equal(await f.request('debug_preimage', keccak256(hashFor(33))), hashFor(33).slice(2))
    const receipt = await f.request('eth_getTransactionReceipt', third)
    const storage = await f.request('debug_storageRangeAt', receipt.blockHash, 0, deployment.address)
    assert.equal((Object.values(storage.storage)[0] as any).value, hashFor(22))
    assert.ok((await f.request('debug_traceTransaction', third)).structLogs.some(step => step.op === 'SSTORE'))
  } finally { f.close() }
})

test('byte budgets apply during restore and execution, including an oversized single record', async () => {
  const f = await fixture()
  try {
    const { address } = await f.deploy()
    const latest = await f.send(address, hashFor(9))
    const saved = await f.save()
    const newestSize = bytes(saved.history.at(-1))
    const limited = await fixture({ stateDb: saved, historyLimits: { maxBytes: newestSize } })
    try {
      const state = await limited.save()
      assert.equal(limited.local.options.stateDb, undefined, 'the provider releases the unbounded import object')
      assert.deepEqual(state.history.map(([hash]) => hash), [latest])
      assert.equal(retainedBytes(state), newestSize)
      await limited.send(address, hashFor(10))
      assert.ok(retainedBytes(await limited.save()) <= newestSize)
      assert.equal(await limited.request('eth_getStorageAt', address, '0x0'), hashFor(10))
    } finally { limited.close() }
    for (const historyLimits of [{ maxBytes: 1 }, { maxBytes: 0 }, { maxEntries: 0 }]) {
      const disabled = await fixture({ stateDb: saved, historyLimits })
      try {
        const hash = await disabled.send(address, hashFor(10))
        assert.deepEqual((await disabled.save()).history, [])
        assert.equal((await disabled.request('eth_getTransactionReceipt', hash)).status, '0x1')
        assert.equal(await disabled.request('eth_getStorageAt', address, '0x0'), hashFor(10))
        await assert.rejects(disabled.request('debug_traceTransaction', hash), expired)
      } finally { disabled.close() }
    }
  } finally { f.close() }
})

test('trace readers cannot mutate retained history or bypass its byte accounting', async () => {
  const f = await fixture()
  try {
    const { address } = await f.deploy()
    const hash = await f.send(address, hashFor(42))
    const saved = await f.save()
    const trace = await f.request('debug_traceTransaction', hash)
    trace.structLogs.find(step => step.stack.length).stack.push('ff'.repeat(32))
    trace.structLogs.find(step => step.memory.length).memory.fill(255)
    assert.deepEqual(await f.save(), saved)
  } finally { f.close() }
})

test('oversized traces do not displace retained small executions', async () => {
  const f = await fixture({ historyLimits: { maxBytes: 20_000 } })
  try {
    const transfer = await f.send(f.from)
    const before = await f.save()
    assert.deepEqual(before.history.map(([hash]) => hash), [transfer])
    // This loop fits the engine trace cap but exceeds the provider retention budget.
    const deployment = await f.request('eth_sendTransaction', { from: f.from, data: '0x6003600c60003960036000f35b5f56', gas: '0x186a0' })
    const address = (await f.request('eth_getTransactionReceipt', deployment)).contractAddress
    const loop = await f.send(address)
    assert.equal((await f.request('eth_getTransactionReceipt', loop)).status, '0x0')
    await assert.rejects(f.request('debug_traceTransaction', loop), expired)
    assert.ok((await f.save()).history.some(([hash]) => hash === transfer))
  } finally { f.close() }
})

test('repeated calls stay within the default history limits without committing simulation state', async () => {
  const f = await fixture()
  try {
    const { address } = await f.deploy()
    const before = f.engine.snapshot()
    let first: string
    for (let i = 0; i < DEFAULT_HISTORY_LIMITS.maxEntries + 5; i++) {
      await f.request('eth_registerCallId', 'latest-read')
      await f.request('eth_call', { from: f.from, to: address, data: hashFor(i) })
      if (i === 0) first = await f.request('eth_getHashFromTagBySimulator', 'latest-read')
    }
    assert.equal(f.engine.snapshot(), before)
    const state = await f.save()
    assert.equal(state.history.length, DEFAULT_HISTORY_LIMITS.maxEntries)
    assert.ok(retainedBytes(state) <= DEFAULT_HISTORY_LIMITS.maxBytes)
    await assert.rejects(f.request('debug_traceTransaction', first), expired)
    const latest = await f.request('eth_getHashFromTagBySimulator', 'latest-read')
    assert.ok((await f.request('debug_traceTransaction', latest)).structLogs.length)
    assert.equal((await f.request('eth_getLogs', {})).length, 0, 'simulated logs never enter committed block history')
  } finally { f.close() }
})

test('save, fresh reset and restore preserve accounts, state and retained call debugging', async context => {
  context.mock.method(Date, 'now', () => 1_800_000_000_000)
  for (const fork of ['monad-ten', 'monad-next'] as const) {
    const f = await fixture({ fork, historyLimits: { maxEntries: 2 } })
    try {
      const key = Wallet.createRandom().privateKey
      const added = f.local.Accounts._addAccount(key, '0x1234')
      const { address } = await f.deploy()
      const stored = await f.send(address, hashFor(42))
      await f.request('eth_registerCallId', 'saved-call')
      await f.request('eth_call', { from: f.from, to: address, data: hashFor(99) })
      const call = await f.request('eth_getHashFromTagBySimulator', 'saved-call')
      const saved = await f.save()
      const original = JSON.parse(JSON.stringify(saved))
      const reset = await fixture({ fork })
      try {
        assert.equal(await reset.request('eth_blockNumber'), '0x0')
        assert.equal(await reset.request('eth_getCode', address), '0x')
        assert.equal(await reset.request('eth_getTransactionReceipt', stored), null)
        assert.deepEqual((await reset.save()).history, [])
        assert.equal(await reset.request('eth_getHashFromTagBySimulator', 'saved-call'), null)
        assert.equal(await reset.request('eth_getBalance', f.from), '0x56bc75e2d63100000')
      } finally { reset.close() }
      const restored = await fixture({ fork, stateDb: saved, historyLimits: { maxEntries: 2 } })
      try {
        assert.equal(restored.engine.snapshot(), f.engine.snapshot())
        assert.deepEqual(await restored.request('eth_accounts'), await f.request('eth_accounts'))
        assert.equal(await restored.request('eth_getBalance', added), '0x1234')
        assert.equal(await restored.request('eth_getStorageAt', address, '0x0'), hashFor(42))
        assert.equal(await restored.request('eth_getTransactionCount', f.from), await f.request('eth_getTransactionCount', f.from))
        assert.deepEqual(await restored.request('eth_getTransactionReceipt', stored), await f.request('eth_getTransactionReceipt', stored))
        assert.equal(await restored.request('eth_getHashFromTagBySimulator', 'saved-call'), call)
        assert.deepEqual(await restored.request('debug_traceTransaction', call), await f.request('debug_traceTransaction', call))
        saved.blocks[0].hash = ZeroHash
        saved.history.length = 0
        saved.executions.length = 0
        assert.deepEqual(await restored.save(), original, 'restore does not retain aliases into the imported object')
        const exported = await restored.save()
        exported.history.length = 0
        exported.executions[0][1].receipt.status = '0x0'
        assert.deepEqual(await restored.save(), original, 'exports do not expose mutable provider records')
        await restored.request('eth_registerCallId', 'saved-call')
        await restored.request('eth_call', { from: f.from, to: address, data: hashFor(99) })
        assert.notEqual(await restored.request('eth_getHashFromTagBySimulator', 'saved-call'), call, 'restored calls cannot reuse a previous synthetic hash')
        const next = await restored.send(address, hashFor(43))
        assert.equal((await restored.request('eth_getTransactionReceipt', next)).status, '0x1')
        assert.equal(await restored.request('eth_getStorageAt', address, '0x0'), hashFor(43))
      } finally { restored.close() }
    } finally { f.close() }
  }
})

test('legacy saved states migrate to bounded history and current limits are reapplied on import', async () => {
  const f = await fixture()
  try {
    const { address } = await f.deploy()
    const hash = await f.send(address, hashFor(42))
    const saved = await f.save()
    const history = new Map<string, any>(saved.history)
    const legacy = { ...saved, version: 1, executions: saved.executions.map(([hash, record]) => {
      const { before, after, structLogs, preimages } = history.get(hash)
      return [hash, { ...record, before, after, result: { ...record.result, structLogs, preimages } }]
    }) }
    delete legacy.history
    delete legacy.tags
    delete legacy.callCounter
    const restored = await fixture({ stateDb: legacy, historyLimits: { maxEntries: 1 } })
    try {
      assert.equal((await restored.save()).version, 2)
      assert.deepEqual((await restored.save()).history.map(([hash]) => hash), [hash])
      assert.equal(await restored.request('eth_getStorageAt', address, '0x0'), hashFor(42))
      assert.ok((await restored.request('debug_traceTransaction', hash)).structLogs.length)
    } finally { restored.close() }
  } finally { f.close() }
})

test('invalid saved states fail before replacing engine state', async () => {
  const f = await fixture()
  try {
    const { address } = await f.deploy()
    await f.send(address, hashFor(42))
    const saved = await f.save()
    const mutations = [
      state => { state.backend = 'ethereumjs' }, state => { state.version = 99 }, state => { state.spec = 'monad-ten' },
      state => { state.engine = '{' }, state => { state.engine = JSON.stringify({ ...JSON.parse(state.engine), chainId: 1 }) },
      state => { state.keys = ['invalid'] }, state => { state.blocks = [] }, state => { state.executions = [] },
      state => { state.history[0][1].before = '{}' }, state => { state.history[0][1].structLogs = null },
      state => { state.history[0][0] = ZeroHash }, state => { state.tags = [['missing', ZeroHash]] },
      state => { state.callCounter = -1 }
    ]
    for (const mutate of mutations) {
      const damaged = JSON.parse(JSON.stringify(saved))
      mutate(damaged)
      const engine = new Engine('monad-next', 1337)
      try {
        engine.fund(f.from, '0x42')
        const before = engine.snapshot()
        const local = new MonadProvider({ fork: 'monad-next', stateDb: damaged }, engine)
        await assert.rejects(local.init(), /saved.*state|Saved state/)
        assert.equal(engine.snapshot(), before)
        await assert.rejects(local.request({ method: 'eth_accounts' }), /not been initialized/)
      } finally { engine.free() }
    }
    for (const historyLimits of [{ maxEntries: -1 }, { maxEntries: 0.5 }, { maxBytes: Infinity }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.throws(() => new MonadProvider({ fork: 'monad-next', historyLimits }), /history limits/)
    }
  } finally { f.close() }
})
