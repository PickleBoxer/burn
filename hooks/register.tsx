import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { Credits, Day, Usage } from '../types'
import {
  bar,
  creditsLabel,
  creditsPercent,
  daysAgo,
  glyph,
  lastSevenDays,
  level,
  limitLabel,
  localDate,
  money,
  parseCredits,
  resetsIn,
  totals,
} from './format'

const PANE = 'burn'
const REFRESH_MS = 10 * 60 * 1000
const TICK_MS = 60 * 1000
const KEEP_DAYS = 40
const LABEL_COLUMNS = 10
const PRICE_COLUMNS = 10
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const usageAtom = atom({ plugin: 'burn', key: 'usage' } as const, null)
const daysAtom = atom({ plugin: 'burn', key: 'days' } as const, [])
const creditsAtom = atom({ plugin: 'burn', key: 'credits' } as const, null)
const recordedAtom = atom({ plugin: 'burn', key: 'recordedUsd' } as const, null)
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

// Moves the clock the countdowns read, which redraws the band and the pane
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
}

// Daily totals live in $.store as `day:YYYY-MM-DD`, shared by every session on the machine
async function loadDays($: EngineInterface): Promise<void> {
  const oldest = daysAgo(await $.clock.now(), KEEP_DAYS)
  const days: Day[] = []

  for (const key of await $.store.keys()) {
    if (!key.startsWith('day:')) {
      continue
    }

    const date = key.slice(4)

    if (date < oldest) {
      await $.store.delete(key)
    } else {
      days.push({ date, usd: Number((await $.store.get(key)) ?? 0) })
    }
  }

  await update($, daysAtom, () => days)
}

// Adds what the session spent since the last measurement to today's total
async function record($: EngineInterface, sessionUsd: number | null): Promise<void> {
  const recorded = await read($, recordedAtom)

  if (sessionUsd === null) {
    return
  }

  // First reading, or /clear started the session's cost over
  if (recorded === null || sessionUsd < recorded) {
    await update($, recordedAtom, () => sessionUsd)

    return
  }

  const delta = sessionUsd - recorded

  if (delta <= 0) {
    return
  }

  await update($, recordedAtom, () => sessionUsd)
  const key = `day:${localDate(await $.clock.now())}`
  await $.store.set(key, Number((await $.store.get(key)) ?? 0) + delta)
  await loadDays($)
}

// Usage credits come from the endpoint /status reads. It's internal, so any failure hides them.
async function loadCredits($: EngineInterface): Promise<void> {
  let credits: Credits | null = null

  try {
    const auth = await $.session.authorize()

    if (auth) {
      const res = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
      credits = res.ok ? parseCredits(res.text) : null
    }
  } catch {
    credits = null
  }

  await update($, creditsAtom, () => credits)
}

async function refresh($: EngineInterface): Promise<void> {
  await loadDays($)
  await loadCredits($)
}

