import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { ContextRow, Credits, Day, Skill, Usage } from '../types'
import {
  bar,
  clockTime,
  contextLevel,
  creditsLabel,
  creditsPercent,
  currencySymbol,
  daysAgo,
  glyph,
  lastSevenDays,
  level,
  limitLabel,
  localDate,
  modelName,
  money,
  parseCredits,
  resetsIn,
  skillLabel,
  tokens,
  totals,
} from './format'

const PANE = 'burn'
const REFRESH_MS = 10 * 60 * 1000
const TICK_MS = 60 * 1000
const KEEP_DAYS = 40
const LABEL_COLUMNS = 10
const PRICE_COLUMNS = 10
const WARN_PERCENT = 85
const ROW_COLUMNS = 18
const TOKEN_COLUMNS = 8
const SKILL_COLUMNS = 7
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const usageAtom = atom({ plugin: 'burn', key: 'usage' } as const, null)
const daysAtom = atom({ plugin: 'burn', key: 'days' } as const, [])
const creditsAtom = atom({ plugin: 'burn', key: 'credits' } as const, null)
const recordedAtom = atom({ plugin: 'burn', key: 'recordedUsd' } as const, null)
const nowAtom = atom({ plugin: 'burn', key: 'now' } as const, 0)
const breakdownAtom = atom({ plugin: 'burn', key: 'breakdown' } as const, null)
const hasWarnedAtom = atom({ plugin: 'burn', key: 'hasWarned' } as const, false)
const agentAtom = atom({ plugin: 'burn', key: 'agent' } as const, null)
const skillsAtom = atom({ plugin: 'burn', key: 'skills' } as const, [])

const HEX = { green: '#4caf50', yellow: '#d9a520', red: '#e5534b' }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function toUsage(source: SessionUsage | SessionMeasureInput): Usage {
  return {
    limits: source.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    sessionUsd: source.cost?.usd ?? null,
    context: {
      tokens: source.context.tokens ?? null,
      window: source.context.window,
      percent: source.context.percent ?? null,
    },
  }
}

// What each band group measures, drawn as an icon inside Desktop's ring
type Kind = 'context' | 'five_hour' | 'seven_day' | 'credits'

// Nerd Font md-robot, shown before the model
const NERD_AGENT = '\u{F06A9}'

// Nerd Font md-flash, shown before the loaded skills
const NERD_SKILLS = '\u{F0241}'

// Nerd Font glyphs: md-brain, fa-clock, fa-calendar, and the currency signs
const NERD: Record<Exclude<Kind, 'credits'>, string> = { context: '\u{F09D1}', five_hour: '\uF017', seven_day: '\uF073' }
const NERD_CURRENCY: Record<string, string> = { EUR: '\uF153', USD: '\uF155', GBP: '\uF154' }

function nerdIcon(kind: Kind | null, currency: string): string | null {
  if (kind === 'credits') {
    return NERD_CURRENCY[currency] ?? '\uF0D6'
  }

  return kind ? NERD[kind] : null
}

function kindOf(limitKind: string): Kind | null {
  return limitKind === 'five_hour' || limitKind === 'seven_day' ? limitKind : null
}

// Icons drawn in the middle of a 24 by 24 ring, in the ring's color
function innerIcon(kind: Kind | null, hex: string, currency: string): string {
  const stroke = `fill="none" stroke="${hex}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`

  switch (kind) {
    case 'context':
      return `<path d="M8.5 9h7M8.5 12h7M8.5 15h7" ${stroke}/>`
    case 'five_hour':
      return `<circle cx="12" cy="12" r="4.2" ${stroke}/><path d="M12 9.8V12l1.6 1.1" ${stroke}/>`
    case 'seven_day':
      return `<rect x="8" y="8.6" width="8" height="7.4" rx="1.4" ${stroke}/><path d="M8 11h8M10.3 7.6v1.8M13.7 7.6v1.8" ${stroke}/>`
    case 'credits':
      return `<text x="12" y="15.4" text-anchor="middle" font-family="-apple-system, system-ui, sans-serif" font-size="9.5" font-weight="700" fill="${hex}">${currency}</text>`
    default:
      return ''
  }
}

