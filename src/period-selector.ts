import { XpPointsUserError } from './errors'
import type { ScorePeriodKind } from './period-calendar'

const kinds: Record<string, ScorePeriodKind | 'total'> = {
  日: 'day', 天: 'day', 周: 'week', 月: 'month', 年: 'year', 赛季: 'season', 累计: 'total',
  day: 'day', week: 'week', month: 'month', year: 'year', season: 'season', total: 'total',
}
const shortcuts: Record<string, [ScorePeriodKind, number]> = {
  今日: ['day', 0], 今天: ['day', 0], 昨日: ['day', 1], 昨天: ['day', 1],
  本周: ['week', 0], 上周: ['week', 1], 本月: ['month', 0], 上月: ['month', 1],
  今年: ['year', 0], 本年: ['year', 0], 去年: ['year', 1],
  本赛季: ['season', 0], 上赛季: ['season', 1],
}
export interface PeriodQueryOptions { period?: string; date?: string; season?: string; offset?: number }
export const MAX_PREVIOUS_PERIODS = 120

export function parsePeriodSelector(value: string): { kind: ScorePeriodKind | 'total'; offset: number } | undefined {
  if (kinds[value]) return { kind: kinds[value], offset: 0 }
  if (shortcuts[value]) return { kind: shortcuts[value][0], offset: shortcuts[value][1] }
  const previous = value.match(/^前([1-9]\d*)(天|日|周|月|年|赛季)$/u)
  if (!previous) return
  const offset = Number(previous[1])
  if (!Number.isSafeInteger(offset) || offset > MAX_PREVIOUS_PERIODS) throw new XpPointsUserError(`最多查询前${MAX_PREVIOUS_PERIODS}期。`)
  return { kind: kinds[previous[2]], offset }
}

/** Shared by bound rankings, generic rankings and administrator details. */
export function parseLeaderboardQuery(query: string | undefined, options: PeriodQueryOptions = {}) {
  const tokens = query?.trim().split(/\s+/u).filter(Boolean) ?? []
  const parsed = { ...options }
  let selection = parsed.period ? parsePeriodSelector(parsed.period) : undefined
  if (parsed.period && !selection) throw new XpPointsUserError('周期请用日、周、月、年、赛季或累计，也可用上周、前2赛季等。')
  if (tokens.length && !/^\d+$/u.test(tokens[0])) {
    const positional = parsePeriodSelector(tokens.shift()!)
    if (!positional) throw new XpPointsUserError('周期请用日、周、月、年、赛季或累计，也可用上周、前2赛季等。')
    if (selection && (selection.kind !== positional.kind || selection.offset !== positional.offset)) throw new XpPointsUserError('位置参数与周期选项不能指定不同周期。')
    selection = positional
  }
  if (tokens[0]?.startsWith('前')) {
    const previous = tokens.shift()!.match(/^前([1-9]\d*)期$/u)
    if (!selection || selection.kind === 'total' || !previous || selection.offset) throw new XpPointsUserError('请使用“周 前2期”等格式。')
    const offset = Number(previous[1])
    if (!Number.isSafeInteger(offset) || offset > MAX_PREVIOUS_PERIODS) throw new XpPointsUserError(`最多查询前${MAX_PREVIOUS_PERIODS}期。`)
    selection.offset = offset
  }
  const pageToken = tokens.shift()
  const page = pageToken === undefined ? 1 : /^\d+$/u.test(pageToken) ? Number(pageToken) : NaN
  if (tokens.length || !Number.isSafeInteger(page) || page < 1) throw new XpPointsUserError('请在周期后填写一个正整数页码，例如“上周 2”。')
  if (selection) { parsed.period = selection.kind; parsed.offset = selection.offset }
  if (parsed.offset && (parsed.date || parsed.season)) throw new XpPointsUserError('相对周期不能与日期或赛季编号同时使用。')
  if ((parsed.date || parsed.season) && (!selection || selection.kind === 'total')) throw new XpPointsUserError('查询历史日期或赛季编号时，请同时指定周期。')
  return { page, options: parsed }
}