async function summary($: EngineInterface): Promise<string> {
  const usage = await read($, usageAtom)
  const credits = await read($, creditsAtom)
  const now = await $.clock.now()
  const sum = totals(usage?.sessionUsd ?? null, await read($, daysAtom), now)
  const limits = (usage?.limits ?? []).map(limit => {
    const resets = resetsIn(limit.resetsAt, now)

    return `${glyph(limit.percentUsed)} ${limitLabel(limit.kind)} ${limit.percentUsed}%${resets ? ` (resets ${resets})` : ''}`
  })

  return [
    ...limits,
    ...(credits ? [`${glyph(creditsPercent(credits))} ${creditsLabel(credits)} credits`] : []),
    `session ${money(sum.session)}`,
    `today ${money(sum.today)}`,
    `7d ${money(sum.week)}`,
    `month ${money(sum.month)}`,
  ].join(' · ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'burn',
      description: 'Show rate limits, usage credits and spend for the last 7 days',
    })

    const usage = toUsage(await $.session.usage())
    await update($, usageAtom, () => usage)
    await tick($)

    // A resumed session's earlier cost was recorded by the process that ran it
    if ((await read($, recordedAtom)) === null) {
      await update($, recordedAtom, () => usage.sessionUsd ?? 0)
    }

    await loadDays($)
    void loadCredits($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const usage = toUsage(e)
    await update($, usageAtom, () => usage)
    await record($, usage.sessionUsd)

    return next(e)
  })

  on('command.run', { command: 'burn' }, async ($, e) => {
    if (e.args.trim() === 'refresh') {
      await refresh($)

      return { text: await summary($) }
    }

    await $.ui.open({ id: PANE, title: 'burn', closeOnEscape: true })

    // Shown where nothing draws, such as the VS Code panel or claude -p
    return { text: await summary($) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const usage = await read($, usageAtom)
    const credits = await read($, creditsAtom)
    const stored = await read($, daysAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())
    const sum = totals(usage?.sessionUsd ?? null, stored, now)
    const today = localDate(now)
    const days = lastSevenDays(stored, now)
    const max = Math.max(...days.map(day => day.usd), 0)
    const barWidth = Math.max(8, Math.min(40, e.props.bodyColumns - LABEL_COLUMNS - PRICE_COLUMNS - 2))
    const since = stored.map(day => day.date).sort()[0]

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>Limits</Text>
          {(usage?.limits ?? []).length === 0 && <Text dimColor>No reading yet (needs a subscription and one request)</Text>}
          {(usage?.limits ?? []).map(limit => {
            const resets = resetsIn(limit.resetsAt, now)

            return (
              <Text key={limit.kind}>
                <Text color={level(limit.percentUsed)}>{glyph(limit.percentUsed)}</Text> {limitLabel(limit.kind).padEnd(8)}
                <Text bold>{String(limit.percentUsed).padStart(5)}%</Text>
                <Text dimColor>{resets ? `  resets in ${resets}` : ''}</Text>
              </Text>
            )
          })}
          {credits && (
            <Text key="credits">
              <Text color={level(creditsPercent(credits))}>{glyph(creditsPercent(credits))}</Text> {'credits'.padEnd(8)}
              <Text bold>{String(creditsPercent(credits)).padStart(5)}%</Text>
              <Text dimColor>  {creditsLabel(credits)} this month</Text>
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text bold>Last 7 days</Text>
          {/* Fixed label and price columns, so the bars line up whatever the amounts are */}
          {days.map(day => (
            <Box key={day.date} flexDirection="row" gap={1}>
              <Box width={LABEL_COLUMNS} flexShrink={0}>
                <Text bold={day.date === today} wrap="truncate">
                  {weekday(day.date)} {day.date.slice(5)}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text color="green" wrap="truncate">
                  {bar(day.usd, max, barWidth)}
                </Text>
              </Box>
              <Box width={PRICE_COLUMNS} flexShrink={0} justifyContent="flex-end">
                <Text bold={day.date === today} wrap="truncate">
                  {money(day.usd)}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>

        <Text>
          session <Text bold>{money(sum.session)}</Text> · today <Text bold>{money(sum.today)}</Text> · 7d{' '}
          <Text bold>{money(sum.week)}</Text> · month <Text bold>{money(sum.month)}</Text>
        </Text>

        <Box flexDirection="row" gap={2}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
          <Text dimColor>
            ≈ is API-equivalent cost, recorded by burn{since ? ` since ${since}` : ''}. Only credits are billed.
          </Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const usage = await read($, usageAtom)
    const credits = await read($, creditsAtom)
    const now = (await read($, nowAtom)) || (await $.clock.now())

    if (e.props.hasSurvey || !usage || (usage.limits.length === 0 && usage.sessionUsd === null && !credits)) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const isCompact = e.props.bodyColumns < 100
    const sum = totals(usage.sessionUsd, await read($, daysAtom), now)

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
        {credits && (
          <Box key="credits" flexDirection="row" gap={1}>
            {icon(creditsPercent(credits))}
            <Text bold>{creditsLabel(credits)}</Text>
            {!isCompact && <Text dimColor>credits</Text>}
          </Box>
        )}
        <Box key="spend" flexDirection="row" gap={1}>
          <Text dimColor>{money(sum.session)} session</Text>
          {!credits && !isCompact && <Text dimColor>{money(sum.today)} today</Text>}
        </Box>
      </Box>
    )
  })
}
