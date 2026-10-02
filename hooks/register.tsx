import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { History, Usage } from '../types'
import {
  bar,
  glyph,
  lastSevenDays,
  level,
  limitLabel,
  localDate,
  money,
  parseDaily,
  resetsIn,
  sinceArg,
  totals,
} from './format'

const PANE = 'burn'
const REFRESH_MS = 10 * 60 * 1000
const TICK_MS = 60 * 1000

const usageAtom = atom({ plugin: 'burn', key: 'usage' } as const, null)
const historyAtom = atom({ plugin: 'burn', key: 'history' } as const, null)
const errorAtom = atom({ plugin: 'burn', key: 'error' } as const, null)
const nowAtom = atom({ plugin: 'burn', key: 'now' } as const, 0)

const HEX = { green: '#4caf50', yellow: '#d9a520', red: '#e5534b' }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function toUsage(source: SessionUsage | SessionMeasureInput): Usage {
  return {
    limits: source.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    sessionUsd: source.cost?.usd ?? null,
  }
}

function ring(percent: number): string {
  const r = 8
  const length = 2 * Math.PI * r
  const filled = (Math.min(100, percent) / 100) * length

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">` +
    `<circle cx="10" cy="10" r="${r}" fill="none" stroke="#444" stroke-width="2.5"/>` +
    `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${HEX[level(percent)]}" stroke-width="2.5" ` +
    `stroke-linecap="round" stroke-dasharray="${filled} ${length}" transform="rotate(-90 10 10)"/>` +
    `</svg>`
  )
}

function weekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number)

  return WEEKDAYS[new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).getDay()] ?? ''
}

// The ccusage run in flight, so a second caller waits for it instead of starting another
let inflight: Promise<void> | null = null

// Moves the clock the countdowns read, which redraws the band and the pane
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
}

function refresh($: EngineInterface, argv: string[]): Promise<void> {
  inflight ??= readCcusage($, argv).finally(() => {
    inflight = null
  })

  return inflight
}

async function readCcusage($: EngineInterface, argv: string[]): Promise<void> {
  try {
    const now = await $.clock.now()
    const sessionUsdAtFetch = (await $.session.usage()).cost?.usd ?? 0
    const { exitCode, stdout, stderr } = await $.process.run(
      [...argv, 'daily', '--json', '--since', sinceArg(now)],
      { timeoutMs: 120_000 },
    )

    if (exitCode !== 0) {
      throw new Error(stderr.trim().split('\n').pop() || `ccusage exited with ${exitCode}`)
    }

    const history: History = { days: parseDaily(stdout), fetchedAt: now, sessionUsdAtFetch }
    await update($, historyAtom, () => history)
    await update($, errorAtom, () => null)
  } catch (error) {
    await update($, errorAtom, () => (error instanceof Error ? error.message : String(error)))
  }
}

async function summary($: EngineInterface): Promise<string> {
  const usage = await read($, usageAtom)
  const now = await $.clock.now()
  const sum = totals(usage, await read($, historyAtom), now)
  const limits = (usage?.limits ?? []).map(limit => {
    const resets = resetsIn(limit.resetsAt, now)

    return `${limitLabel(limit.kind)} ${limit.percentUsed}%${resets ? ` (resets ${resets})` : ''}`
  })

  return [
    ...limits,
    `session ${money(sum.session)}`,
    `today ${money(sum.today)}`,
    `7d ${money(sum.week)}`,
    `month ${money(sum.month)}`,
  ].join(' · ')
}

