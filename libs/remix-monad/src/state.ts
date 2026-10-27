import { Wallet } from 'ethers'
import { DebugRecord } from './history'
import { EngineResult, MonadSpec, RpcError } from './types'

export interface RecordedExecution {
  tx: any
  receipt: any
  block: any
  result: Omit<EngineResult, 'structLogs' | 'preimages'>
}

export interface SavedState {
  backend: 'monad-revm'
  version: 2
  spec: MonadSpec
  engine: string
  keys: string[]
  blocks: any[]
  executions: [string, RecordedExecution][]
  history: [string, DebugRecord][]
  tags: [string, string][]
  callCounter: number
}

const object = (value: any) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hex = (value: any) => typeof value === 'string' && /^0x(?:[\da-f]{2})*$/i.test(value)
const hash = (value: any) => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value)
const integer = (value: any) => Number.isSafeInteger(value) && value >= 0
const invalid = (detail: string): never => { throw new RpcError(`Invalid saved Monad state: ${detail}`) }

function pairs(value: any, name: string): [string, any][] {
  if (!Array.isArray(value) || value.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') || new Set(value.map(entry => entry[0])).size !== value.length) {
    invalid(`${name} must contain unique key/value pairs`)
  }
  return value
}

function snapshot(value: any, spec: MonadSpec) {
  if (typeof value !== 'string') invalid('missing engine snapshot')
  let parsed
  try { parsed = JSON.parse(value) } catch { invalid('malformed engine snapshot JSON') }
  if (!object(parsed) || parsed.version !== 1 || parsed.chainId !== 1337 || parsed.spec !== (spec === 'monad-next' ? 'MonadNext' : 'MonadTen')) {
    invalid('incompatible engine snapshot version, specification or chain ID')
  }
  if (!object(parsed.accounts) || !object(parsed.blockHashes)) invalid('malformed engine snapshot accounts or block hashes')
  for (const [address, account] of Object.entries(parsed.accounts) as [string, any][]) {
    if (!/^0x[\da-f]{40}$/i.test(address) || !object(account) || !integer(account.nonce) || typeof account.balance !== 'string' || !/^0x[\da-f]+$/i.test(account.balance) || !hex(account.code) || !object(account.storage)) invalid('malformed snapshot account')
    if (Object.entries(account.storage).some(([key, value]) => !hash(key) || !hash(value))) invalid('malformed snapshot storage')
  }
  return value as string
}

function debugRecord(value: any, spec: MonadSpec): DebugRecord {
  if (!object(value) || !Array.isArray(value.structLogs) || !object(value.preimages)) invalid('malformed debugging history')
  for (const step of value.structLogs) {
    if (!object(step) || !integer(step.pc) || !integer(step.depth) || step.depth < 1 || !integer(step.gas) || !integer(step.gasCost) || typeof step.op !== 'string' || !Array.isArray(step.stack) || step.stack.some(word => typeof word !== 'string' || !/^[\da-f]{64}$/i.test(word)) || typeof step.memory !== 'string' || !/^(?:[\da-f]{2})*$/i.test(step.memory) || (step.error !== undefined && typeof step.error !== 'string')) invalid('malformed trace step')
  }
  if (Object.entries(value.preimages).some(([key, value]) => !/^[\da-f]{64}$/i.test(key) || typeof value !== 'string' || !/^(?:[\da-f]{2})*$/i.test(value))) invalid('malformed hash preimage')
  return { before: snapshot(value.before, spec), after: snapshot(value.after, spec), structLogs: value.structLogs, preimages: value.preimages }
}

/** Validate and detach imported data before replacing any live provider state. */
export function readState(input: unknown, spec: MonadSpec): SavedState {
  let state: any
  try { state = JSON.parse(JSON.stringify(input)) } catch { invalid('expected JSON state') }
  if (!object(state) || state.backend !== 'monad-revm' || ![1, 2].includes(state.version) || state.spec !== spec) {
    throw new RpcError('Saved state belongs to a different backend, version or Monad specification')
  }
  snapshot(state.engine, spec)
  if (!Array.isArray(state.keys) || !state.keys.length) invalid('missing local account keys')
  const accounts = new Set<string>()
  for (const key of state.keys) {
    try {
      const address = new Wallet(key).address
      if (accounts.has(address)) invalid('duplicate local account')
      accounts.add(address)
    } catch { invalid('invalid or duplicate local account key') }
  }
  if (!Array.isArray(state.blocks) || !state.blocks.length) invalid('missing local blocks')
  for (const [index, block] of state.blocks.entries()) {
    if (!object(block) || block.number !== '0x' + index.toString(16) || !hash(block.hash) || !Array.isArray(block.transactions) || block.transactions.length !== (index === 0 ? 0 : 1) || (index > 0 && block.parentHash !== state.blocks[index - 1].hash)) invalid('malformed local block chain')
  }
  const history: [string, DebugRecord][] = []
  const executions = pairs(state.executions, 'executions').map(([id, record]): [string, RecordedExecution] => {
    if (!hash(id) || !object(record) || !object(record.tx) || !object(record.receipt) || !object(record.block) || !object(record.result) || record.tx.hash !== id || record.receipt.transactionHash !== id || record.block.hash !== record.tx.blockHash || record.receipt.blockHash !== record.block.hash || !hash(record.block.hash)) invalid('malformed execution record')
    const result = record.result
    if (typeof result.success !== 'boolean' || !hex(result.returnValue) || !integer(result.gasUsed) || !integer(result.gasSpent) || !Array.isArray(result.logs) || !Array.isArray(record.receipt.logs) || typeof result.traceTruncated !== 'boolean') invalid('malformed execution result')
    if (state.version === 1) history.push([id, debugRecord({ before: record.before, after: record.after, structLogs: result.structLogs, preimages: result.preimages }, spec)])
    return [id, { tx: record.tx, receipt: record.receipt, block: record.block, result: {
      success: result.success, error: result.error, returnValue: result.returnValue, createdAddress: result.createdAddress,
      gasUsed: result.gasUsed, gasSpent: result.gasSpent, logs: result.logs, traceTruncated: result.traceTruncated
    } }]
  })
  const records = new Map(executions)
  for (const block of state.blocks) {
    for (const id of block.transactions) {
      const record = records.get(id)
      if (!record || record.tx.blockHash !== block.hash || record.tx.blockNumber !== block.number) invalid('block references a missing or inconsistent transaction')
    }
  }
  if (state.version === 2) {
    for (const [id, data] of pairs(state.history, 'history')) {
      if (!records.has(id)) invalid('history references an unknown execution')
      history.push([id, debugRecord(data, spec)])
    }
  }
  const tags = state.version === 1 ? [] : pairs(state.tags, 'call tags')
  if (tags.some(([, id]) => !records.has(id))) invalid('call tag references an unknown execution')
  const callCounter = state.version === 1 ? executions.length : state.callCounter
  if (!integer(callCounter) || callCounter < executions.length - state.blocks.length + 1) invalid('invalid call counter')
  return { backend: 'monad-revm', version: 2, spec, engine: state.engine, keys: state.keys, blocks: state.blocks, executions, history, tags, callCounter }
}
