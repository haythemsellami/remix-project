import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import solc from 'solc'
import { AbiCoder, BrowserProvider, Contract, toBeHex, ZeroHash } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider } from '../src/provider'
/* eslint-disable @nrwl/nx/enforce-module-boundaries -- Exercise the IDE debugger with real precompile traces. */
import { extendProvider } from '../../remix-debug/src/init'
import { Ethdebugger } from '../../remix-debug/src/Ethdebugger'
import { CompilerAbstract } from '@remix-project/remix-solidity'
import { convertOffsetToLineColumn, getLinebreakPositions } from '../../remix-debug/src/source/sourceMappingDecoder'
/* eslint-enable @nrwl/nx/enforce-module-boundaries */

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const file = 'PrecompileCalls.sol'
const source = readFileSync(`libs/remix-monad/examples/${file}`, 'utf8')
const vectors = JSON.parse(readFileSync('libs/remix-monad/test/fixtures/precompiles.json', 'utf8'))
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { [file]: { content: source } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'], '': ['ast']} } }
})))
assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), [])
const abi = AbiCoder.defaultAbiCoder()
const hexWord = (value: string) => BigInt('0x' + value)

async function fixture(fork: 'monad-ten' | 'monad-next') {
  const engine = new Engine(fork, 1337)
  const local = new MonadProvider({ fork }, engine)
  await local.init()
  const web3 = new BrowserProvider(local, undefined, { cacheTimeout: -1 })
  extendProvider(web3)
  const request = (method: string, ...params: any[]) => local.request({ method, params })
  const [from] = await request('eth_accounts')
  const send = async (to: string, data: string) => {
    const hash = await request('eth_sendTransaction', { from, to, data, gas: '0x2dc6c0' })
    return { hash, receipt: await request('eth_getTransactionReceipt', hash), trace: await request('debug_traceTransaction', hash) }
  }
  const artifact = compiled.contracts[file].PrecompileCalls
  const deployed = await send(null, '0x' + artifact.evm.bytecode.object)
  assert.equal(deployed.receipt.status, '0x1')
  const address = deployed.receipt.contractAddress
  const contract = new Contract(address, artifact.abi, web3)
  const debug = async hash => {
    const compilation = new CompilerAbstract('json', compiled, { target: file, sources: { [file]: { content: source } } })
    const instance = new Ethdebugger({ web3, compilationResult: async () => compilation,
      offsetToLineColumnConverter: { offsetToLineColumn: async location => convertOffsetToLineColumn(location, getLinebreakPositions(source)) }
    })
    const ready = new Promise<void>((resolve, reject) => {
      instance.callTree.event.register('callTreeReady', () => resolve())
      instance.callTree.event.register('callTreeBuildFailed', reject)
      instance.callTree.event.register('callTreeNotReady', reject)
    })
    await instance.debug((await web3.getTransaction(hash)).toJSON())
    await ready
    return instance
  }
  return { engine, request, from, address, contract, debug,
    invoke: (name: string, args: any[] = []) => send(address, contract.interface.encodeFunctionData(name, args)),
    close: () => { web3.destroy(); engine.free() } }
}

