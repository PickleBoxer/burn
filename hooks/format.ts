import type { Day, History, Usage } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

export function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ccusage wants YYYYMMDD. Covers both the month so far and the last 7 days.
export function sinceArg(now: number): string {
  const sevenDaysAgo = localDate(now - 6 * DAY_MS)
  const monthStart = localDate(now).slice(0, 8) + '01'
  const since = sevenDaysAgo < monthStart ? sevenDaysAgo : monthStart

  return since.replaceAll('-', '')
}

// ccusage 20 names the day `period`, older versions `date`
export function parseDaily(stdout: string): Day[] {
  const json = JSON.parse(stdout) as { daily?: Array<Record<string, unknown>> }

  return (json.daily ?? []).map(row => ({
    date: String(row.period ?? row.date),
    usd: Number(row.totalCost ?? 0),
  }))
}

export function lastSevenDays(days: Day[], now: number): Day[] {
  const byDate = new Map(days.map(day => [day.date, day.usd]))

  return Array.from({ length: 7 }, (_, i) => {
    const date = localDate(now - (6 - i) * DAY_MS)

    return { date, usd: byDate.get(date) ?? 0 }
  })
}

export type Totals = { session: number | null; today: number | null; month: number | null; week: number | null }

export function totals(usage: Usage | null, history: History | null, now: number): Totals {
  const session = usage?.sessionUsd ?? null

  if (!history) {
    return { session, today: null, month: null, week: null }
  }

  // Spend since ccusage last read the transcripts
  const delta = Math.max(0, (session ?? 0) - history.sessionUsdAtFetch)
  const today = localDate(now)
  const month = today.slice(0, 7)
  const sum = (days: Day[]) => days.reduce((total, day) => total + day.usd, 0)

  return {
    session,
    today: sum(history.days.filter(day => day.date === today)) + delta,
    month: sum(history.days.filter(day => day.date.startsWith(month))) + delta,
    week: sum(lastSevenDays(history.days, now)) + delta,
  }
}

export function money(usd: number | null): string {
  return usd === null ? '–' : `$${usd.toFixed(2)}`
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

export function glyph(percent: number): string {
  return ['○', '◔', '◑', '◕', '●'][Math.min(4, Math.round(percent / 25))] ?? '○'
}

export function bar(usd: number, max: number, width: number): string {
  const filled = max > 0 ? Math.round((usd / max) * width) : 0

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
