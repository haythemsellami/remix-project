import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import solc from 'solc'
import { BrowserProvider, Interface, Transaction, Wallet, concat, decodeRlp, encodeRlp, hexlify, keccak256, parseEther, toBeArray, toQuantity, ZeroAddress, ZeroHash } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider } from '../src/provider'
/* eslint-disable @nrwl/nx/enforce-module-boundaries -- Exercise delegated execution through the IDE debugger. */
import { extendProvider, getTransactionForDebugging } from '../../remix-debug/src/init'
import { Ethdebugger } from '../../remix-debug/src/Ethdebugger'
import { CompilerAbstract } from '@remix-project/remix-solidity'
import { convertOffsetToLineColumn, getLinebreakPositions } from '../../remix-debug/src/source/sourceMappingDecoder'
/* eslint-enable @nrwl/nx/enforce-module-boundaries */

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const file = 'DelegatedAccount.sol'
const source = readFileSync(`libs/remix-monad/examples/${file}`, 'utf8')
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [file]: { content: source } },
  settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'], '': ['ast']} } }
})))
assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), [])
const artifact = compiled.contracts[file].DelegatedAccount
const abi = new Interface(artifact.abi)

async function fixture(fork: 'monad-ten' | 'monad-next', stateDb?: any) {
  const engine = new Engine(fork, 1337)
  const local = new MonadProvider({ fork, stateDb }, engine)
  await local.init()
  const web3 = new BrowserProvider(local, undefined, { cacheTimeout: -1 })
  extendProvider(web3)
  const request = (method: string, ...params: any[]) => local.request({ method, params })
  const [payer, authority, recipient] = await request('eth_accounts')
  const wallet = new Wallet(hexlify(await request('eth_getPKey', authority)))
  const payerWallet = new Wallet(hexlify(await request('eth_getPKey', payer)))
  const nonce = async address => Number(BigInt(await request('eth_getTransactionCount', address)))
  const send = async (tx: any) => {
    const hash = await request('eth_sendTransaction', { from: payer, gas: '0x2dc6c0', ...tx })
    return { hash, receipt: await request('eth_getTransactionReceipt', hash), trace: await request('debug_traceTransaction', hash) }
  }
  const authorize = async (address: string, options = {}) => wallet.authorize({ chainId: 1337, address, nonce: await nonce(authority), ...options })
  const debug = async hash => {
    const compilation = new CompilerAbstract('json', compiled, { target: file, sources: { [file]: { content: source } } })
    const instance = new Ethdebugger({ web3, compilationResult: async () => compilation,
      offsetToLineColumnConverter: { offsetToLineColumn: async location => convertOffsetToLineColumn(location, getLinebreakPositions(source)) } })
    const ready = new Promise<void>((resolve, reject) => {
      instance.callTree.event.register('callTreeReady', () => resolve())
      instance.callTree.event.register('callTreeBuildFailed', reject)
      instance.callTree.event.register('callTreeNotReady', reject)
    })
    await instance.debug((await getTransactionForDebugging(web3, hash)).toJSON())
    await ready
    return instance
  }
  return { engine, local, web3, request, payer, authority, recipient, wallet, payerWallet, nonce, send, authorize, debug,
    deploy: async () => (await send({ data: '0x' + artifact.evm.bytecode.object })).receipt.contractAddress as string,
    close: () => { web3.destroy(); engine.free() } }
}

async function inspectStore(f: Awaited<ReturnType<typeof fixture>>, hash: string, expected: number) {
  const debug = await f.debug(hash)
  const steps = debug.getTrace()
  const index = steps.findIndex(step => step.op === 'SSTORE')
  assert.ok(index >= 0)
  assert.equal(debug.traceManager.getCurrentCalledAddressAt(index).toLowerCase(), f.authority.toLowerCase())
  const location = await debug.callTree.extractSourceLocation(index) as { start: number; length: number }
  assert.match(source.slice(location.start, location.start + location.length), /value = newValue/)
  const decoded = await debug.decodeStateAt(index + 1, await debug.extractStateAt(index + 1)) as any
  assert.equal(BigInt(decoded.value.value), BigInt(expected))
  assert.equal(steps[index].op, 'SSTORE')
  return debug
}

