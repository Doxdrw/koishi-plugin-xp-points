import assert from 'node:assert/strict'
import { it } from 'node:test'
import { scorePeriodWindow, zonedDayStart, normalizePeriodConfig } from '../src/period-calendar'
const instant = (s: string) => Date.parse(s)
it('uses Shanghai calendar days/weeks/months/years and left-closed right-open boundaries', () => {
  const t = instant('2026-03-01T00:00:00+08:00')
  assert.equal(scorePeriodWindow('month', t)!.label, '2026-03')
  assert.equal(scorePeriodWindow('month', t - 1)!.label, '2026-02')
  assert.equal(scorePeriodWindow('week', instant('2026-03-02T00:00:00+08:00'))!.label, '2026-03-02')
  assert.equal(scorePeriodWindow('week', instant('2026-03-01T23:59:59+08:00'))!.label, '2026-02-23')
  assert.equal(scorePeriodWindow('year', instant('2027-01-01T00:00:00+08:00'))!.label, '2027')
  assert.equal(scorePeriodWindow('day', t)!.start, t)
})
it('handles leap days and end-of-month season anchors without drifting', () => {
  const feb = scorePeriodWindow('month', instant('2024-02-20T00:00:00Z'))!
  assert.equal(feb.end - feb.start, 29 * 86400000)
  const config = { season: { unit: 'month' as const, length: 1, start: '2024-01-31' } }
  const s = scorePeriodWindow('season', instant('2024-03-20T00:00:00Z'), config)!
  assert.equal(s.start, zonedDayStart('2024-02-29'))
  assert.equal(s.end, zonedDayStart('2024-03-31'))
  assert.equal(s.label, 'S2')
  assert.equal(scorePeriodWindow('season', instant('2024-01-30T00:00:00Z'), config), null)
})
it('counts calendar days across DST instead of fixed 24-hour milliseconds', () => {
  const config = { timeZone: 'America/New_York' }
  const spring = scorePeriodWindow('day', instant('2024-03-10T15:00:00Z'), config)!
  assert.equal(spring.end - spring.start, 23 * 3600000)
  const fall = scorePeriodWindow('day', instant('2024-11-03T15:00:00Z'), config)!
  assert.equal(fall.end - fall.start, 25 * 3600000)
  const season = scorePeriodWindow('season', instant('2024-03-11T12:00:00Z'), { ...config, season: { unit: 'day', length: 7, start: '2024-03-04' } })!
  assert.equal(season.start, instant('2024-03-11T04:00:00Z'))
})
it('handles midnight gaps and folds and a skipped calendar date deterministically', () => {
  assert.equal(zonedDayStart('2018-11-04', 'America/Sao_Paulo'), instant('2018-11-04T03:00:00Z'))
  assert.equal(zonedDayStart('2020-11-01', 'America/Havana'), instant('2020-11-01T04:00:00Z'))
  assert.equal(zonedDayStart('2011-12-30', 'Pacific/Apia'), instant('2011-12-30T10:00:00Z'))
})
it('has monthly seasons by default and rejects malformed configuration', () => {
  assert.equal(scorePeriodWindow('season', instant('2026-09-12T00:00:00Z'))!.label, '2026-09')
  assert.throws(() => normalizePeriodConfig({ timeZone: 'not-a-zone' }), /时区/)
  assert.throws(() => normalizePeriodConfig({ season: { unit: 'day', length: 0, start: '2026-01-01' } }), /长度/)
  assert.throws(() => normalizePeriodConfig({ season: { unit: 'month', length: 1, start: '2026-02-30' } }), /日期/)
  assert.throws(() => scorePeriodWindow('day', NaN), /时间/)
})
