import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import solc from 'solc'
import { AbiCoder, BrowserProvider, Contract, getAddress, getCreateAddress, getCreate2Address, keccak256, toBeHex, ZeroHash } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider } from '../src/provider'
/* eslint-disable @nrwl/nx/enforce-module-boundaries -- Exercise the same library linker and debugger used by the IDE. */
import { linkBytecode } from '../../remix-lib/src/execution/txFormat'
import { extendProvider } from '../../remix-debug/src/init'
import { Ethdebugger } from '../../remix-debug/src/Ethdebugger'
import { CompilerAbstract } from '@remix-project/remix-solidity'
import { convertOffsetToLineColumn, getLinebreakPositions } from '../../remix-debug/src/source/sourceMappingDecoder'
/* eslint-enable @nrwl/nx/enforce-module-boundaries */

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const file = 'FactoryDeployments.sol'
const source = readFileSync(`libs/remix-monad/examples/${file}`, 'utf8')
const compiled = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources: { [file]: { content: source } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'], '': ['ast']} } }
})))
assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), [])
const abi = AbiCoder.defaultAbiCoder()
const salt = toBeHex(123, 32)
const flatten = scopes => scopes.flatMap(scope => [scope, ...flatten(scope.children)])

async function fixture(fork: 'monad-next' | 'monad-ten') {
  const engine = new Engine(fork, 1337)
  const local = new MonadProvider({ fork }, engine)
  await local.init()
  const web3 = new BrowserProvider(local, undefined, { cacheTimeout: -1 })
  extendProvider(web3)
  const request = (method: string, ...params: any[]) => local.request({ method, params })
  const [from] = await request('eth_accounts')
  const artifacts = structuredClone(compiled.contracts)
  const send = async (to: string, data: string, value = 0n) => {
    const hash = await request('eth_sendTransaction', { from, to, data, value: toBeHex(value), gas: '0x2dc6c0' })
    return { hash, receipt: await request('eth_getTransactionReceipt', hash), trace: await request('debug_traceTransaction', hash) }
  }
  const libraries: string[] = []
  const link = artifact => linkBytecode(artifact, artifacts, async ({ data }, callback) => {
    try {
      const { receipt } = await send(null, '0x' + data.dataHex)
      assert.equal(receipt.status, '0x1')
      libraries.push(getAddress(receipt.contractAddress))
      callback(null, { receipt })
    } catch (error) { callback(error) }
  })
  const factoryCode = await link(artifacts[file].FactoryDeployments)
  assert.equal(libraries.length, 1, 'the Remix linker deploys the required external library once')
  const childCode = await link(artifacts[file].FactoryChild)
  assert.equal(libraries.length, 1, 'the child reuses the linked library')
  const { receipt } = await send(null, '0x' + factoryCode)
  assert.equal(receipt.status, '0x1')
  const address = getAddress(receipt.contractAddress)
  const factory = new Contract(address, artifacts[file].FactoryDeployments.abi, web3)
  const child = address => new Contract(address, artifacts[file].FactoryChild.abi, web3)
  const creationCode = (initial: number, reject = false) => '0x' + childCode + abi.encode(['uint256', 'bool'], [initial, reject]).slice(2)
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
  return { engine, local, web3, request, send, factory, address, libraries, child, creationCode, debug,
    invoke: (name: string, args: any[] = [], value = 0n) => send(address, factory.interface.encodeFunctionData(name, args), value),
    close: () => { web3.destroy(); engine.free() } }
}

async function slot(debug: Ethdebugger, index: number, address: string) {
  return new Promise<bigint>((resolve, reject) => {
    debug.storageViewAt(index, address).storageSlot(ZeroHash, (error, value) => error ? reject(error) : resolve(BigInt(value?.value || 0)))
  })
}

