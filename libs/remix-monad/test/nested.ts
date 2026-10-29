import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import solc from 'solc'
import { AbiCoder, BrowserProvider, Contract, ContractFactory, Interface, ZeroHash } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider } from '../src/provider'
/* eslint-disable @nrwl/nx/enforce-module-boundaries -- Verify the provider against the debugger's public trace and storage APIs. */
import { extendProvider } from '../../remix-debug/src/init'
import { Ethdebugger } from '../../remix-debug/src/Ethdebugger'
import { CompilerAbstract } from '@remix-project/remix-solidity'
import { convertOffsetToLineColumn, getLinebreakPositions } from '../../remix-debug/src/source/sourceMappingDecoder'
/* eslint-enable @nrwl/nx/enforce-module-boundaries */

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const source = readFileSync('libs/remix-monad/examples/NestedCalls.sol', 'utf8')
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { 'NestedCalls.sol': { content: source } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'], '': ['ast']} } }
})))
assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), [])
const artifacts = compiled.contracts['NestedCalls.sol']
const abi = AbiCoder.defaultAbiCoder()
const fault = new Interface(['error NestedFailure(uint256 value)']).encodeErrorResult('NestedFailure', [20])

async function fixture(fork: 'monad-next' | 'monad-ten' = 'monad-next') {
  const engine = new Engine(fork, 1337)
  const local = new MonadProvider({ fork }, engine)
  await local.init()
  const web3 = new BrowserProvider(local, undefined, { cacheTimeout: -1 })
  extendProvider(web3)
  const signer = await web3.getSigner()
  const from = await signer.getAddress()
  const artifact = artifacts.NestedCalls
  const root = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, signer).deploy()
  await root.waitForDeployment()
  const address = await root.getAddress()
  const callee = new Contract(await (root as any).callee(), artifacts.NestedCallee.abi, signer)
  const leaf = new Contract(await callee.leaf(), artifacts.NestedLeaf.abi, signer)
  const probe = await (root as any).probe()
  const send = async (name: string, args: any[] = [], withSources = false) => {
    const hash = await local.request({ method: 'eth_sendTransaction', params: [{
      from, to: address, data: root.interface.encodeFunctionData(name, args), gas: '0xf4240'
    }]})
    const receipt = await local.request({ method: 'eth_getTransactionReceipt', params: [hash]})
    const trace = await local.request({ method: 'debug_traceTransaction', params: [hash]})
    const compilation = new CompilerAbstract('json', compiled, { target: 'NestedCalls.sol', sources: { 'NestedCalls.sol': { content: source } } })
    const debug = new Ethdebugger({ web3,
      compilationResult: async (address?: string) => withSources && address?.toLowerCase() !== probe.toLowerCase() ? compilation : null,
      offsetToLineColumnConverter: { offsetToLineColumn: async location => convertOffsetToLineColumn(location, getLinebreakPositions(source)) }
    })
    const treeReady = withSources && new Promise<void>((resolve, reject) => {
      debug.callTree.event.register('callTreeReady', () => resolve())
      debug.callTree.event.register('callTreeBuildFailed', reject)
      debug.callTree.event.register('callTreeNotReady', reject)
    })
    await debug.debug((await web3.getTransaction(hash)).toJSON())
    if (treeReady) await treeReady
    return { hash, receipt, trace, debug }
  }
  return { engine, local, web3, from, root, address, callee, leaf, probe, send,
    close: () => { web3.destroy(); engine.free() } }
}

async function slot(debug: Ethdebugger, index: number, address: string) {
  return new Promise<bigint>((resolve, reject) => {
    debug.storageViewAt(index, address).storageSlot(ZeroHash, (error, value) => error ? reject(error) : resolve(BigInt(value?.value || 0)))
  })
}
const hexWord = (value: string) => BigInt('0x' + value)

