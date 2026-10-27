import type { EngineResult } from './types'
import { RpcError } from './types'

export interface HistoryLimits {
  maxEntries: number
  maxBytes: number
}

export interface DebugRecord {
  before: string
  after: string
  structLogs: EngineResult['structLogs']
  preimages: EngineResult['preimages']
}

export const DEFAULT_HISTORY_LIMITS: Readonly<HistoryLimits> = Object.freeze({ maxEntries: 100, maxBytes: 64 * 1024 * 1024 })

/** FIFO retention measured in serialized UTF-8 bytes, independently of chain state. */
export class DebugHistory {
  private records = new Map<string, { data: DebugRecord, bytes: number }>()
  private bytes = 0
  readonly limits: HistoryLimits

  constructor(limits: Partial<HistoryLimits> = {}) {
    this.limits = { ...DEFAULT_HISTORY_LIMITS, ...limits }
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new RpcError('Monad history limits must be non-negative safe integers')
    }
  }

  retain(hash: string, data: DebugRecord) {
    this.remove(hash)
    if (!this.limits.maxEntries || !this.limits.maxBytes) return
    const bytes = new TextEncoder().encode(JSON.stringify([hash, data])).byteLength
    // An oversized execution must not evict otherwise usable history.
    if (bytes > this.limits.maxBytes) return
    while (this.records.size >= this.limits.maxEntries || this.bytes + bytes > this.limits.maxBytes) {
      this.remove(this.records.keys().next().value)
    }
    this.records.set(hash, { data, bytes })
    this.bytes += bytes
  }

  get(hash: string) { return this.records.get(hash)?.data }

  entries(): [string, DebugRecord][] {
    return [...this.records].map(([hash, record]) => [hash, record.data])
  }

  private remove(hash: string) {
    const record = this.records.get(hash)
    if (record) this.bytes -= record.bytes
    this.records.delete(hash)
  }
}
