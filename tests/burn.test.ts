import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { History, Usage } from '../types'
import { lastSevenDays, parseDaily, resetsIn, sinceArg, totals } from '../hooks/format'

const NOW = new Date(2026, 9, 2, 12, 0).getTime()
const SURFACES = ['terminal', 'desktop'] as const
const SCROLL = { offset: 0, bodyRows: 10 }

const usage: Usage = {
  limits: [
    { kind: 'five_hour', percentUsed: 14, resetsAt: new Date(NOW + 67 * 60000).toISOString() },
    { kind: 'seven_day', percentUsed: 83, resetsAt: new Date(NOW + 227 * 60000).toISOString() },
  ],
  sessionUsd: 0.5,
}

const history: History = {
  days: [
    { date: '2026-09-30', usd: 3 },
    { date: '2026-10-01', usd: 2 },
    { date: '2026-10-02', usd: 1 },
  ],
  fetchedAt: NOW,
  sessionUsdAtFetch: 0.25,
}

// Answers what the mod reads beneath it, then fills its state the way a session does
async function seed($: Engine, on: On): Promise<void> {
  mock.clock(on, { now: NOW })
  on('session.usage', async () => ({
    value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: usage.limits, cost: { usd: 0.25 } },
  }))
  on('process.run', async () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({ daily: history.days.map(day => ({ period: day.date, totalCost: day.usd })) }),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  on('session.measure', async (_$, e) => ({ changed: e.changed }))

  await $.command.run({
    command: 'burn',
    args: 'refresh',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  await $.session.measure({ context: { window: 200_000 }, rateLimits: usage.limits, cost: { usd: 0.5 }, changed: ['cost'] })
}

describe('format', () => {
  test('reads both ccusage day shapes', async () => {
    const days = parseDaily(JSON.stringify({ daily: [{ period: '2026-10-02', totalCost: 1.5 }, { date: '2026-10-01', totalCost: 2 }] }))

    expect(days).toEqual([
      { date: '2026-10-02', usd: 1.5 },
      { date: '2026-10-01', usd: 2 },
    ])
  })

  test('counts session spend since the ccusage read only once', async () => {
    const sum = totals(usage, history, NOW)

    expect(sum.today).toBe(1.25)
    expect(sum.month).toBe(3.25)
    expect(sum.week).toBe(6.25)
  })

  test('fills the 7 days with zeros and reaches back past the month start', async () => {
    expect(lastSevenDays(history.days, NOW).map(day => day.usd)).toEqual([0, 0, 0, 0, 3, 2, 1])
    expect(sinceArg(NOW)).toBe('20260926')
  })

  test('formats reset countdowns', async () => {
    expect(resetsIn(new Date(NOW + 67 * 60000).toISOString(), NOW)).toBe('1h7m')
    expect(resetsIn(new Date(NOW + 26 * 3600000).toISOString(), NOW)).toBe('1d2h')
    expect(resetsIn(undefined, NOW)).toBe(null)
  })
})

describe('drawing', () => {
  test('the band shows limits and spend on every surface', async ($, on) => {
    await seed($, on)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'burn',
        surface,
        component: 'AbovePrompt',
        props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: SCROLL, view: {} },
      })

      expect(await ui.find({ type: 'Text', text: '83%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /resets 3h47m/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '$1.25 today' })).toBeDefined()
      await ui.unmount()
    }
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

      expect(await ui.findAll({ type: 'Text', text: /^[█░]+$/ })).toHaveLength(7)
      expect(await ui.find({ key: 'refresh' })).toBeDefined()
      await ui.unmount()
    }
  })
})