test('nested CALL, STATICCALL and DELEGATECALL preserve introspection and trace frames', async () => {
  const f = await fixture()
  try {
    for (const [kind, opcode] of ['CALL', 'STATICCALL', 'DELEGATECALL'].entries()) {
      const { receipt, trace, debug } = await f.send('inspect', [kind])
      assert.equal(receipt.status, '0x1')
      const [encoded] = abi.decode(['bytes'], trace.returnValue)
      const words = abi.decode(['uint256', 'address', 'address', 'address', 'address'], encoded)
      assert.deepEqual(Array.from(words), [2n, kind === 2 ? f.address : await f.callee.getAddress(), f.address, f.from, '0x0000000000000000000000000000000000000000'])
      const steps = debug.getTrace()
      const depth = steps.findIndex(step => step.op === 'CALLSTACKDEPTH')
      assert.equal(steps[depth - 1].op, opcode)
      assert.equal(steps[depth].depth, 3)
      assert.equal(steps[depth].pc, 0)
      assert.equal(steps[depth + 1].pc, 2)
      assert.equal(hexWord(steps[depth + 1].stack.at(-1)), 2n)
      const callers = steps.flatMap((step, i) => step.op === 'CALLERN' ? [hexWord(steps[i + 1].stack.at(-1))] : [])
      assert.deepEqual(callers, [BigInt(kind === 2 ? f.address : await f.callee.getAddress()), BigInt(f.address), BigInt(f.from), 0n])
      assert.deepEqual(debug.traceManager.getCallStackAt(depth).map(address => address.toLowerCase()), [f.address, await f.callee.getAddress(), f.probe].map(address => address.toLowerCase()))
      assert.equal(debug.traceManager.getCurrentCalledAddressAt(depth).toLowerCase(), f.probe.toLowerCase())
      const end = steps.findIndex((step, index) => index > depth && step.depth === 2)
      assert.equal(debug.traceManager.getCurrentCalledAddressAt(end).toLowerCase(), (await f.callee.getAddress()).toLowerCase())
      assert.equal(debug.traceManager.getCallDataAt(end)[0].replace(/^0x/, ''), f.callee.interface.encodeFunctionData('inspect', [f.probe, kind]).slice(2))
    }
  } finally { f.close() }
})

test('nested STATICCALL decodes calldata and return words at each frame', async () => {
  const f = await fixture()
  try {
    const { trace, debug } = await f.send('staticRead', [99])
    assert.equal(BigInt(trace.returnValue), 99n)
    const steps = debug.getTrace()
    for (const [index, step] of steps.entries()) {
      if (step.op === 'STATICCALL') {
        assert.equal(debug.traceManager.getCallDataAt(index + 1)[0], f.callee.interface.encodeFunctionData('read', [99]).slice(2))
      }
      if (step.op === 'RETURN') {
        assert.deepEqual(debug.traceManager.traceCache.returnValues[index], ['0x' + (99n).toString(16).padStart(64, '0')])
      }
    }
  } finally { f.close() }
})

test('source call trees retain raw-bytecode children and frame gas costs', { timeout: 20000 }, async () => {
  const f = await fixture()
  try {
    const { debug, trace } = await f.send('inspect', [1], true)
    const flatten = scopes => scopes.flatMap(scope => [scope, ...flatten(scope.children)])
    const external = flatten(debug.callTree.getScopesAsNestedJSON('call'))
    assert.deepEqual(external.map(scope => scope.opcodeInfo.op), ['CALL', 'STATICCALL'])
    assert.equal(external[1].address.toLowerCase(), f.probe.toLowerCase())
    const merged = flatten(debug.callTree.getScopesAsNestedJSON('nojump'))
    assert.ok(merged.some(scope => scope.opcodeInfo.op === 'STATICCALL'))
    const costs = debug.getTrace().map(step => step.gasCost)
    assert.deepEqual(costs, trace.structLogs.map(step => step.gasCost), 'source analysis preserves engine gas accounting')
  } finally { f.close() }
})

test('delegate storage survives a nested call and returns to the caller storage context', async () => {
  const f = await fixture()
  try {
    const { receipt, debug } = await f.send('delegateStore', [], true)
    assert.equal(receipt.status, '0x1')
    assert.equal(await (f.root as any).value(), 43n)
    assert.equal(await f.callee.value(), 0n)
    assert.equal(await f.leaf.value(), 7n)
    const stores = debug.getTrace().flatMap((step, index) => step.op === 'SSTORE' ? [{ step, index }] : [])
    assert.deepEqual(stores.map(({ step }) => hexWord(step.stack.at(-2))), [10n, 41n, 7n, 42n, 43n])
    const owners = [f.address, f.address, await f.leaf.getAddress(), f.address, f.address]
    const before = [0n, 10n, 0n, 41n, 42n]
    for (const [i, { step, index }] of stores.entries()) {
      assert.equal(await slot(debug, index, owners[i]), before[i], `storage before SSTORE ${i}`)
      assert.equal(await slot(debug, index + 1, owners[i]), hexWord(step.stack.at(-2)), `storage after SSTORE ${i}`)
      const decoded = await debug.decodeStateAt(index + 1, await debug.extractStateAt(index + 1)) as Record<string, { value: string }>
      assert.equal(BigInt(decoded.value.value), hexWord(step.stack.at(-2)), `decoded state after SSTORE ${i}`)
    }
  } finally { f.close() }
})

