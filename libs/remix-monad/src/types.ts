export type MonadSpec = 'monad-ten' | 'monad-next'

export interface MonadEngine {
  fund(address: string, balance: string): void
  account(address: string): string
  execute(request: string): string
  snapshot(): string
  restore(snapshot: string): void
  set_block_hash(number: number, hash: string): void
  free(): void
}

export interface AccountState {
  balance: string
  nonce: number
  code: string
  storage: Record<string, string>
}

export interface EngineResult {
  success: boolean
  error: string | null
  returnValue: string
  createdAddress: string | null
  gasUsed: number
  gasSpent: number
  logs: { address: string, topics: string[], data: string }[]
  structLogs: { pc: number, op: string, gas: number, gasCost: number, depth: number, stack: string[], memory: string, error?: string }[]
  preimages: Record<string, string>
  traceTruncated: boolean
}

export interface RpcRequest {
  method: string
  params?: any[]
  id?: number
  jsonrpc?: string
}

export class RpcError extends Error {
  constructor(message: string, public code = -32602, public data?: string) {
    super(message)
  }
}
