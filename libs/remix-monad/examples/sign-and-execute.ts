import { ethers } from 'ethers'

const metadata = JSON.parse(await remix.call('fileManager', 'readFile', 'artifacts/MonadDemo.json'))
const deployment: { address: string } = JSON.parse(await remix.call('fileManager', 'readFile', 'monad-script.json'))
const provider = new ethers.BrowserProvider(web3Provider)
const signer = await provider.getSigner()
const account: string = await signer.getAddress()
const domain = { name: 'Monad script', version: '1', chainId: (await provider.getNetwork()).chainId, verifyingContract: deployment.address }
const types = { Store: [{ name: 'value', type: 'uint256' }]}
const message = { value: 42 }
const signature: string = await signer.signTypedData(domain, types, message)
if (ethers.verifyTypedData(domain, types, message, signature) !== account) throw new Error('Typed signature recovery failed')

const typedData = ethers.TypedDataEncoder.getPayload(domain, types, message)
const objectSignature = await provider.send('eth_signTypedData_v4', [account, typedData])
if (objectSignature !== signature) throw new Error('Object and JSON signing differ')
await remix.call('fileManager', 'writeFile', 'MonadTypedData.json', JSON.stringify(typedData, null, 2))
console.log(`script-signature-ok ${account} ${signature}`)

const parts = ethers.Signature.from(signature)
const recovered = await provider.call({
  to: '0x0000000000000000000000000000000000000001',
  data: ethers.concat([ethers.TypedDataEncoder.hash(domain, types, message), ethers.toBeHex(parts.v, 32), parts.r, parts.s])
})
if (ethers.getAddress('0x' + recovered.slice(-40)) !== account) throw new Error('VM signature recovery failed')

const contract = new ethers.Contract(deployment.address, metadata.abi, signer)
// A gas limit permits the transaction to execute even on forks that reject the opcode.
const transaction = await contract.recordDepth({ gasLimit: 500_000 })
let receipt: ethers.TransactionReceipt
try {
  receipt = await transaction.wait()
} catch (error) {
  receipt = await provider.getTransactionReceipt(transaction.hash)
  if (!receipt || receipt.status !== 0) throw error
}
console.log(`script-ts-ok ${transaction.hash} ${receipt.status} ${await contract.value()}`)
