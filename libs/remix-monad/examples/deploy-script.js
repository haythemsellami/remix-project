import { ethers } from 'ethers'

const metadata = JSON.parse(await remix.call('fileManager', 'readFile', 'artifacts/MonadDemo.json'))
const provider = new ethers.BrowserProvider(web3Provider)
const signer = await provider.getSigner()
const factory = new ethers.ContractFactory(metadata.abi, metadata.data.bytecode.object, signer)
const contract = await factory.deploy()
await contract.waitForDeployment()
const address = await contract.getAddress()
const receipt = await (await contract.store(42)).wait()
if (await contract.value() !== 42n) throw new Error('Script storage write failed')

const logs = await provider.getLogs({
  address, fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
  topics: [contract.interface.getEvent('ValueChanged').topicHash]
})
if (logs.length !== 1 || contract.interface.parseLog(logs[0]).args[0] !== 42n) throw new Error('Script event decoding failed')

await remix.call('fileManager', 'writeFile', 'monad-script.json', JSON.stringify({ address }))
console.log(`script-js-ok ${address} ${receipt.hash}`)
