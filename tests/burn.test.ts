import type { On, SessionContextBreakdown } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Limit } from '../types'
import { creditsLabel, lastSevenDays, modelName, parseCredits, resetsIn, totals } from '../hooks/format'

const NOW = new Date(2026, 9, 2, 12, 0).getTime()
const SURFACES = ['terminal', 'desktop'] as const
const SCROLL = { offset: 0, bodyRows: 10 }

const limits: Limit[] = [
  { kind: 'five_hour', percentUsed: 14, resetsAt: new Date(NOW + 67 * 60000).toISOString() },
  { kind: 'seven_day', percentUsed: 83, resetsAt: new Date(NOW + 227 * 60000).toISOString() },
]

const days = [
  { date: '2026-09-30', usd: 3 },
  { date: '2026-10-01', usd: 2 },
  { date: '2026-10-02', usd: 1 },
]

const USAGE_BODY = JSON.stringify({
  five_hour: { utilization: 14 },
  extra_usage: { is_enabled: true, monthly_limit: 12000, used_credits: 12006, currency: 'EUR', decimal_places: 2 },
})

function measure(usd: number, percent = 31) {
  return {
    context: { window: 200_000, tokens: percent * 2000, percent },
    rateLimits: limits,
    cost: { usd },
    changed: ['cost' as const, 'context' as const],
  }
}

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 12_400, color: 'x', isDeferred: false, kind: 'used' as const },
    { name: 'Messages', tokens: 38_300, color: 'x', isDeferred: false, kind: 'used' as const },
    { name: 'Free space', tokens: 138_000, color: 'x', isDeferred: false, kind: 'free' as const },
  ],
  // Only the rows matter to burn
} as unknown as SessionContextBreakdown

// Answers what the mod reads beneath it, then fills its state the way a session does
async function seed($: Engine, on: On): Promise<void> {
  mock.clock(on, { now: NOW })
  mock.store(on, Object.fromEntries(days.map(day => [`day:${day.date}`, day.usd])))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  on('session.model', async () => ({ value: 'claude-opus-5-5[1m]' }))
  on('agent.list', async () => ({
    value: [
      { id: 'a1', description: 'find files', type: 'Explore', status: 'running' },
      { id: 'a2', description: 'plan it', type: 'Plan', status: 'completed' },
    ],
  }))
  on('session.authorize', async () => ({ value: { handle: 'test', kind: 'bearer' as const } }))
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: USAGE_BODY } }))
  on('session.usage', async () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000, tokens: 62_000, percent: 31, breakdown: BREAKDOWN },
      rateLimits: limits,
      cost: { usd: 0.75 },
    },
  }))

  await $.command.run({
    command: 'burn',
    args: 'refresh',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  // The first reading is the baseline, the second adds $0.25 to today
  await $.session.measure(measure(0.5))
  await $.session.measure(measure(0.75))
}

describe('format', () => {
  test('reads usage credits and hides them when off', async () => {
    const credits = parseCredits(USAGE_BODY)

    expect(credits).toEqual({ used: 12006, limit: 12000, currency: 'EUR', decimals: 2 })
    expect(credits && creditsLabel(credits)).toBe('€120.06 / €120')
    expect(parseCredits(JSON.stringify({ extra_usage: { is_enabled: false } }))).toBe(null)
    expect(parseCredits(JSON.stringify({}))).toBe(null)
  })

  test('sums today, the last 7 days and the month', async () => {
    expect(totals(0.5, days, NOW)).toEqual({ session: 0.5, today: 1, week: 6, month: 3 })
    expect(lastSevenDays(days, NOW).map(day => day.usd)).toEqual([0, 0, 0, 0, 3, 2, 1])
  })

  test('formats reset countdowns', async () => {
    expect(resetsIn(new Date(NOW + 67 * 60000).toISOString(), NOW)).toBe('1h7m')
    expect(resetsIn(new Date(NOW + 26 * 3600000).toISOString(), NOW)).toBe('1d2h')
    expect(resetsIn(undefined, NOW)).toBe(null)
  })

  test('shortens model ids', async () => {
    expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName('claude-sonnet-5-5', true)).toBe('Sonnet')
    expect(modelName('Opus 5.5')).toBe('Opus 5.5')
  })
})

describe('recording', () => {
  test('adds only the spend since the last measurement to today', async ($, on) => {
    await seed($, on)
    const ui = await $.ui.mount({
      plugin: 'burn',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'burn',
      props: { title: 'burn', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: SCROLL, view: {} },
    })

    // Today was $1 in the store, plus $0.25 between the two measurements
    expect(await ui.find({ type: 'Text', text: '≈$1.25' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '≈$6.25' })).toBeDefined()
  })
})

describe('context', () => {
  test('warns once when the context passes 85%', async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    await seed($, on)

    await $.session.measure(measure(0.75, 86))
    await $.session.measure(measure(0.75, 90))

    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatch(/86% full/)
  })

  test('the Compact button compacts the session', async ($, on) => {
    let compacted = 0
    on('session.compact', async () => {
      compacted += 1

      return { messages: [] }
    })
    await seed($, on)
    const ui = await $.ui.mount({
      plugin: 'burn',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'burn',
      props: { title: 'burn', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: SCROLL, view: {} },
    })

    expect(await ui.find({ type: 'Text', text: 'System prompt' })).toBeDefined()
    await ui.press({ key: 'compact' })

    expect(compacted).toBe(1)
  })
})

describe('drawing', () => {
  test('the band shows limits, credits and session spend on every surface', async ($, on) => {
    await seed($, on)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'burn',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 140, scroll: SCROLL, view: {} },
      })

      expect(await ui.find({ type: 'Text', text: '83%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'ctx 62k/200k' })).toBeDefined()
      // The terminal can't draw Svg, so its rings are pie glyphs
      expect(await ui.find(surface === 'desktop' ? { type: 'Svg' } : { type: 'Text', text: '◕' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '€120.06/120' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '≈$0.75 session' })).toBeDefined()
      // Only the running subagent follows the model
      expect(await ui.find({ type: 'Text', text: 'Opus 5.5' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '› Explore' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the band draws Nerd Font icons in the terminal when asked', { options: { terminalIcons: 'nerd' } }, async ($, on) => {
    await seed($, on)
    const ui = await $.ui.mount({
      plugin: 'burn',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 140, scroll: SCROLL, view: {} },
    })

    expect(await ui.find({ type: 'Text', text: '\uF073' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '\uF153' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◕' })).toBeUndefined()
  })

  test('the pane draws 7 bars and a refresh button on every surface', async ($, on) => {
    await seed($, on)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'burn',
        surface,
        component: 'Pane',
        requestId: 'burn',
        props: { title: 'burn', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: SCROLL, view: {} },
      })

      for (const day of lastSevenDays(days, NOW)) {
        expect(await ui.find({ key: `day-${day.date}` })).toBeDefined()
      }

      expect(await ui.find({ key: 'refresh' })).toBeDefined()
      await ui.unmount()
    }
  })
})
