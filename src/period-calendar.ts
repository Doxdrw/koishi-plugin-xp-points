export type ScorePeriodKind = 'day' | 'week' | 'month' | 'year' | 'season'
export interface ScorePeriodConfig {
  timeZone?: string
  season?: { unit: 'month' | 'day'; length: number; start: string }
}
export interface PeriodWindow { kind: ScorePeriodKind; start: number; end: number; label: string }
interface CalendarDate { year: number; month: number; day: number }
const DAY = 86400000
const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(zone: string) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }))
  return formatters.get(zone)!
}
function localParts(instant: number, zone: string) {
  const parts = Object.fromEntries(formatter(zone).formatToParts(instant).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second }
}
const utc = (d: CalendarDate) => Date.UTC(d.year, d.month - 1, d.day)
const fromUtc = (n: number): CalendarDate => { const d = new Date(n); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } }
const addDays = (d: CalendarDate, days: number) => fromUtc(utc(d) + days * DAY)
function addMonths(d: CalendarDate, months: number): CalendarDate {
  const first = fromUtc(Date.UTC(d.year, d.month - 1 + months, 1))
  const last = new Date(Date.UTC(first.year, first.month, 0)).getUTCDate()
  return { ...first, day: Math.min(d.day, last) }
}
function dateString(d: CalendarDate) { return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` }
export function parsePeriodDate(value: string): CalendarDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('赛季起点必须为 YYYY-MM-DD。')
  const [year, month, day] = value.split('-').map(Number)
  const d = { year, month, day }
  if (year < 1970 || year > 9998 || dateString(fromUtc(utc(d))) !== value) throw new Error('赛季起点日期不存在或超出范围。')
  return d
}
export function normalizePeriodConfig(config: ScorePeriodConfig = {}): Required<ScorePeriodConfig> {
  const timeZone = config.timeZone?.trim() || 'Asia/Shanghai'
  try { formatter(timeZone) } catch { throw new Error('周期榜时区无效，请使用 IANA 时区名称。') }
  const season = config.season ?? { unit: 'month', length: 1, start: '1970-01-01' }
  if (!['month', 'day'].includes(season.unit) || !Number.isSafeInteger(season.length) || season.length < 1 || season.length > 3660)
    throw new Error('赛季长度须为1至3660个自然月或当地日。')
  parsePeriodDate(season.start)
  return { timeZone, season: { ...season } }
}

/** Calendar midnight: choose earlier occurrence on a fold, next valid wall time
 * on a gap. Offsets are sampled around the date, not read from the host timezone. */
export function zonedDayStart(value: string | CalendarDate, timeZone = 'Asia/Shanghai'): number {
  const d = typeof value === 'string' ? parsePeriodDate(value) : value
  const wall = utc(d), offsets = new Set<number>()
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = wall + hours * 3600000, p = localParts(sample, timeZone)
    offsets.add(utc(p) + p.hour * 3600000 + p.minute * 60000 + p.second * 1000 - sample)
  }
  const candidates = [...offsets].map(offset => wall - offset).map(instant => {
    const p = localParts(instant, timeZone)
    return { instant, wall: utc(p) + p.hour * 3600000 + p.minute * 60000 + p.second * 1000 }
  })
  const exact = candidates.filter(c => c.wall === wall).sort((a, b) => a.instant - b.instant)
  if (exact.length) return exact[0].instant
  const next = candidates.filter(c => c.wall > wall).sort((a,b) => a.wall - b.wall || a.instant - b.instant)[0]
  if (!next) throw new Error('无法解析该时区的周期边界。')
  return next.instant
}

export function scorePeriodWindow(kind: ScorePeriodKind, instant: number, input: ScorePeriodConfig = {}): PeriodWindow | null {
  if (!Number.isFinite(instant) || !['day', 'week', 'month', 'year', 'season'].includes(kind)) throw new Error('周期类型或成绩时间无效。')
  const config = normalizePeriodConfig(input), date = localParts(instant, config.timeZone)
  if (date.year < 1970 || date.year > 9998) throw new Error('成绩时间超出支持范围。')
  let start: CalendarDate, end: CalendarDate, label: string
  if (kind === 'day') { start = date; end = addDays(start, 1); label = dateString(start) }
  else if (kind === 'week') {
    const day = new Date(utc(date)).getUTCDay()
    start = addDays(date, -((day + 6) % 7)); end = addDays(start, 7); label = dateString(start)
  } else if (kind === 'month') {
    start = { ...date, day: 1 }; end = addMonths(start, 1); label = dateString(start).slice(0, 7)
  } else if (kind === 'year') {
    start = { year: date.year, month: 1, day: 1 }; end = { ...start, year: start.year + 1 }; label = String(start.year)
  } else {
    const anchor = parsePeriodDate(config.season.start), length = config.season.length
    if (instant < zonedDayStart(anchor, config.timeZone)) return null
    let index = config.season.unit === 'day' ? Math.floor((utc(date) - utc(anchor)) / DAY / length)
      : Math.floor(((date.year - anchor.year) * 12 + date.month - anchor.month) / length)
    const at = (i: number) => config.season.unit === 'day' ? addDays(anchor, i * length) : addMonths(anchor, i * length)
    while (index > 0 && zonedDayStart(at(index), config.timeZone) > instant) index--
    while (zonedDayStart(at(index + 1), config.timeZone) <= instant) index++
    start = at(index); end = at(index + 1)
    label = config.season.unit === 'month' && length === 1 && anchor.day === 1 ? dateString(start).slice(0, 7) : `S${index + 1}`
  }
  const result = { kind, start: zonedDayStart(start, config.timeZone), end: zonedDayStart(end, config.timeZone), label }
  if (!(result.start <= instant && instant < result.end)) throw new Error('周期边界未涵盖指定成绩时间。')
  return result
}