test('the Monad debugger transaction fallback preserves errors from other providers', async () => {
  const error = Object.assign(new Error('Invalid authorization format'), { code: 'BAD_DATA', value: { type: '0x4', authorizationList: []} })
  const provider = { getTransaction: async () => { throw error }, send: async method => {
    assert.equal(method, 'web3_clientVersion')
    return 'Ethereum/test-client'
  } }
  await assert.rejects(getTransactionForDebugging(provider, ZeroHash), caught => caught === error)
  provider.send = async () => { throw new Error('Unsupported RPC method') }
  await assert.rejects(getTransactionForDebugging(provider, ZeroHash), caught => caught === error)
})

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: invalid authorization signatures are skipped without rejecting signed or unlocked transactions`, async () => {
    const f = await fixture(fork)
    try {
      const target = await f.deploy()
      for (const raw of [true, false]) {
        const authorization = await f.authorize(target)
        const valid = { chainId: toQuantity(authorization.chainId), address: authorization.address, nonce: toQuantity(authorization.nonce),
          yParity: authorization.signature.yParity, r: authorization.signature.r, s: authorization.signature.s }
        const highS = '0x' + 'ff'.repeat(32)
        const authorizations = [{ ...valid, yParity: 2 }, { ...valid, s: highS }, valid]
        const input = { to: f.authority, type: 4, data: abi.encodeFunctionData('store', [42]), gasLimit: 30_000_000,
          chainId: 1337, nonce: await f.nonce(f.payer), maxFeePerGas: 1_000_000_000, maxPriorityFeePerGas: 1_000_000_000 }
        const before = f.engine.snapshot()
        await f.request('eth_call', { ...input, from: f.payer, authorizationList: authorizations })
        await assert.rejects(f.request('eth_sendTransaction', { ...input, from: f.payer, authorizationList: [{ ...valid, yParity: 256 }]}), /authorization quantity/)
        assert.equal(f.engine.snapshot(), before)
        let hash: string
        if (raw) {
          // Sign the envelope independently: ethers rejects these inner signatures before Rust sees them.
          const tx = Transaction.from({ ...input, authorizationList: [authorization]})
          const fields = decodeRlp('0x' + tx.unsignedSerialized.slice(4)) as any[]
          const quantity = value => hexlify(toBeArray(value))
          fields[9] = authorizations.map(auth => [quantity(auth.chainId), auth.address, quantity(auth.nonce), quantity(auth.yParity), quantity(auth.r), quantity(auth.s)])
          const signature = f.payerWallet.signingKey.sign(keccak256(concat(['0x04', encodeRlp(fields)])))
          const encoded = concat(['0x04', encodeRlp([...fields, quantity(signature.yParity), quantity(signature.r), quantity(signature.s)])])
          const noncanonical = concat(['0x04', encodeRlp(['0x000539', ...fields.slice(1), quantity(signature.yParity), quantity(signature.r), quantity(signature.s)])])
          await assert.rejects(f.request('eth_sendRawTransaction', noncanonical), /Noncanonical/)
          await assert.rejects(f.request('eth_sendRawTransaction', tx.unsignedSerialized), /Invalid signed/)
          hash = await f.request('eth_sendRawTransaction', encoded)
          assert.equal(hash, keccak256(encoded))
        } else {
          hash = await f.request('eth_sendTransaction', { ...input, from: f.payer, authorizationList: authorizations })
        }
        assert.equal((await f.request('eth_getTransactionReceipt', hash)).status, '0x1')
        const tx = await f.request('eth_getTransactionByHash', hash)
        assert.equal(tx.authorizationList[0].yParity, '0x2')
        assert.equal(tx.authorizationList[1].s, highS)
        assert.equal(tx.authorizationList.length, 3)
        assert.deepEqual((await getTransactionForDebugging(f.web3, hash)).toJSON().authorizationList, tx.authorizationList)
        assert.equal(await f.nonce(f.authority), raw ? 1 : 2)
        assert.equal(await f.request('eth_getCode', f.authority), '0xef0100' + target.slice(2).toLowerCase())
        await inspectStore(f, hash, 42)
      }
    } finally { f.close() }
  })

  test(`${fork}: typed calls, signed transactions, delegation and historical source debugging`, { timeout: 30_000 }, async () => {
    const f = await fixture(fork)
    let restored: Awaited<ReturnType<typeof fixture>>
    try {
      const target = await f.deploy()
      const auth = await f.authorize(target)
      const input = { from: f.payer, to: f.authority, type: 4, data: abi.encodeFunctionData('store', [42]), authorizationList: [auth],
        accessList: [{ address: f.authority, storageKeys: [ZeroHash]}], maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', gas: '0x2dc6c0' }
      const before = f.engine.snapshot()
      await f.request('eth_registerCallId', 'delegation-simulation')
      await f.request('eth_call', input)
      const simulationHash = await f.request('eth_getHashFromTagBySimulator', 'delegation-simulation')
      await inspectStore(f, simulationHash, 42)
      const gas = await f.request('eth_estimateGas', input)
      assert.ok(BigInt(gas) > 21000n)
      assert.equal(f.engine.snapshot(), before)
      const raw = await f.payerWallet.signTransaction({ ...input, gasLimit: input.gas, chainId: 1337, nonce: await f.nonce(f.payer) })
      const hash = await f.request('eth_sendRawTransaction', raw)
      const tx = await f.request('eth_getTransactionByHash', hash)
      const receipt = await f.request('eth_getTransactionReceipt', hash)
      assert.equal(tx.type, '0x4')
      assert.equal(tx.authorizationList.length, 1)
      assert.equal(BigInt(tx.authorizationList[0].chainId), 1337n)
      assert.deepEqual(tx.accessList, input.accessList)
      assert.equal(receipt.status, '0x1')
      assert.equal(BigInt(receipt.gasUsed), 3_000_000n)
      assert.equal(receipt.effectiveGasPrice, '0x3b9aca00')
      assert.equal(await f.nonce(f.authority), 1)
      assert.equal(await f.request('eth_getCode', f.authority), '0xef0100' + target.slice(2).toLowerCase())
      assert.equal(BigInt(await f.request('eth_getStorageAt', f.authority, ZeroHash)), 42n)
      assert.equal(BigInt(await f.request('eth_getStorageAt', target, ZeroHash)), 0n)
      assert.equal(receipt.logs[0].address.toLowerCase(), f.authority.toLowerCase())
      await inspectStore(f, hash, 42)
      for (const type of [1, 2]) {
        const request = { to: f.authority, type, data: abi.encodeFunctionData('store', [40 + type]), accessList: input.accessList }
        const sent = await f.send(request)
        assert.equal(sent.receipt.status, '0x1')
        assert.deepEqual((await f.request('eth_getTransactionByHash', sent.hash)).accessList, input.accessList)
        await inspectStore(f, sent.hash, 40 + type)
      }
      const revoked = await f.send({ to: f.authority, type: 4, authorizationList: [await f.authorize(ZeroAddress)]})
      assert.equal(revoked.receipt.status, '0x1')
      assert.equal(await f.request('eth_getCode', f.authority), '0x')
      // Inspect an earlier transaction after its executing account has lost its code.
      await inspectStore(f, hash, 42)
      restored = await fixture(fork, await f.request('eth_getStateDb'))
      assert.equal(await restored.request('eth_getCode', f.authority), '0x')
      await inspectStore(restored, hash, 42)
      const state = restored.engine.snapshot()
      await assert.rejects(restored.request('eth_sendTransaction', { to: f.authority, type: 4, authorizationList: []}), /nonempty/)
      await assert.rejects(restored.request('eth_sendTransaction', { to: f.authority, type: 3 }), /unsupported/)
      assert.equal(restored.engine.snapshot(), state)
    } finally { restored?.close(); f.close() }
  })

  test(`${fork}: authorizations survive caller failure and reserve rules use saved block participants`, { timeout: 30_000 }, async () => {
    const f = await fixture(fork)
    let restored: Awaited<ReturnType<typeof fixture>>
    try {
      const target = await f.deploy()
      const failed = await f.send({ to: f.authority, type: 4, authorizationList: [await f.authorize(target)], data: abi.encodeFunctionData('reject') })
      assert.equal(failed.receipt.status, '0x0')
      assert.deepEqual(failed.receipt.logs, [])
      assert.equal(await f.nonce(f.authority), 1)
      assert.equal(await f.request('eth_getCode', f.authority), '0xef0100' + target.slice(2).toLowerCase())
      assert.equal(BigInt(await f.request('eth_getStorageAt', f.authority, ZeroHash)), 0n)
      const debug = await f.debug(failed.hash)
      const steps = debug.getTrace()
      assert.equal(steps.at(-1).op, 'REVERT')
      const decoded = await debug.decodeStateAt(steps.length - 1, await debug.extractStateAt(steps.length - 1)) as any
      assert.equal(BigInt(decoded.value.value), 99n)
      for (const method of ['createChild', 'createChild2']) {
        const transaction = await f.send({ to: f.authority, data: abi.encodeFunctionData(method) })
        assert.equal(transaction.receipt.status, '0x0')
        assert.ok(transaction.trace.structLogs.some(step => step.op === (method.endsWith('2') ? 'CREATE2' : 'CREATE')))
      }
      f.engine.fund(f.authority, toQuantity(parseEther('12')))
      const recipientBefore = await f.request('eth_getBalance', f.recipient)
      const reserve = await f.send({ to: f.authority, data: abi.encodeFunctionData('transfer', [f.recipient, parseEther('4')]) })
      assert.equal(reserve.receipt.status, '0x0')
      assert.equal(await f.request('eth_getBalance', f.recipient), recipientBefore)
      await f.send({ to: f.authority, type: 4, authorizationList: [await f.authorize(ZeroAddress)]})
      restored = await fixture(fork, await f.request('eth_getStateDb'))
      const spend = { from: f.authority, to: f.recipient, value: toQuantity(parseEther('4')), gasPrice: '0x0' }
      const rejected = await restored.send(spend)
      assert.equal(rejected.receipt.status, '0x0', 'revoked authority remains protected in recent block history')
      assert.equal(await restored.request('eth_getBalance', f.recipient), recipientBefore)
      await restored.send({ to: f.payer })
      await restored.send({ to: f.payer })
      const allowed = await restored.send(spend)
      assert.equal(allowed.receipt.status, '0x1', 'undelegated sender may spend after two intervening blocks')
      assert.equal(BigInt(await restored.request('eth_getBalance', f.authority)), parseEther('8'))
    } finally { restored?.close(); f.close() }
  })
}
