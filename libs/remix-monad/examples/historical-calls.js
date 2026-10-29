/* global remix, web3Provider */
import { ethers } from 'ethers'

// Compile HistoricalCalls.sol, then run with Ethers v6 on either local Monad fork.
const provider = new ethers.BrowserProvider(web3Provider, undefined, { cacheTimeout: -1 })
const signer = await provider.getSigner()
const from = await signer.getAddress()
const metadata = JSON.parse(await remix.call('fileManager', 'readFile', 'artifacts/HistoricalCalls.json'))
const contract = await new ethers.ContractFactory(metadata.abi, metadata.data.bytecode.object, signer).deploy()
await contract.waitForDeployment()
const address = await contract.getAddress()
const a = await (await contract.store(1)).wait()
const b = await (await contract.store(2)).wait()
const saved = await provider.send('eth_getStateDb', [])
await provider.send('eth_registerCallId', ['historical-success'])
const historical = await contract.simulate.staticCall(1, 11, { blockTag: a.blockNumber })
const success = await provider.send('eth_getHashFromTagBySimulator', ['historical-success'])
const block = await provider.getBlock(a.blockHash)
if (historical[0] !== 11n || historical[1] !== BigInt(a.blockNumber) || historical[2] !== BigInt(block.timestamp) || historical[3] !== block.parentHash) {
  throw new Error('Historical execution used the wrong state or block context')
}
const readAtA = await provider.send('eth_call', [
  { from, to: address, data: contract.interface.encodeFunctionData('read') },
  { blockHash: a.blockHash, requireCanonical: true }
])
if (contract.interface.decodeFunctionResult('read', readAtA)[0] !== 1n || await contract.value() !== 2n) throw new Error('Historical and current values differ from their saved states')
await provider.send('eth_registerCallId', ['historical-revert'])
let rejected = false
try { await contract.reject.staticCall({ blockTag: a.blockNumber }) } catch { rejected = true }
if (!rejected) throw new Error('Expected the historical caller to revert')
const failure = await provider.send('eth_getHashFromTagBySimulator', ['historical-revert'])
const after = await provider.send('eth_getStateDb', [])
if (after.engine !== saved.engine || JSON.stringify(after.blocks) !== JSON.stringify(saved.blocks)) throw new Error('Historical calls changed committed state')
console.log(['historical-calls-ok', address, a.blockHash, b.blockHash, success, failure].join(' '))
