import type { Credits, Day, Skill } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

export function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function daysAgo(now: number, days: number): string {
  return localDate(now - days * DAY_MS)
}

// The `extra_usage` block of /api/oauth/usage, or null when it's off or its shape changed
export function parseCredits(body: string): Credits | null {
  const extra = (JSON.parse(body) as { extra_usage?: Record<string, unknown> | null }).extra_usage

  if (!extra?.is_enabled || typeof extra.used_credits !== 'number' || typeof extra.monthly_limit !== 'number') {
    return null
  }

  return {
    used: extra.used_credits,
    limit: extra.monthly_limit,
    currency: String(extra.currency ?? 'USD'),
    decimals: Number(extra.decimal_places ?? 2),
  }
}

export function lastSevenDays(days: Day[], now: number): Day[] {
  const byDate = new Map(days.map(day => [day.date, day.usd]))

  return Array.from({ length: 7 }, (_, i) => {
    const date = daysAgo(now, 6 - i)

    return { date, usd: byDate.get(date) ?? 0 }
  })
}

export type Totals = { session: number | null; today: number; week: number; month: number }

export function totals(sessionUsd: number | null, days: Day[], now: number): Totals {
  const today = localDate(now)
  const sum = (list: Day[]) => list.reduce((total, day) => total + day.usd, 0)

  return {
    session: sessionUsd,
    today: sum(days.filter(day => day.date === today)),
    week: sum(lastSevenDays(days, now)),
    month: sum(days.filter(day => day.date.startsWith(today.slice(0, 7)))),
  }
}

export function money(usd: number | null): string {
  return usd === null ? '–' : `≈$${usd.toFixed(2)}`
}

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' }

// `€120.06 / €120`, or `€120.06/120` where room is short
export function currencySymbol(currency: string): string {
  return SYMBOLS[currency] ?? currency
}

export function creditsLabel(credits: Credits, isShort = false): string {
  const symbol = SYMBOLS[credits.currency] ?? `${credits.currency} `
  const amount = (minor: number, digits: number) => `${symbol}${(minor / 10 ** credits.decimals).toFixed(digits)}`
  const isWhole = credits.limit % 10 ** credits.decimals === 0
  const limit = amount(credits.limit, isWhole ? 0 : credits.decimals)

  return isShort
    ? `${amount(credits.used, credits.decimals)}/${limit.slice(symbol.length)}`
    : `${amount(credits.used, credits.decimals)} / ${limit}`
}

export function creditsPercent(credits: Credits): number {
  return credits.limit > 0 ? Math.round((credits.used / credits.limit) * 100) : 0
}

export function resetsIn(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) {
    return null
  }

  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60

  if (days > 0) {
    return `${days}d${hours}h`
  }

  return hours > 0 ? `${hours}h${rest}m` : `${rest}m`
}

export function limitLabel(kind: string): string {
  return { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }[kind] ?? kind
}

export function level(percent: number): 'green' | 'yellow' | 'red' {
  if (percent >= 80) {
    return 'red'
  }

  return percent >= 50 ? 'yellow' : 'green'
}

// Context gets stricter thresholds, as answers get worse well before the window is full
export function contextLevel(percent: number): 'green' | 'yellow' | 'red' {
  if (percent >= 80) {
    return 'red'
  }

  return percent >= 60 ? 'yellow' : 'green'
}

export function tokens(count: number): string {
  if (count >= 1_000_000) {
    return `${Number((count / 1_000_000).toFixed(1))}M`
  }

  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count)
}

export function glyph(percent: number): string {
  return ['○', '◔', '◑', '◕', '●'][Math.min(4, Math.round(percent / 25))] ?? '○'
}

export function bar(usd: number, max: number, width: number): string {
  const filled = max > 0 ? Math.round((usd / max) * width) : 0

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// `claude-opus-5-5[1m]` reads as `Opus 5.5`, or `Opus` when space is short. Anything else shows as given.
export function modelName(model: string, isShort = false): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(model)

  const [, name, major, minor] = match ?? []

  if (!name) {
    return model
  }

  const family = name.charAt(0).toUpperCase() + name.slice(1)

  return isShort ? family : `${family} ${major}${minor ? `.${minor}` : ''}`
}

// `14:05` in local time
export function clockTime(ms: number): string {
  const d = new Date(ms)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// The skill a path loads when Claude reads it: skills/<name>/SKILL.md, on either separator
export function skillFromPath(path: string): string | null {
  return path.match(/[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/)?.[1] ?? null
}
