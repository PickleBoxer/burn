export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = { limits: Limit[]; sessionUsd: number | null }

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
    }
  }
}