for (const fork of ['monad-ten', 'monad-next'] as const) {
  for (const opcode of ['CREATE', 'CREATE2']) {
    test(`${fork}: ${opcode} links libraries and preserves child constructor source, state and value`, { timeout: 20_000 }, async () => {
      const f = await fixture(fork)
      try {
        const expected = opcode === 'CREATE'
          ? getCreateAddress({ from: f.address, nonce: await f.request('eth_getTransactionCount', f.address) })
          : getCreate2Address(f.address, salt, keccak256(f.creationCode(42)))
        const { hash, receipt } = await f.invoke(opcode === 'CREATE' ? 'create' : 'create2', opcode === 'CREATE' ? [42] : [salt, 42], 7n)
        assert.equal(receipt.status, '0x1')
        assert.equal(receipt.contractAddress, null, 'the outer call is not a top-level deployment')
        assert.equal(await f.factory.lastChild(), expected)
        const child = f.child(expected)
        assert.equal(await child.value(), 42n)
        assert.equal(await child.creator(), f.address)
        assert.equal(BigInt(await f.request('eth_getBalance', expected)), 7n)
        assert.equal(BigInt(await f.request('eth_getBalance', f.address)), 0n)
        assert.deepEqual(receipt.logs.map(log => getAddress(log.address)), [expected, f.address])
        assert.equal(child.interface.parseLog(receipt.logs[0]).args[0], 42n)
        assert.equal(f.factory.interface.parseLog(receipt.logs[1]).args[0], expected)
        const code = await f.request('eth_getCode', expected)
        assert.ok(code.includes(f.libraries[0].slice(2).toLowerCase()), 'deployed child contains the linked library address')

        const debug = await f.debug(hash)
        const trace = debug.getTrace()
        const creation = trace.findIndex(step => step.op === opcode)
        assert.ok(creation >= 0)
        assert.equal(trace[creation + 1].depth, 2)
        assert.equal(trace[creation + 1].pc, 0)
        const token = debug.traceManager.getCurrentCalledAddressAt(creation + 1)
        assert.equal(debug.traceManager.getContractCreationCode(token).toLowerCase(), f.creationCode(42).toLowerCase())
        const store = trace.findIndex(step => step.depth === 2 && step.op === 'SSTORE')
        assert.equal(await slot(debug, store, token), 0n)
        assert.equal(await slot(debug, store + 1, token), 42n)
        const decoded = await debug.decodeStateAt(store + 1, await debug.extractStateAt(store + 1)) as any
        assert.equal(BigInt(decoded.value.value), 42n)
        const location = await debug.callTree.extractSourceLocation(store) as { start: number; length: number }
        assert.equal(source.slice(location.start, location.start + location.length), 'value = initial')
        const scope = flatten(debug.callTree.getScopesAsNestedJSON('call')).find(scope => scope.opcodeInfo.op === opcode)
        assert.ok(scope, 'constructor has its own source call frame')
        for (let index = creation + 1; trace[index]?.depth === 2; index++) {
          const code = await debug.codeManager.getCode(token)
          assert.notEqual(code.instructionsIndexByBytesOffset[trace[index].pc], undefined)
        }
        assert.equal(await slot(debug, store, token), 0n, 'backward inspection restores the pre-write constructor state')
      } finally { f.close() }
    })
  }

  test(`${fork}: failed constructors and CREATE2 collisions roll back child code, storage, value and logs`, { timeout: 20_000 }, async () => {
    const f = await fixture(fork)
    try {
      const rejected = getCreate2Address(f.address, salt, keccak256(f.creationCode(99, true)))
      const fault = f.child(rejected).interface.encodeErrorResult('ConstructorRejected', [99])
      const failed = await f.invoke('rejectCreate2', [salt], 7n)
      assert.equal(failed.receipt.status, '0x1', 'the factory catches the constructor revert')
      assert.equal(failed.receipt.logs.length, 1, 'reverted constructor events are discarded')
      assert.equal(f.factory.interface.parseLog(failed.receipt.logs[0]).args[0], fault)
      assert.equal(await f.request('eth_getCode', rejected), '0x')
      assert.equal(await f.request('eth_getStorageAt', rejected, '0x0'), ZeroHash)
      assert.equal(BigInt(await f.request('eth_getBalance', rejected)), 0n)
      assert.equal(BigInt(await f.request('eth_getBalance', f.address)), 7n)
      const debug = await f.debug(failed.hash)
      const trace = debug.getTrace()
      const store = trace.findIndex(step => step.depth === 2 && step.op === 'SSTORE')
      const token = debug.traceManager.getCurrentCalledAddressAt(store)
      const revert = trace.findIndex(step => step.depth === 2 && step.op === 'REVERT')
      assert.equal(await slot(debug, store + 1, token), 99n)
      assert.equal(await slot(debug, revert + 1, token), 0n)
      assert.equal(await slot(debug, store + 1, token), 99n, 'the reverted constructor remains inspectable')

      await f.invoke('create2', [salt, 42], 5n)
      const address = await f.factory.lastChild()
      const before = JSON.parse(f.engine.account(address))
      const collision = await f.invoke('create2', [salt, 42], 11n)
      assert.equal(collision.receipt.status, '0x0')
      assert.deepEqual(collision.receipt.logs, [])
      assert.deepEqual(JSON.parse(f.engine.account(address)), before)
      assert.equal(BigInt(await f.request('eth_getBalance', f.address)), 7n)
      const collisionDebug = await f.debug(collision.hash)
      assert.ok(collisionDebug.getTrace().some(step => step.op === 'CREATE2'))
      assert.ok(collisionDebug.getTrace().every(step => step.depth === 1), 'collision executes no constructor')
      assert.deepEqual(collisionDebug.callTree.getScopesAsNestedJSON('call'), [])
    } finally { f.close() }
  })

  test(`${fork}: a factory child executes its linked library and debugs the correct source and storage`, { timeout: 20_000 }, async () => {
    const f = await fixture(fork)
    try {
      await f.invoke('create2', [salt, 42])
      const address = await f.factory.lastChild()
      const child = f.child(address)
      const { hash, receipt } = await f.send(address, child.interface.encodeFunctionData('storeWithLibrary', [76]))
      assert.equal(receipt.status, '0x1')
      assert.equal(await child.value(), 77n)
      assert.equal(getAddress(receipt.logs[0].address), address)
      assert.equal(child.interface.parseLog(receipt.logs[0]).args[0], 77n)
      assert.equal(await f.request('eth_getStorageAt', f.libraries[0], '0x0'), ZeroHash)
      const debug = await f.debug(hash)
      const trace = debug.getTrace()
      const call = trace.findIndex(step => step.op === 'DELEGATECALL')
      assert.ok(call >= 0)
      assert.equal(getAddress(debug.traceManager.getCurrentCalledAddressAt(call + 1)), f.libraries[0])
      const scope = flatten(debug.callTree.getScopesAsNestedJSON('call')).find(scope => scope.opcodeInfo.op === 'DELEGATECALL')
      assert.equal(getAddress(scope.address), f.libraries[0])
      assert.equal((await debug.solidityProxy.contractObjectAt(call + 1)).name, 'LinkedValues')
      const store = trace.findIndex(step => step.op === 'SSTORE')
      assert.equal(await slot(debug, store, address), 42n)
      assert.equal(await slot(debug, store + 1, address), 77n)
      const decoded = await debug.decodeStateAt(store + 1, await debug.extractStateAt(store + 1)) as any
      assert.equal(BigInt(decoded.value.value), 77n)
    } finally { f.close() }
  })
}
