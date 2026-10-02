export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = { limits: Limit[]; sessionUsd: number | null }

export type Day = { date: string; usd: number }

export type History = {
  days: Day[]
  fetchedAt: number
  // Session cost when ccusage ran, so the live delta isn't counted twice
  sessionUsdAtFetch: number
}

declare module 'claude-code' {
  interface PluginState {
    burn: {
      usage: Usage | null
      history: History | null
      error: string | null
      now: number
    }
  }
}
