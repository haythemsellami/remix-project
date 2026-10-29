import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import solc from 'solc'
import { BrowserProvider } from 'ethers'
import init, { Engine } from 'monad-revmjs'
import { MonadProvider } from '../src/provider'
/* eslint-disable @nrwl/nx/enforce-module-boundaries -- Exercise the existing test runner against the Monad backend. */
import { deployAll } from '../../remix-tests/src/deployer'
import { runTest } from '../../remix-tests/src/testRunner'
import { writeTestAccountsContract } from '../../remix-tests/src/compiler'
import { extendProvider } from '../../remix-simulator/src/provider'
import { Ethdebugger } from '../../remix-debug/src/Ethdebugger'
import { extendProvider as extendDebugger } from '../../remix-debug/src/init'
/* eslint-enable @nrwl/nx/enforce-module-boundaries */

await init({ module_or_path: readFileSync(new URL(await import.meta.resolve('monad-revmjs/wasm'))) })
const filename = 'MonadUnit_test.sol'
const source = readFileSync(`libs/remix-monad/examples/${filename}`, 'utf8')
const assertCode = require('../../remix-tests/sol/tests.sol') // eslint-disable-line @typescript-eslint/no-var-requires

for (const fork of ['monad-ten', 'monad-next'] as const) {
  test(`${fork}: Solidity runner reports assertions, reverts, calls, hooks, senders and fork-specific opcodes`, { timeout: 60_000 }, async () => {
    const engine = new Engine(fork, 1337)
    const local = new MonadProvider({ fork }, engine)
    await local.init()
    const provider = new BrowserProvider(local, undefined, { cacheTimeout: -1 })
    extendProvider(provider)
    extendDebugger(provider)
    try {
      const accounts = await provider.send('eth_accounts', [])
      const compiled = JSON.parse(solc.compile(JSON.stringify({
        language: 'Solidity', sources: {
          [filename]: { content: source }, 'remix_tests.sol': { content: assertCode },
          'remix_accounts.sol': { content: writeTestAccountsContract(accounts) },
          'hardhat/console.sol': { content: readFileSync('node_modules/hardhat/console.sol', 'utf8') }
        },
        settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'evm.methodIdentifiers', 'userdoc'], '': ['ast']} } }
      })))
      assert.deepEqual((compiled.errors || []).filter(error => error.severity === 'error'), [])
      const contracts: any = await new Promise((resolve, reject) => deployAll(compiled.contracts, provider, accounts, false, null,
        (error, contracts) => error ? reject(error) : resolve(contracts)))
      const results: any[] = []
      const summary: any = await new Promise((resolve, reject) => runTest('MonadUnitTest', contracts.MonadUnitTest,
        compiled.contracts[filename].MonadUnitTest, compiled.sources[filename].ast, { provider, accounts },
        (error, result) => error ? reject(error) : results.push(result), (error, summary) => error ? reject(error) : resolve(summary)))
      assert.equal(summary.passingNum, fork === 'monad-next' ? 4 : 3)
      assert.equal(summary.failureNum, fork === 'monad-next' ? 3 : 4)
      const cases = new Map(results.filter(result => result.debugTxHash).map(result => [result.value, result]))
      assert.equal(cases.size, 7)
      assert.deepEqual(cases.get('Test store').hhLogs, [['monad-store', '42', true, accounts[0]]])
      assert.deepEqual(cases.get('Test assertion failure').hhLogs, [['monad-assertion']])
      assert.deepEqual(cases.get('Test revert').hhLogs, [['monad-revert']])
      assert.deepEqual(cases.get('Test read only').hhLogs, [['monad-view', '41']])
      assert.equal(cases.get('Test read only failure').errMsg, 'function returned false')
      for (const result of cases.values()) {
        assert.equal(result.provider, provider)
        const tx = await provider.getTransaction(result.debugTxHash)
        const debuggerInstance = new Ethdebugger({ web3: provider, compilationResult: async () => null })
        await debuggerInstance.debug(tx.toJSON())
        assert.equal(debuggerInstance.traceManager.getCurrentFork(), fork)
        assert.ok(debuggerInstance.getTrace().length)
        if (result.value === 'Test monad opcode') {
          const trace = debuggerInstance.getTrace()
          assert.ok(trace.some(step => step.op === (fork === 'monad-next' ? 'CALLSTACKDEPTH' : 'INVALID')))
          assert.equal(result.type, fork === 'monad-next' ? 'testPass' : 'testFailure')
        }
      }
    } finally { provider.destroy(); engine.free() }
  })
}
