import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { keccak256, Wallet, ZeroHash } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider, MonadProviderOptions } from '../src/provider'

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const hashFor = (value: number) => '0x' + value.toString(16).padStart(64, '0')

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

test('save and restore preserve earlier transaction and call debugging after later executions', async () => {
  const f = await fixture()
  try {
    const { hash: deployment, address } = await f.deploy()
    const first = await f.send(address, hashFor(11))
    const firstReceipt = await f.request('eth_getTransactionReceipt', first)
    const second = await f.send(address, hashFor(22))
    const before = f.engine.snapshot()
    const calls: string[] = []
    for (let i = 0; i < 105; i++) {
      await f.request('eth_registerCallId', `read-${i}`)
      await f.request('eth_call', { from: f.from, to: address, data: hashFor(i) })
      calls.push(await f.request('eth_getHashFromTagBySimulator', `read-${i}`))
    }
    assert.equal(f.engine.snapshot(), before, 'simulations do not commit state')
    const saved = await f.save()
    assert.equal(saved.executions.length, 3 + calls.length)
    const restored = await fixture({ stateDb: saved })
    try {
      assert.deepEqual((await restored.save()).executions, saved.executions)
      for (const hash of [deployment, first, second, calls[0], calls.at(-1)]) {
        const trace = await restored.request('debug_traceTransaction', hash)
        assert.ok(trace.structLogs.length)
        assert.deepEqual(trace, await f.request('debug_traceTransaction', hash))
      }
      assert.equal(await restored.request('eth_getStorageAt', address, '0x0'), hashFor(22))
      assert.equal(await restored.request('eth_getStorageAt', address, '0x0', firstReceipt.blockNumber), hashFor(11))
      assert.deepEqual(await restored.request('eth_getTransactionReceipt', first), firstReceipt)
      assert.equal((await restored.request('eth_getBlockByNumber', firstReceipt.blockNumber, true)).transactions[0].hash, first)
      assert.equal((await restored.request('eth_getLogs', {})).length, 2, 'simulated logs never enter committed block history')
      assert.equal(await restored.request('debug_preimage', keccak256(hashFor(11))), hashFor(11).slice(2))
      const receipt = await restored.request('eth_getTransactionReceipt', second)
      const storage = await restored.request('debug_storageRangeAt', receipt.blockHash, 0, address)
      assert.equal((Object.values(storage.storage)[0] as any).value, hashFor(11))
    } finally { restored.close() }
  } finally { f.close() }
})

test('trace readers cannot mutate debugging data included in saved state', async () => {
  const f = await fixture()
  try {
    const { address } = await f.deploy()
    const hash = await f.send(address, hashFor(42))
    const saved = await f.save()
    const trace = await f.request('debug_traceTransaction', hash)
    trace.structLogs.find(step => step.stack.length).stack.push('ff'.repeat(32))
    trace.structLogs.find(step => step.memory.length).memory.fill(255)
    assert.ok(trace.codeByAddress[address.toLowerCase()])
    trace.codeByAddress[address.toLowerCase()] = '0x00'
    assert.deepEqual(await f.save(), saved)
  } finally { f.close() }
})