async function slot(debug: Ethdebugger, index: number, address: string) {
  return new Promise<bigint>((resolve, reject) => {
    debug.storageViewAt(index, address).storageSlot(ZeroHash, (error, value) => error ? reject(error) : resolve(BigInt(value?.value || 0)))
  })
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: precompile outputs, gas and source debugging survive the provider bridge`, { timeout: 30_000 }, async () => {
    const f = await fixture(fork)
    try {
      for (const vector of vectors) {
        const target = toBeHex(vector.address, 20)
        const args = [target, vector.input, vector.gas]
        const before = f.engine.snapshot()
        const simulated = await f.request('eth_call', { from: f.from, to: f.address, data: f.contract.interface.encodeFunctionData('runPrecompile', args) })
        assert.deepEqual(Array.from(abi.decode(['bool', 'bytes'], simulated)), [vector.success, vector.output], vector.name)
        assert.equal(f.engine.snapshot(), before, 'eth_call leaves contract state unchanged')
        const { hash, receipt, trace } = await f.invoke('runPrecompile', args)
        assert.equal(receipt.status, '0x1', vector.name)
        assert.equal(BigInt(receipt.gasUsed), 3_000_000n)
        assert.deepEqual(Array.from(abi.decode(['bool', 'bytes'], trace.returnValue)), [vector.success, vector.output])
        assert.equal(await f.contract.result(), vector.output)
        assert.equal(await f.contract.lastSuccess(), vector.success)
        assert.deepEqual(Array.from(f.contract.interface.parseLog(receipt.logs[0]).args), [vector.success, vector.output])
        const debug = await f.debug(hash)
        const steps = debug.getTrace()
        const call = steps.findIndex(step => step.op === 'STATICCALL')
        assert.ok(call >= 0, vector.name)
        assert.equal(hexWord(steps[call].stack.at(-2)), BigInt(vector.address))
        assert.equal(hexWord(steps[call + 1].stack.at(-1)), BigInt(vector.success))
        assert.equal(steps[call].gas - steps[call + 1].gas, 100 + vector.gas)
        assert.ok(steps.every(step => step.depth === 1), 'precompiles have no bytecode trace frame')
        assert.deepEqual(debug.callTree.getScopesAsNestedJSON('call'), [])
        assert.equal(debug.traceManager.getCurrentCalledAddressAt(call + 1).toLowerCase(), f.address.toLowerCase())
        const location = await debug.callTree.extractSourceLocation(call) as { start: number; length: number }
        assert.match(source.slice(location.start, location.start + location.length), /target\.staticcall/)
        if (vector.output !== '0x') {
          const copy = steps.findIndex((step, index) => index > call && step.op === 'RETURNDATACOPY')
          assert.ok(copy > call)
          const offset = Number(hexWord(steps[copy].stack.at(-1)))
          const length = Number(hexWord(steps[copy].stack.at(-3)))
          const memory: unknown = steps[copy + 1].memory
          assert.ok(memory instanceof Uint8Array)
          assert.equal('0x' + Buffer.from(memory).subarray(offset, offset + length).toString('hex'), vector.output)
        }
        const decoded = await debug.decodeStateAt(steps.length - 1, await debug.extractStateAt(steps.length - 1)) as any
        assert.equal(BigInt(decoded.value.value), vector.success ? 42n : 11n)
        assert.deepEqual(steps.map(step => step.gasCost), trace.structLogs.map(step => step.gasCost))
      }
    } finally { f.close() }
  })

  test(`${fork}: rejected and out-of-gas precompiles can be caught or propagated without losing debug state`, { timeout: 30_000 }, async () => {
    const f = await fixture(fork)
    try {
      for (const [name, gas] of [['invalidPoint', 1000], ['insufficientGas', 71]] as const) {
        const { hash, receipt, trace } = await f.invoke(name)
        assert.equal(receipt.status, '0x1')
        assert.deepEqual(Array.from(abi.decode(['bool', 'bytes'], trace.returnValue)), [false, '0x'])
        assert.equal(await f.contract.value(), 11n)
        const debug = await f.debug(hash)
        const steps = debug.getTrace()
        const call = steps.findIndex(step => step.op === 'STATICCALL')
        assert.equal(steps[call].gas - steps[call + 1].gas, 100 + gas)
        assert.equal(hexWord(steps[call + 1].stack.at(-1)), 0n)
        assert.ok(steps.every(step => step.depth === 1))
        assert.deepEqual(debug.callTree.getScopesAsNestedJSON('call'), [])
        assert.equal(await slot(debug, steps.length - 1, f.address), 11n)
      }
      const fault = f.contract.interface.encodeErrorResult('PrecompileFailed', [toBeHex(6, 20)])
      const failed = await f.invoke('requireValidPoint')
      assert.equal(failed.receipt.status, '0x0')
      assert.equal(failed.trace.returnValue, fault)
      assert.deepEqual(failed.receipt.logs, [])
      assert.equal(await f.contract.value(), 11n, 'the caller write is rolled back')
      const debug = await f.debug(failed.hash)
      const steps = debug.getTrace()
      const store = steps.findIndex(step => step.op === 'SSTORE')
      assert.equal(await slot(debug, store, f.address), 11n)
      assert.equal(await slot(debug, store + 1, f.address), 99n)
      assert.equal(steps.at(-1).op, 'REVERT')
      assert.equal(await slot(debug, steps.length - 1, f.address), 99n, 'the reverted write remains inspectable')
      assert.equal(await slot(debug, store, f.address), 11n, 'backward navigation restores the prior state')
      await assert.rejects(f.request('eth_call', { from: f.from, to: f.address, data: f.contract.interface.encodeFunctionData('requireValidPoint') }), (error: any) => error.data === fault)
    } finally { f.close() }
  })
}
