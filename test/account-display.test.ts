import assert from 'node:assert/strict'
import { it } from 'node:test'
import { accountScoreName, formatSubjectLeaderboard } from '../src/account-display'
import type { SubjectScoreEntry } from '../src/subject-ledger'

function entry(accountId: string | null, value: number, extra: Partial<SubjectScoreEntry> = {}): SubjectScoreEntry {
  return { profileId: 1, subjectId: accountId ?? 'shared', accountId, nickname: '明月',
    accountNickname: accountId === 'main' ? '明月' : '青山', accountNicknameStatus: 'managed',
    primaryAccountId: 'main', label: accountId === 'main' ? '主账号' : '小账号', value, identities: [], ...extra }
}
it('shared score shows person name, independent score preserves account name and relationship', () => {
  assert.equal(accountScoreName(entry(null, 20)), '明月')
  assert.equal(accountScoreName(entry('alt', 12)), '青山（明月的小号）')
  assert.equal(accountScoreName(entry('main', 20)), '明月')
  assert.equal(accountScoreName(entry('main', 20, { accountNickname: '清风', accountNicknameStatus: 'unknown' })), '清风')
  assert.equal(accountScoreName(entry('alt', 12, { primaryAccountId: null })), '青山（同属明月）')
  assert.equal(accountScoreName(entry('alt', 12, { accountNickname: '明月', accountNicknameStatus: 'unknown' })), '明月〔小账号〕（昵称待整理）')
})
it('globally sorts independent accounts by points, retaining three entries per line by default', () => {
  const input = [entry('alt', 12), entry('main', 20), entry('other', 15, { profileId: 2, nickname: '远山', accountNickname: '远山', primaryAccountId: 'other' }), entry('last', 1)]
  const before = structuredClone(input)
  const lines = formatSubjectLeaderboard(input, '分')
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0].split('；').map(row => row.match(/ (\d+)分$/)![1]), ['20', '15', '12'])
  assert.match(lines[1], / 1分$/)
  assert.equal(formatSubjectLeaderboard(input, '分', 1).length, 4)
  assert.equal(formatSubjectLeaderboard([entry('main', 20, { nickname: '清风', accountNickname: '清风' }),
    entry('alt', 10, { nickname: '清风', accountNickname: '明月' })], '分')[0], '清风 20分；明月（清风的小号） 10分')
  assert.deepEqual(input, before)
  assert.throws(() => formatSubjectLeaderboard(input, '分', 0), /条目数/)
  assert.throws(() => formatSubjectLeaderboard([entry('bad', NaN)], '分'), /积分无效/)
})
