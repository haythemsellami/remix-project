import { getAddress, getBytes, keccak256, toQuantity, toUtf8Bytes, Transaction, Wallet, ZeroAddress, ZeroHash } from 'ethers'
import type { ExecuteRequest } from 'monad-revmjs'
import type { AccountState, EngineResult, MonadEngine, MonadSpec, RpcRequest } from './types'
import { RpcError } from './types'

const CHAIN_ID = 1337
const GAS_LIMIT = 30_000_000
const GAS_PRICE = 1_000_000_000n
const BLOOM = '0x' + '00'.repeat(256)
const BALANCE = '0x56bc75e2d63100000'
const KEYS = [
  '503f38a9c967ed597e47fe25643985f032b072db8075426a92110f82df48dfcb',
  '7e5bfb82febc4c2c8529167104271ceec190eafdca277314912eaabdb67c6e5f',
  'cc6d63f85de8fef05446ebdd3c537c72152d0fc437fd7aa62b3019b79bd1fdd4',
  '638b5c6c8c5903b15f0d3bf5d3f175c64e6e98a10bdb9768a2003bf773dcb86a',
  'f49bf239b6e554fdd08694fde6c67dac4d01c04e0dda5ee11abee478983f3bc0'
]

interface RecordedExecution {
  tx: any
  receipt: any
  block: any
  result: EngineResult
  before: string
  after: string
}

export interface MonadProviderOptions {
  fork: MonadSpec
  stateDb?: { backend: string, version: number, spec: MonadSpec, engine: string, keys: string[], blocks: any[], executions: [string, RecordedExecution][] }
}

/** Local, serial execution provider. No requests are broadcast to a network. */
export class MonadProvider {
  private engine: MonadEngine
  private wallets = new Map<string, Wallet>()
  private blocks: any[] = []
  private executions = new Map<string, RecordedExecution>()
  private tags = new Map<string, string>()
  private callId: string | number | undefined
  private callCounter = 0
  private queue: Promise<unknown> = Promise.resolve()
  private initialized = false

  readonly Accounts = {
    _addAccount: (key: string, balance = BALANCE) => this.addAccount(key, balance),
    newAccount: (callback: (error: Error | null, address?: string) => void) => {
      try { callback(null, this.addAccount(Wallet.createRandom().privateKey)) } catch (error) { callback(error as Error) }
    }
  }

  constructor(readonly options: MonadProviderOptions, engine?: MonadEngine) {
    this.engine = engine
  }

  async init() {
    if (!this.engine) {
      const wasm = await import('monad-revmjs')
      await wasm.default()
      this.engine = new wasm.Engine(this.options.fork, CHAIN_ID)
    }
    const state = this.options.stateDb
    if (state) {
      if (state.backend !== 'monad-revm' || state.version !== 1 || state.spec !== this.options.fork) {
        throw new RpcError('Saved state belongs to a different backend or Monad specification')
      }
      this.engine.restore(state.engine)
      for (const key of state.keys) {
        const wallet = new Wallet(key)
        this.wallets.set(wallet.address.toLowerCase(), wallet)
      }
      this.blocks = state.blocks
      this.executions = new Map(state.executions)
    } else {
      for (const key of KEYS) this.addAccount(key)
      this.blocks.push(this.makeBlock(0, ZeroHash, [], 0))
      this.engine.set_block_hash(0, this.blocks[0].hash)
    }
    this.initialized = true
  }

  private addAccount(key: string, balance = BALANCE) {
    const wallet = new Wallet(key.startsWith('0x') ? key : '0x' + key)
    this.engine.fund(wallet.address, balance)
    this.wallets.set(wallet.address.toLowerCase(), wallet)
    return wallet.address
  }

  request(payload: RpcRequest): Promise<any> {
    const run = this.queue.then(() => {
      if (!this.initialized) throw new RpcError('Monad provider has not been initialized', -32000)
      return this.dispatch(payload.method, payload.params || [])
    })
    this.queue = run.catch(() => {})
    return run
  }

