export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Context = { tokens: number | null; window: number; percent: number | null }

export type Usage = { limits: Limit[]; sessionUsd: number | null; context: Context }

// One row of the /context breakdown
export type ContextRow = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }

// The main loop's model and the types of the subagents running now
export type Agent = { model: string; subagents: string[] }

// A skill loaded this session: typed as /name, or invoked by Claude through the Skill tool.
// agent is the subagent type that loaded it, null for the main loop. at is null when it came
// from a resumed transcript.
export type Skill = { name: string; how: 'typed' | 'claude'; agent: string | null; at: number | null }

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
      agent: Agent | null
      // The skills loaded this session, in the order they loaded
      skills: Skill[]
    }
  }
}