test('caught parent reverts discard successful descendant writes and logs in debugger history', async () => {
  const f = await fixture()
  try {
    const { receipt, trace, debug } = await f.send('caughtRevert', [], true)
    assert.equal(receipt.status, '0x1')
    assert.equal(abi.decode(['bytes'], trace.returnValue)[0], fault)
    assert.equal(receipt.logs.length, 1)
    assert.equal(f.root.interface.parseLog(receipt.logs[0]).args[0], fault)
    assert.equal(await (f.root as any).value(), 11n)
    assert.equal(await f.callee.value(), 0n)
    assert.equal(await f.leaf.value(), 0n)
    const steps = debug.getTrace()
    const leafStore = steps.findIndex(step => step.op === 'SSTORE' && step.depth === 3)
    assert.equal(await slot(debug, leafStore + 1, await f.leaf.getAddress()), 30n)
    const reverted = steps.findIndex(step => step.op === 'REVERT' && step.depth === 2)
    const calls = debug.callTree.getScopesAsNestedJSON('call')
    assert.equal(calls[0].lastStep, reverted, 'call-tree end matches the actual frame revert')
    assert.equal(await slot(debug, reverted, await f.leaf.getAddress()), 30n)
    assert.equal(await slot(debug, reverted + 1, await f.leaf.getAddress()), 0n)
    assert.equal(await slot(debug, reverted + 1, await f.callee.getAddress()), 0n)
    assert.equal(debug.traceManager.getCallDataAt(reverted + 1)[0].replace(/^0x/, ''), f.root.interface.encodeFunctionData('caughtRevert').slice(2))
    assert.equal(await slot(debug, steps.length - 1, f.address), 11n)
    assert.equal(await slot(debug, leafStore + 1, await f.leaf.getAddress()), 30n, 'backward navigation retains the pre-revert write')
  } finally { f.close() }
})

test('propagated reverts retain error data and roll back storage and logs', async () => {
  const f = await fixture()
  try {
    const { receipt, trace, debug } = await f.send('propagatedRevert')
    assert.equal(receipt.status, '0x0')
    assert.equal(trace.returnValue, fault)
    assert.deepEqual(receipt.logs, [])
    assert.equal(await (f.root as any).value(), 0n)
    assert.equal(await f.callee.value(), 0n)
    assert.equal(await f.leaf.value(), 0n)
    assert.equal(debug.getTrace().filter(step => step.op === 'REVERT').length, 2)
    await assert.rejects(f.local.request({ method: 'eth_call', params: [{ from: f.from, to: f.address, data: f.root.interface.encodeFunctionData('propagatedRevert') }]}), (error: any) => error.data === fault)
  } finally { f.close() }
})

test('caught out-of-gas and invalid extensions keep the parent trace usable', async () => {
  for (const fork of ['monad-next', 'monad-ten'] as const) {
    const f = await fixture(fork)
    try {
      for (const runtime of ['5b5f56', 'ae02', 'ae', ...(fork === 'monad-ten' ? ['ae005f5260205ff3', '5fae015f5260205ff3'] : [])]) {
        const len = (runtime.length / 2).toString(16).padStart(2, '0')
        const hash = await f.local.request({ method: 'eth_sendTransaction', params: [{ from: f.from, gas: '0xf4240', data: `0x60${len}600c60003960${len}6000f3${runtime}` }]})
        const { contractAddress } = await f.local.request({ method: 'eth_getTransactionReceipt', params: [hash]})
        const { receipt, trace, debug } = await f.send('catchHalt', [contractAddress])
        assert.equal(receipt.status, '0x1')
        assert.deepEqual(Array.from(abi.decode(['bool', 'bytes'], trace.returnValue)), [false, '0x'])
        assert.equal(await (f.root as any).value(), 14n)
        const steps = debug.getTrace()
        const failed = steps.findIndex(step => step.depth === 2 && step.error)
        assert.ok(failed >= 0)
        assert.match(steps[failed].error, runtime === '5b5f56' ? /OutOfGas/ : /Invalid|OpcodeNotFound/)
        assert.equal(steps[failed + 1].depth, 1)
        assert.equal(debug.traceManager.getCurrentCalledAddressAt(failed + 1).toLowerCase(), f.address.toLowerCase())
        assert.equal(await slot(debug, steps.length - 1, f.address), 14n)
      }
    } finally { f.close() }
  }
})

test('calls without a traced child do not create a source call frame', async () => {
  const f = await fixture()
  try {
    const { receipt, trace, debug } = await f.send('catchHalt', [f.from], true)
    assert.equal(receipt.status, '0x1')
    assert.deepEqual(Array.from(abi.decode(['bool', 'bytes'], trace.returnValue)), [true, '0x'])
    assert.ok(debug.getTrace().some(step => step.op === 'CALL'))
    assert.ok(debug.getTrace().every(step => step.depth === 1))
    assert.deepEqual(debug.callTree.getScopesAsNestedJSON('call'), [])
    assert.equal(await slot(debug, debug.getTrace().length - 1, f.address), 14n)
  } finally { f.close() }
})
