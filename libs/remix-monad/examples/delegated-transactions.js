/* global remix, web3Provider */
import { ethers } from 'ethers'

const metadata = JSON.parse(await remix.call('fileManager', 'readFile', 'artifacts/DelegatedAccount.json'))
const provider = new ethers.BrowserProvider(web3Provider, undefined, { cacheTimeout: -1 })
const [payer, authority] = await provider.send('eth_accounts', [])
const payerWallet = new ethers.Wallet(ethers.hexlify(await provider.send('eth_getPKey', [payer])))
const authorityWallet = new ethers.Wallet(ethers.hexlify(await provider.send('eth_getPKey', [authority])))
const factory = new ethers.ContractFactory(metadata.abi, metadata.data.bytecode.object, await provider.getSigner(payer))
const implementation = await factory.deploy()
await implementation.waitForDeployment()
const target = await implementation.getAddress()
const chainId = (await provider.getNetwork()).chainId
const abi = implementation.interface
const authorization = await authorityWallet.authorize({ address: target, chainId, nonce: 0 })
const delegated = ethers.Transaction.from({
  type: 4, chainId, nonce: await provider.getTransactionCount(payer), to: authority,
  data: abi.encodeFunctionData('store', [42]), gasLimit: 3000000,
  maxFeePerGas: 2000000000, maxPriorityFeePerGas: 1000000000,
  authorizationList: [authorization], accessList: [{ address: authority, storageKeys: [ethers.ZeroHash] }]
})
// Include skipped signatures before the valid authorization without asking ethers to interpret them.
const fields = ethers.decodeRlp('0x' + delegated.unsignedSerialized.slice(4))
const tuple = fields[9][0]
fields[9] = [[...tuple.slice(0, 3), '0x02', ...tuple.slice(4)], [...tuple.slice(0, 5), '0x' + 'ff'.repeat(32)], tuple]
const signature = payerWallet.signingKey.sign(ethers.keccak256(ethers.concat(['0x04', ethers.encodeRlp(fields)])))
const quantity = value => ethers.hexlify(ethers.toBeArray(value))
const signed = ethers.concat(['0x04', ethers.encodeRlp([...fields, quantity(signature.yParity), quantity(signature.r), quantity(signature.s)])])
const delegatedHash = await provider.send('eth_sendRawTransaction', [signed])
const accessSigned = await payerWallet.signTransaction({
  type: 1, chainId, nonce: await provider.getTransactionCount(payer), to: authority,
  data: abi.encodeFunctionData('store', [77]), gasLimit: 3000000, gasPrice: 1000000000,
  accessList: [{ address: authority, storageKeys: [ethers.ZeroHash] }]
})
const accessHash = await provider.send('eth_sendRawTransaction', [accessSigned])
const failedHash = await provider.send('eth_sendTransaction', [{
  from: payer, to: authority, data: abi.encodeFunctionData('reject'), gas: '0x2dc6c0'
}])
const failed = await provider.getTransactionReceipt(failedHash)
if (failed.status !== 0 || failed.logs.length) throw new Error('Expected caller rollback')
if (BigInt(await provider.getStorage(authority, 0)) !== 77n) throw new Error('Unexpected delegated storage')
const revoke = await authorityWallet.authorize({ address: ethers.ZeroAddress, chainId, nonce: await provider.getTransactionCount(authority) })
await (await (await provider.getSigner(payer)).sendTransaction({ type: 4, to: authority, authorizationList: [revoke], gasLimit: 3000000 })).wait()
if (await provider.getCode(authority) !== '0x') throw new Error('Delegation was not removed')
console.log(`typed-transactions-ok ${authority} ${delegatedHash} ${accessHash} ${failedHash}`)