function ring(percent: number, color: keyof typeof HEX, kind: Kind | null, currency = '$'): string {
  const r = 10
  const length = 2 * Math.PI * r
  const filled = (Math.min(100, percent) / 100) * length

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="${r}" fill="none" stroke="#444" stroke-width="2.2"/>` +
    `<circle cx="12" cy="12" r="${r}" fill="none" stroke="${HEX[color]}" stroke-width="2.2" ` +
    `stroke-linecap="round" stroke-dasharray="${filled} ${length}" transform="rotate(-90 12 12)"/>` +
    innerIcon(kind, HEX[color], currency) +
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

// The /context rows, estimated locally, so it costs no request
async function loadBreakdown($: EngineInterface): Promise<void> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const rows: ContextRow[] = []

  for (const category of context.breakdown?.categories ?? []) {
    if (category.kind !== 'deferred' && category.tokens > 0) {
      rows.push({ name: category.name, tokens: category.tokens, kind: category.kind })
    }
  }

  await update($, breakdownAtom, () => rows)
}

// Warns once when the context nearly fills up, and again after it has been compacted
async function warn($: EngineInterface, percent: number | null): Promise<void> {
  const hasWarned = await read($, hasWarnedAtom)

  if (percent === null) {
    return
  }

  if (percent >= WARN_PERCENT && !hasWarned) {
    await update($, hasWarnedAtom, () => true)
    $.ui.toast(`Context is ${percent}% full. Run /compact, or press Compact in /burn.`)
  } else if (percent < 50 && hasWarned) {
    await update($, hasWarnedAtom, () => false)
  }
}

// The main loop's model and the subagents running under it. No event says when one ends,
// so measurements and spawns re-read the list.
async function loadAgent($: EngineInterface): Promise<void> {
  const model = await $.session.model()
  const subagents = (await $.agent.list())
    .filter(agent => agent.status === 'running')
    .map(agent => agent.type)

  await update($, agentAtom, () => ({ model, subagents: [...new Set(subagents)] }))
}

// The first load of a skill in each loop is the one kept
async function addSkills($: EngineInterface, added: Skill[]): Promise<void> {
  await update($, skillsAtom, skills => [
    ...skills,
    ...added.filter(
      (skill, i) =>
        !skills.some(known => known.name === skill.name && known.agent === skill.agent) &&
        added.findIndex(other => other.name === skill.name && other.agent === skill.agent) === i,
    ),
  ])
}

// Skills, legacy .claude/commands and plugin skills (namespaced plugin:name) expand into a
// prompt. Built-ins, MCP prompts and commands a plugin registers in code (/burn) don't.
async function isSkillCommand($: EngineInterface, name: string): Promise<boolean> {
  const command = (await $.command.list()).find(command => command.name === name)

  return command?.source === 'user' || (command?.source === 'plugin' && command.name.includes(':'))
}

async function agentType($: EngineInterface, agentId: string | undefined): Promise<string | null> {
  if (agentId === undefined) {
    return null
  }

  return (await $.agent.list()).find(agent => agent.id === agentId)?.type ?? 'subagent'
}

// A resumed session starts with no skills, so read the Skill tool calls it made.
// Skills typed as /name don't show up as tool calls and are missed here.
async function loadSkills($: EngineInterface): Promise<void> {
  const messages = await $.session.messages()

  if (!Array.isArray(messages)) {
    return
  }

  const skills = messages
    .flatMap(message => message.toolUses)
    .filter(use => use.tool === 'Skill' && typeof use.input.skill === 'string')
    .map((use): Skill => ({ name: use.input.skill as string, how: 'claude', agent: null, at: null }))

  await addSkills($, skills)
}

// The main loop's skills, then each subagent's: `/commit  tdd   › Explore: pong`
function skillsLine(skills: Skill[]): string {
  const main = skills.filter(skill => skill.agent === null).map(skillLabel)
  const agents = [...new Set(skills.flatMap(skill => (skill.agent === null ? [] : [skill.agent])))].map(
    agent => `› ${agent}: ${skills.filter(skill => skill.agent === agent).map(skillLabel).join('  ')}`,
  )

  return [main.join('  '), ...agents].filter(Boolean).join('   ')
}

async function compact($: EngineInterface): Promise<void> {
  try {
    const result = await $.session.compact()

    if (result.skip) {
      $.ui.toast(`Not compacted: ${result.skip}`)
    }
  } catch {
    $.ui.toast("Can't compact while Claude is working")
  }
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

  const context = usage?.context.percent != null
    ? [`${glyph(usage.context.percent)} ctx ${usage.context.percent}% (${tokens(usage.context.tokens ?? 0)}/${tokens(usage.context.window)})`]
    : []

  return [
    ...context,
    ...limits,
    ...(credits ? [`${glyph(creditsPercent(credits))} ${creditsLabel(credits)} credits`] : []),
    `session ${money(sum.session)}`,
    `today ${money(sum.today)}`,
    `7d ${money(sum.week)}`,
    `month ${money(sum.month)}`,
  ].join(' · ')
}

export const register: Register = (on, options) => {
  const isNerd = options.terminalIcons === 'nerd'

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
    await loadAgent($)
    await loadSkills($)
    void loadCredits($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const usage = toUsage(e)
    await update($, usageAtom, () => usage)
    await record($, usage.sessionUsd)
    await warn($, usage.context.percent)
    await loadAgent($)

    if (e.changed.includes('context')) {
      await loadBreakdown($)
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await loadAgent($)

    return result
  })

  // skill.prompt would cover every load, but the built-in security plugin routes it past
  // the user tier, so typed skills are read from command.run and Claude's from the Skill tool.
  // Preloads into a subagent's frontmatter show in neither and are missed.
  on('command.run', async ($, e, next) => {
    const result = await next(e)

    if (await isSkillCommand($, e.command)) {
      await addSkills($, [{ name: e.command, how: 'typed', agent: null, at: await $.clock.now() }])
    }

    return result
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const result = await next(e)

    if (!result.deny && !result.isError && typeof e.skill === 'string') {
      await addSkills($, [{ name: e.skill, how: 'claude', agent: await agentType($, e.agentId), at: await $.clock.now() }])
    }

    return result
  })

  on('command.run', { command: 'burn' }, async ($, e) => {
    if (e.args.trim() === 'refresh') {
      await refresh($)

      return { text: await summary($) }
    }

    await loadBreakdown($)
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
    const context = usage?.context
    const rows = (await read($, breakdownAtom)) ?? []
    const rowBarWidth = Math.max(8, Math.min(40, e.props.bodyColumns - ROW_COLUMNS - TOKEN_COLUMNS - 2))
    const skills = await read($, skillsAtom)

    return (
      <Box flexDirection="column" gap={1}>
        {context && (
          <Box flexDirection="column">
            <Text bold>
              Context{' '}
              <Text dimColor>
                {context.tokens === null ? 'no reading yet' : `${tokens(context.tokens)} / ${tokens(context.window)}`}
              </Text>
              {context.percent !== null && <Text color={contextLevel(context.percent)}> {context.percent}%</Text>}
            </Text>
            {rows.map(row => (
              <Box key={row.name} flexDirection="row" gap={1}>
                <Box width={ROW_COLUMNS} flexShrink={0}>
                  <Text dimColor={row.kind !== 'used'} wrap="truncate">
                    {row.name}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  <Text color={row.kind === 'used' ? 'cyan' : undefined} dimColor={row.kind !== 'used'} wrap="truncate">
                    {bar(row.tokens, context.window, rowBarWidth)}
                  </Text>
                </Box>
                <Box width={TOKEN_COLUMNS} flexShrink={0} justifyContent="flex-end">
                  <Text dimColor={row.kind !== 'used'} wrap="truncate">
                    {tokens(row.tokens)}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {skills.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Skills</Text>
            {skills.map(skill => (
              <Box key={`skill-${skill.agent ?? 'main'}-${skill.name}`} flexDirection="row" gap={1}>
                <Box width={ROW_COLUMNS} flexShrink={0}>
                  <Text wrap="truncate">{skillLabel(skill)}</Text>
                </Box>
                <Box width={SKILL_COLUMNS} flexShrink={0}>
                  <Text dimColor>{skill.how === 'typed' ? 'typed' : 'Claude'}</Text>
                </Box>
                <Box width={ROW_COLUMNS} flexShrink={0}>
                  <Text dimColor wrap="truncate">
                    {skill.agent ?? 'main'}
                  </Text>
                </Box>
                <Text dimColor>{skill.at === null ? 'resumed' : clockTime(skill.at)}</Text>
              </Box>
            ))}
          </Box>
        )}

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
              <Box key={`day-${day.date}`} flexGrow={1} flexShrink={1} overflow="hidden">
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
          <Button key="compact" label="Compact" hotkey="c" onPress={() => void compact($)} />
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

    if (e.props.hasSurvey || !usage) {
      return next(e)
    }

    const agent = await read($, agentAtom)
    const skills = await read($, skillsAtom)
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const isCompact = e.props.bodyColumns < 100
    const sum = totals(usage.sessionUsd, await read($, daysAtom), now)

    // Svg draws only on Desktop, so the terminal gets a pie glyph instead
    const icon = (percent: number, kind: Kind | null, color = level(percent)) =>
      e.surface === 'desktop' && 'Svg' in elements ? (
        <elements.Svg source={ring(percent, color, kind, currencySymbol(credits?.currency ?? 'USD'))} alt={`${percent}%`} width={22} height={22} />
      ) : (
        <Text color={color}>{(isNerd ? nerdIcon(kind, credits?.currency ?? 'USD') : null) ?? glyph(percent)}</Text>
      )
    const context = usage.context
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={3} paddingLeft={1}>
          {agent && (
            <Box key="agent" flexDirection="row" gap={1}>
              {isNerd && e.surface !== 'desktop' && <Text color="magenta">{NERD_AGENT}</Text>}
              <Text bold>{modelName(agent.model, isCompact)}</Text>
              {agent.subagents.length > 0 && <Text dimColor>› {agent.subagents.join(', ')}</Text>}
            </Box>
          )}
          {context.percent !== null && (
            <Box key="context" flexDirection="row" gap={1}>
              {icon(context.percent, 'context', contextLevel(context.percent))}
              <Text bold>{context.percent}%</Text>
              <Text dimColor>
                ctx{!isCompact && context.tokens !== null ? ` ${tokens(context.tokens)}/${tokens(context.window)}` : ''}
              </Text>
            </Box>
          )}
          {usage.limits.map(limit => {
            const resets = resetsIn(limit.resetsAt, now)

            return (
              <Box key={limit.kind} flexDirection="row" gap={1}>
                {icon(limit.percentUsed, kindOf(limit.kind))}
                <Text bold>{limit.percentUsed}%</Text>
                <Text dimColor>
                  {limitLabel(limit.kind)}
                  {resets && !isCompact ? ` ↻${resets}` : ''}
                </Text>
              </Box>
            )
          })}
          {credits && (
            <Box key="credits" flexDirection="row" gap={1}>
              {icon(creditsPercent(credits), 'credits')}
              <Text bold>{creditsLabel(credits, true)}</Text>
            </Box>
          )}
          <Box key="spend" flexDirection="row" gap={1}>
            <Text dimColor>{money(sum.session)} session</Text>
            {!credits && !isCompact && <Text dimColor>{money(sum.today)} today</Text>}
          </Box>
        </Box>
        {skills.length > 0 && (
          <Box key="skills" flexDirection="row" gap={1} paddingLeft={1}>
            {isNerd && e.surface !== 'desktop' ? <Text color="yellow">{NERD_SKILLS}</Text> : <Text dimColor>skills</Text>}
            <Text dimColor wrap="truncate">
              {skillsLine(skills)}
            </Text>
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