test('save, fresh reset and restore preserve accounts, state and call debugging', async context => {
  context.mock.method(Date, 'now', () => 1_800_000_000_000)
  for (const fork of ['monad-ten', 'monad-next'] as const) {
    const f = await fixture({ fork })
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
        assert.deepEqual((await reset.save()).executions, [])
        assert.equal(await reset.request('eth_getHashFromTagBySimulator', 'saved-call'), null)
        assert.equal(await reset.request('eth_getBalance', f.from), '0x56bc75e2d63100000')
        assert.equal(await reset.request('eth_getTransactionCount', f.from), '0x0')
        assert.equal((await reset.request('eth_accounts')).length, 5)
        assert.equal(await reset.request('eth_getBalance', added), '0x0')
      } finally { reset.close() }
      const restored = await fixture({ fork, stateDb: saved })
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
        saved.executions.length = 0
        saved.tags.length = 0
        assert.deepEqual(await restored.save(), original, 'restore does not retain aliases into the imported object')
        const exported = await restored.save()
        exported.executions[0][1].receipt.status = '0x0'
        exported.executions[1][1].result.structLogs[0].stack.push('ff'.repeat(32))
        exported.keys.length = 0
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

test('version 1 saves without call metadata restore without losing executions or reusing call hashes', async context => {
  context.mock.method(Date, 'now', () => 1_800_000_000_000)
  const f = await fixture()
  try {
    const { address } = await f.deploy()
    await f.send(address, hashFor(42))
    await f.request('eth_registerCallId', 'legacy-call')
    await f.request('eth_call', { from: f.from, to: address, data: hashFor(99) })
    const call = await f.request('eth_getHashFromTagBySimulator', 'legacy-call')
    const legacy = await f.save()
    delete legacy.tags
    delete legacy.callCounter
    for (const [, record] of legacy.executions) {
      delete record.result.consoleCalls
      delete record.result.codeByAddress
      delete record.result.authorizationAuthorities
    }
    const restored = await fixture({ stateDb: legacy })
    try {
      const saved = await restored.save()
      assert.equal(saved.version, 1)
      assert.deepEqual(saved.executions, legacy.executions)
      assert.deepEqual(saved.tags, [])
      assert.deepEqual(await restored.request('eth_getHHLogsForTx', call), [])
      assert.equal(await restored.request('eth_getStorageAt', address, '0x0'), hashFor(42))
      assert.deepEqual(await restored.request('debug_traceTransaction', call), { ...await f.request('debug_traceTransaction', call), codeByAddress: {} })
      await restored.request('eth_registerCallId', 'legacy-call')
      await restored.request('eth_call', { from: f.from, to: address, data: hashFor(99) })
      assert.notEqual(await restored.request('eth_getHashFromTagBySimulator', 'legacy-call'), call)
      assert.equal((await restored.save()).executions.length, legacy.executions.length + 1)
    } finally { restored.close() }
  } finally { f.close() }
})

test('invalid saved states fail before replacing engine state, including on retry', async () => {
  const f = await fixture()
  try {
    const { address } = await f.deploy()
    await f.send(address, hashFor(42))
    await f.request('eth_call', { from: f.from, to: address, data: hashFor(99) })
    const saved = await f.save()
    const mutations = [
      state => { state.backend = 'ethereumjs' }, state => { state.version = 99 }, state => { state.spec = 'monad-ten' },
      state => { state.engine = '{' }, state => { state.engine = JSON.stringify({ ...JSON.parse(state.engine), chainId: 1 }) },
      state => { state.keys = ['invalid'] }, state => { state.blocks = [] }, state => { state.executions = [] },
      state => { state.executions[0][1].before = '{}' }, state => { state.executions[0][1].after = '{}' },
      state => { state.executions[0][1].result.structLogs = null }, state => { state.executions[0][1].result.preimages = null },
      state => { state.executions[0][1].result.consoleCalls = [123] },
      state => { state.executions[0][1].result.codeByAddress = { invalid: '0x00' } },
      state => { state.executions[0][1].result.codeByAddress = { [address]: '0x1' } },
      state => { state.executions[0][1].result.authorizationAuthorities = [ZeroHash] },
      state => { state.executions[0][0] = ZeroHash }, state => { state.tags = [['missing', ZeroHash]] },
      state => { state.callCounter = -1 }, state => { state.callCounter = 0 }
    ]
    for (const mutate of mutations) {
      const damaged = JSON.parse(JSON.stringify(saved))
      mutate(damaged)
      const engine = new Engine('monad-next', 1337)
      try {
        engine.fund(f.from, '0x42')
        const before = engine.snapshot()
        const local = new MonadProvider({ fork: 'monad-next', stateDb: damaged }, engine)
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(local.init(), /saved.*state|Saved state/)
          assert.equal(engine.snapshot(), before)
          await assert.rejects(local.request({ method: 'eth_accounts' }), /not been initialized/)
        }
      } finally { engine.free() }
    }
  } finally { f.close() }
})
