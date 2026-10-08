import { XpPointsUserError } from './errors'
import type { SubjectScoreEntry } from './subject-ledger'

/** Plain display data only; callers must use text elements when sending to Koishi. */
export function accountScoreName(entry: SubjectScoreEntry): string {
  if (entry.accountId === null) return entry.nickname
  const own = entry.accountNickname || entry.nickname
  if (entry.primaryAccountId === entry.accountId) return own
  const label = entry.label ? `〔${entry.label}〕` : ''
  if (entry.accountNicknameStatus === 'unknown') return `${own}${label}（昵称待整理）`
  const relation = entry.primaryAccountId ? `${entry.nickname}的小号` : `同属${entry.nickname}`
  // Labels disambiguate people whose administrator deliberately retained equal names.
  return `${own}${own === entry.nickname ? label : ''}（${relation}）`
}

/** Global ranking; group-by-person is for relationship views, never leaderboards. */
export function formatSubjectLeaderboard(entries: readonly SubjectScoreEntry[], unit: string, entriesPerLine = 3): string[] {
  if (!Number.isInteger(entriesPerLine) || entriesPerLine < 1 || entriesPerLine > 5) throw new XpPointsUserError('每行条目数必须为 1 至 5。')
  if (entries.some(row => !Number.isFinite(row.value))) throw new XpPointsUserError('排行榜积分无效。')
  const ordered = [...entries].sort((a, b) => b.value - a.value
    || (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0))
  const lines: string[] = []
  for (let index = 0; index < ordered.length; index += entriesPerLine) {
    lines.push(ordered.slice(index, index + entriesPerLine).map(row => `${accountScoreName(row)} ${row.value}${unit}`).join('；'))
  }
  return lines
}
