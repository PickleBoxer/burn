export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Context = { tokens: number | null; window: number; percent: number | null }

export type Usage = { limits: Limit[]; sessionUsd: number | null; context: Context }

// One row of the /context breakdown
export type ContextRow = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }

export type Day = { date: string; usd: number }

// Usage credits, in minor units such as cents
export type Credits = { used: number; limit: number; currency: string; decimals: number }

declare module 'claude-code' {
  interface PluginState {
    burn: {
      usage: Usage | null
      days: Day[]
      credits: Credits | null
      // Session cost already added to the daily totals
      recordedUsd: number | null
      now: number
      breakdown: ContextRow[] | null
      // Whether this session already warned that the context is nearly full
      hasWarned: boolean
    }
  }
}