export const register: Register = (on, options) => {
  const argv = String(options.ccusageCommand ?? 'bunx ccusage@20.0.26').split(/\s+/).filter(Boolean)
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'burn',
      description: 'Show rate limits and spend for the last 7 days (/burn refresh to re-read ccusage)',
    })

    const usage = toUsage(await $.session.usage())
    await update($, usageAtom, () => usage)
    await tick($)

    void refresh($, argv)
    $.clock.every(REFRESH_MS, () => void refresh($, argv))
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usageAtom, () => toUsage(e))

    return next(e)
  })

  on('command.run', { command: 'burn' }, async ($, e) => {
    if (e.args.trim() === 'refresh') {
      await refresh($, argv)
      const error = await read($, errorAtom)

      return { text: error ? `ccusage failed: ${error}` : await summary($) }
    }

    await $.ui.open({ id: PANE, title: 'burn', closeOnEscape: true })

    // Shown where nothing draws, such as the VS Code panel or claude -p
    return { text: await summary($) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const usage = await read($, usageAtom)
    const history = await read($, historyAtom)
    const error = await read($, errorAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    const sum = totals(usage, history, now)
    const today = localDate(now)
    const days = history ? lastSevenDays(history.days, now) : []
    const max = Math.max(...days.map(day => day.usd), 0)
    const barWidth = Math.max(8, Math.min(40, e.props.bodyColumns - 24))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Rate limits</Text>
          {(usage?.limits ?? []).length === 0 && <Text dimColor>No reading yet (needs a subscription and one request)</Text>}
          {(usage?.limits ?? []).map(limit => {
            const resets = resetsIn(limit.resetsAt, now)

            return (
              <Text key={limit.kind}>
                <Text color={level(limit.percentUsed)}>{glyph(limit.percentUsed)}</Text> {limitLabel(limit.kind).padEnd(5)}
                <Text bold>{String(limit.percentUsed).padStart(5)}%</Text>
                <Text dimColor>{resets ? `  resets in ${resets}` : ''}</Text>
              </Text>
            )
          })}
        </Box>

        <Box flexDirection="column">
          <Text bold>Last 7 days</Text>
          {error && <Text color="red">ccusage failed: {error}</Text>}
          {!history && !error && <Text dimColor>Reading ccusage…</Text>}
          {days.map(day => (
            <Text key={day.date} bold={day.date === today}>
              {weekday(day.date)} {day.date.slice(5)} <Text color="green">{bar(day.usd, max, barWidth)}</Text>{' '}
              {money(day.usd).padStart(8)}
            </Text>
          ))}
        </Box>

        <Text>
          session <Text bold>{money(sum.session)}</Text> · today <Text bold>{money(sum.today)}</Text> · 7d{' '}
          <Text bold>{money(sum.week)}</Text> · month <Text bold>{money(sum.month)}</Text>
        </Text>

        <Box flexDirection="row" gap={2}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($, argv)} />
          <Text dimColor>API-equivalent cost from ccusage, not your bill on a subscription</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const usage = await read($, usageAtom)
    const history = await read($, historyAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())

    if (e.props.hasSurvey || !usage || (usage.limits.length === 0 && usage.sessionUsd === null)) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const isCompact = e.props.bodyColumns < 90
    const sum = totals(usage, history, now)

    // Svg draws only on Desktop, so the terminal gets a pie glyph instead
    const icon = (percent: number) =>
      'Svg' in elements ? (
        <elements.Svg source={ring(percent)} alt={`${percent}%`} width={20} height={20} />
      ) : (
        <Text color={level(percent)}>{glyph(percent)}</Text>
      )

    return (
      <Box flexDirection="row" gap={3}>
        {usage.limits.map(limit => {
          const resets = resetsIn(limit.resetsAt, now)

          return (
            <Box key={limit.kind} flexDirection="row" gap={1}>
              {icon(limit.percentUsed)}
              <Text bold>{limit.percentUsed}%</Text>
              <Text dimColor>
                {limitLabel(limit.kind)}
                {resets && !isCompact ? ` · resets ${resets}` : ''}
              </Text>
            </Box>
          )
        })}
        <Box key="spend" flexDirection="row" gap={1}>
          <Text color="green" bold>
            {money(sum.session)}
          </Text>
          <Text dimColor>{money(sum.today)} today</Text>
          {!isCompact && <Text dimColor>{money(sum.month)} mo</Text>}
        </Box>
      </Box>
    )
  })
}