  async sendAsync(payload: RpcRequest, callback?: (error: any, result?: any) => void): Promise<any> {
    try {
      const response = { id: payload.id, jsonrpc: '2.0', result: await this.request(payload) }
      if (callback) callback(null, response)
      return response
    } catch (error) {
      if (callback) return callback(error)
      throw error
    }
  }

  private account(address: string, block = 'latest'): AccountState {
    if (block === 'latest' || block === 'pending') return JSON.parse(this.engine.account(address))
    const selected = this.block(block)
    if (!selected) throw new RpcError('Unknown local block')
    const execution = this.executions.get(selected.transactions[0])
    if (!execution) {
      if (selected.number === '0x0') {
        const wallet = this.wallets.get(address.toLowerCase())
        return { balance: wallet ? BALANCE : '0x0', nonce: 0, code: '0x', storage: {} }
      }
      throw new RpcError('Historical state is unavailable')
    }
    return JSON.parse(execution.after).accounts[address.toLowerCase()] || { balance: '0x0', nonce: 0, code: '0x', storage: {} }
  }

  private block(tag: string) {
    if (tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized') return this.blocks[this.blocks.length - 1]
    if (tag === 'earliest') return this.blocks[0]
    if (typeof tag === 'string' && tag.length === 66) {
      return this.blocks.find(block => block.hash === tag) || [...this.executions.values()].find(record => record.tx.blockHash === tag)?.block || null
    }
    return this.blocks[Number(BigInt(tag))] || null
  }

  private makeBlock(number: number, parentHash: string, transactions: string[], gasUsed: number, timestamp = Math.floor(Date.now() / 1000)) {
    const hash = keccak256(toUtf8Bytes(JSON.stringify({ spec: this.options.fork, number, parentHash, transactions, timestamp })))
    return {
      number: toQuantity(number), hash, parentHash, timestamp: toQuantity(timestamp),
      nonce: '0x0000000000000000', sha3Uncles: keccak256('0xc0'), logsBloom: BLOOM,
      transactionsRoot: ZeroHash, stateRoot: ZeroHash, receiptsRoot: ZeroHash,
      miner: ZeroAddress, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x',
      size: '0x0', gasLimit: toQuantity(GAS_LIMIT), gasUsed: toQuantity(gasUsed),
      baseFeePerGas: '0x0', mixHash: ZeroHash, transactions, uncles: []
    }
  }

  private normalize(tx: any) {
    if (!tx || typeof tx !== 'object') throw new RpcError('Expected a transaction object')
    const type = Number(BigInt(tx.type ?? (tx.maxFeePerGas !== undefined ? 2 : 0)))
    if (type !== 0 && type !== 2) throw new RpcError('This local Monad slice supports legacy and EIP-1559 transactions')
    if (tx.accessList?.length || tx.authorizationList?.length || tx.blobVersionedHashes?.length) {
      throw new RpcError('Access lists, authorizations and blob transactions are not supported by this local slice')
    }
    if (tx.chainId !== undefined && BigInt(tx.chainId) !== BigInt(CHAIN_ID)) throw new RpcError('Incorrect local chain ID')
    const from = getAddress(tx.from || this.wallets.values().next().value.address)
    const gas = Number(BigInt(tx.gas ?? tx.gasLimit ?? GAS_LIMIT))
    if (!Number.isSafeInteger(gas) || gas < 0 || gas > GAS_LIMIT) throw new RpcError('Invalid gas limit; maximum is 30,000,000')
    const gasPrice = BigInt(type === 2 ? (tx.maxFeePerGas ?? GAS_PRICE) : (tx.gasPrice ?? GAS_PRICE))
    const priorityFee = type === 2 ? BigInt(tx.maxPriorityFeePerGas ?? GAS_PRICE) : null
    return {
      from, to: tx.to ? getAddress(tx.to) : null, data: tx.data || tx.input || '0x',
      value: toQuantity(tx.value ?? 0), gas, gasPrice: toQuantity(gasPrice),
      priorityFee: priorityFee === null ? null : toQuantity(priorityFee),
      nonce: Number(BigInt(tx.nonce ?? this.account(from).nonce)), type
    }
  }

  private run(tx: ReturnType<MonadProvider['normalize']>, commit: boolean, trace: boolean, blockNumber: number, timestamp: number): EngineResult {
    const { type, ...request } = tx
    const execution: ExecuteRequest = {
      ...request, blockNumber, timestamp, commit, trace,
      blockGasLimit: GAS_LIMIT, baseFee: '0x0', beneficiary: ZeroAddress, prevrandao: ZeroHash
    }
    return JSON.parse(this.engine.execute(JSON.stringify(execution)))
  }

  private async execute(input: any, commit: boolean, signed?: Transaction) {
    const tx = this.normalize(input)
    const latest = this.blocks[this.blocks.length - 1]
    const blockNumber = commit ? this.blocks.length : this.blocks.length - 1
    const timestamp = Math.floor(Date.now() / 1000)
    let hash: string
    if (commit) {
      if (!signed) {
        const wallet = this.wallets.get(tx.from.toLowerCase())
        if (!wallet) throw new RpcError('Unknown local account')
        signed = Transaction.from(await wallet.signTransaction({
          to: tx.to, data: tx.data, value: tx.value, nonce: tx.nonce, gasLimit: tx.gas,
          chainId: CHAIN_ID, type: tx.type,
          ...(tx.type === 2 ? { maxFeePerGas: tx.gasPrice, maxPriorityFeePerGas: tx.priorityFee } : { gasPrice: tx.gasPrice })
        }))
      }
      hash = signed.hash
    } else {
      hash = keccak256(toUtf8Bytes(JSON.stringify({ tx, call: ++this.callCounter, timestamp })))
    }
    const before = this.engine.snapshot()
    const result = this.run(tx, commit, true, blockNumber, timestamp)
    const block = commit ? this.makeBlock(blockNumber, latest.hash, [hash], result.gasUsed, timestamp) : {
      ...latest, hash: keccak256(toUtf8Bytes(hash + ':call')), transactions: [hash],
      timestamp: toQuantity(timestamp), gasUsed: toQuantity(result.gasUsed)
    }
    if (commit) {
      this.blocks.push(block)
      this.engine.set_block_hash(blockNumber, block.hash)
    }
    const effectiveGasPrice = tx.priorityFee === null ? tx.gasPrice : toQuantity(BigInt(tx.gasPrice) < BigInt(tx.priorityFee) ? tx.gasPrice : tx.priorityFee)
    const rpcTx = {
      hash, from: tx.from, to: tx.to, input: tx.data, value: tx.value,
      nonce: toQuantity(tx.nonce), gas: toQuantity(tx.gas), gasPrice: effectiveGasPrice,
      type: toQuantity(tx.type), chainId: toQuantity(CHAIN_ID),
      ...(tx.type === 2 ? { maxFeePerGas: tx.gasPrice, maxPriorityFeePerGas: tx.priorityFee, accessList: []} : {}),
      blockHash: block.hash, blockNumber: block.number, transactionIndex: '0x0',
      r: signed?.signature?.r || ZeroHash, s: signed?.signature?.s || ZeroHash,
      v: toQuantity(signed?.signature?.v || 27)
    }
    const logs = result.logs.map((log, index) => ({ ...log,
      blockHash: block.hash, blockNumber: block.number, transactionHash: hash,
      transactionIndex: '0x0', logIndex: toQuantity(index), removed: false
    }))
    const receipt = {
      transactionHash: hash, transactionIndex: '0x0', blockHash: block.hash, blockNumber: block.number,
      from: tx.from, to: tx.to, contractAddress: result.createdAddress,
      cumulativeGasUsed: toQuantity(result.gasUsed), gasUsed: toQuantity(result.gasUsed),
      effectiveGasPrice, status: result.success ? '0x1' : '0x0', logs, logsBloom: BLOOM, type: toQuantity(tx.type)
    }
    if (result.traceTruncated) result.structLogs = []
    this.executions.set(hash, { tx: rpcTx, receipt, block, result, before, after: commit ? this.engine.snapshot() : before })
    if (!commit) {
      const id = input.timestamp ?? this.callId
      if (id !== undefined) this.tags.set(String(id), hash)
      this.callId = undefined
      if (!result.success) throw new RpcError(result.error || 'Execution reverted', 3, result.returnValue)
    }
    return commit ? hash : result.returnValue
  }

  private estimate(input: any) {
    const tx = this.normalize(input)
    const number = this.blocks.length
    const timestamp = Math.floor(Date.now() / 1000)
    let high = tx.gas
    let low = 20_999
    const initial = this.run(tx, false, false, number, timestamp)
    if (!initial.success) throw new RpcError(initial.error || 'Gas estimation failed', 3, initial.returnValue)
    while (high - low > 1) {
      const gas = Math.floor((high + low) / 2)
      try {
        const result = this.run({ ...tx, gas }, false, false, number, timestamp)
        if (result.success) high = gas
        else low = gas
      } catch (error) {
        // A gas limit below intrinsic gas is a validation error, not an execution halt.
        if (!String(error).includes('Gas') && !String(error).includes('gas')) throw error
        low = gas
      }
    }
    return toQuantity(high)
  }

  private recorded(hash: string) {
    const record = this.executions.get(hash)
    if (!record) throw new RpcError('Unknown local transaction or call', -32000)
    return record
  }

  private storageRange([blockHash, index, address, start = ZeroHash, max = 1000]: any[]) {
    const record = [...this.executions.values()].find(record => record.tx.blockHash === blockHash && Number(index) === 0)
    if (!record) throw new RpcError('Unknown local transaction for storage inspection')
    const account = JSON.parse(record.before).accounts[address.toLowerCase()]
    const entries = Object.entries(account?.storage || {}).map(([key, value]) => [keccak256(key), { key, value }])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .filter(([hash]) => String(hash) >= start)
    const limit = Math.min(Math.max(Number(max), 1), 1000)
    return { storage: Object.fromEntries(entries.slice(0, limit)), nextKey: entries[limit]?.[0] || null }
  }

  private async dispatch(method: string, params: any[]) {
    switch (method) {
    case 'eth_accounts': case 'eth_requestAccounts': return [...this.wallets.values()].map(wallet => wallet.address)
    case 'eth_chainId': return toQuantity(CHAIN_ID)
    case 'net_version': return String(CHAIN_ID)
    case 'net_listening': return true
    case 'eth_syncing': return false
    case 'web3_clientVersion': return 'Remix/monad-revm-wasm/0.1.0'
    case 'eth_blockNumber': return toQuantity(this.blocks.length - 1)
    case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return toQuantity(GAS_PRICE)
    case 'eth_getBalance': return this.account(getAddress(params[0]), params[1]).balance
    case 'eth_getCode': return this.account(getAddress(params[0]), params[1]).code
    case 'eth_getTransactionCount': return toQuantity(this.account(getAddress(params[0]), params[1]).nonce)
    case 'eth_getStorageAt': return this.account(getAddress(params[0]), params[2]).storage['0x' + BigInt(params[1]).toString(16).padStart(64, '0')] || ZeroHash
    case 'eth_estimateGas': return this.estimate(params[0])
    case 'eth_sendTransaction': return this.execute(params[0], true)
    case 'eth_sendRawTransaction': {
      const tx = Transaction.from(params[0])
      if (!tx.isSigned() || !tx.from) throw new RpcError('Invalid signed transaction')
      return this.execute({ ...tx.toJSON(), from: tx.from, gas: tx.gasLimit }, true, tx)
    }
    case 'eth_call':
      if (params[1] && params[1] !== 'latest' && params[1] !== 'pending') throw new RpcError('Historical eth_call is not supported in this local slice')
      return this.execute(params[0], false)
    case 'eth_getTransactionByHash': return this.executions.get(params[0])?.tx || null
    case 'eth_getTransactionReceipt': return this.executions.get(params[0])?.receipt || null
    case 'eth_getBlockByNumber': case 'eth_getBlockByHash': {
      const block = this.block(params[0])
      return block && { ...block, transactions: params[1] ? block.transactions.map(hash => this.recorded(hash).tx) : block.transactions }
    }
    case 'eth_getLogs': {
      const filter = params[0] || {}
      const from = filter.fromBlock ? Number(BigInt(filter.fromBlock === 'latest' ? this.blocks.length - 1 : filter.fromBlock)) : 0
      const to = !filter.toBlock || filter.toBlock === 'latest' ? this.blocks.length - 1 : Number(BigInt(filter.toBlock))
      const addresses = filter.address ? (Array.isArray(filter.address) ? filter.address : [filter.address]).map(address => address.toLowerCase()) : null
      return this.blocks.filter(block => filter.blockHash ? block.hash === filter.blockHash : Number(BigInt(block.number)) >= from && Number(BigInt(block.number)) <= to)
        .flatMap(block => block.transactions.flatMap(hash => this.recorded(hash).receipt.logs))
        .filter(log => (!addresses || addresses.includes(log.address.toLowerCase())) && (!filter.topics || filter.topics.every((topic, index) => topic === null || (Array.isArray(topic) ? topic.includes(log.topics[index]) : topic === log.topics[index]))))
    }
    case 'eth_registerCallId': this.callId = params[0]; return null
    case 'eth_getHashFromTagBySimulator': return this.tags.get(String(params[0])) || null
    case 'eth_getHHLogsForTx': return []
    case 'eth_getExecutionResultFromSimulator': {
      const { result } = this.recorded(params[0])
      return { returnValue: result.returnValue, executionGasUsed: toQuantity(result.gasSpent), gas: toQuantity(result.gasUsed), gasRefund: '0x0',
        exceptionError: result.success ? null : { error: result.error, errorType: 'EvmError' }, logs: result.logs }
    }
    case 'debug_traceTransaction': {
      const { result } = this.recorded(params[0])
      if (result.traceTruncated) throw new RpcError('Trace exceeded the local limit (100,000 steps or 32 MiB); use a smaller transaction', -32000)
      return { failed: !result.success, gas: toQuantity(result.gasUsed), returnValue: result.returnValue, return: result.returnValue,
        fork: this.options.fork, structLogs: result.structLogs.map(step => ({ ...step, memory: getBytes('0x' + step.memory) })) }
    }
    case 'debug_storageRangeAt': return this.storageRange(params)
    case 'debug_preimage': {
      const key = params[0].replace(/^0x/, '').toLowerCase()
      for (const { result } of this.executions.values()) if (result.preimages[key] !== undefined) return result.preimages[key]
      return null
    }
    case 'eth_getStateDb': return {
      backend: 'monad-revm', version: 1, spec: this.options.fork, engine: this.engine.snapshot(),
      keys: [...this.wallets.values()].map(wallet => wallet.privateKey), blocks: this.blocks, executions: [...this.executions]
    }
    case 'eth_getBlocksData': return { blocks: [], latestBlockNumber: this.blocks.length - 1, baseBlockNumber: '0x0' }
    case 'personal_sign': case 'eth_sign': {
      const [data, address] = method === 'personal_sign' ? params : [params[1], params[0]]
      const wallet = this.wallets.get(getAddress(address).toLowerCase())
      if (!wallet) throw new RpcError('Unknown local account')
      return wallet.signMessage(getBytes(data))
    }
    case 'eth_getPKey': {
      const wallet = this.wallets.get(getAddress(params[0]).toLowerCase())
      if (!wallet) throw new RpcError('Unknown local account')
      return getBytes(wallet.privateKey)
    }
    default: throw new RpcError('Unsupported local Monad RPC method: ' + method, -32601)
    }
  }
}
