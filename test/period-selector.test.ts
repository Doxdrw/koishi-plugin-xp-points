import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parseLeaderboardQuery as parse } from '../src/period-selector'

it('supports natural historical periods while retaining page numbers', () => {
  for (const [query, kind, offset, page] of [
    ['上周', 'week', 1, 1], ['上月 2', 'month', 1, 2], ['前2赛季', 'season', 2, 1],
    ['周 前2期 3', 'week', 2, 3], ['周 2', 'week', 0, 2], ['今年', 'year', 0, 1],
  ] as const) assert.deepEqual(parse(query), { page, options: { period: kind, offset } })
  assert.deepEqual(parse('2'), { page: 2, options: {} })
  assert.deepEqual(parse(undefined, { period: '周', date: '2026-10-01' }), { page: 1, options: { period: 'week', offset: 0, date: '2026-10-01' } })
})

it('rejects ambiguous, conflicting or unbounded selectors', () => {
  for (const query of ['前0周', '前121周', '周 前121期', '周 2 3', '2.5', '周 前-2期', '上周 前2期']) assert.throws(() => parse(query))
  assert.throws(() => parse('上周', { date: '2026-10-01' }))
  assert.throws(() => parse('上周', { period: '月' }))
})
