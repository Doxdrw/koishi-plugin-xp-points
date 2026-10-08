import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeScoreCommandBindings } from '../src/score-command-bindings'

describe('configurable score command bindings', () => {
  it('binds neutral fixed actions without assigning business semantics in code', () => {
    assert.deepEqual(normalizeScoreCommandBindings([{
      systemKey: 'event',
      query: ['活动积分'],
      leaderboard: ['活动榜'],
      setSelf: [],
      addSelf: [],
      setTarget: ['设置活动积分'],
      addTarget: ['增加活动积分'],
    }]), [
      { systemKey: 'event', action: 'query', command: '活动积分' },
      { systemKey: 'event', action: 'leaderboard', command: '活动榜' },
      { systemKey: 'event', action: 'setTarget', command: '设置活动积分' },
      { systemKey: 'event', action: 'addTarget', command: '增加活动积分' },
    ])
  })

  it('rejects reserved, duplicate, dotted, and cross-system aliases', () => {
    const empty = { query: [], leaderboard: [], setSelf: [], addSelf: [], setTarget: [], addTarget: [] }
    assert.throws(() => normalizeScoreCommandBindings([{
      ...empty, systemKey: 'event', query: ['积分'],
    }], ['积分']), /核心指令冲突/)
    assert.throws(() => normalizeScoreCommandBindings([{
      ...empty, systemKey: 'event', query: ['活动.积分'],
    }]), /不含空白和点号/)
    for (const command of ['外部/命令', '查询<参数>', '查询[参数]']) {
      assert.throws(() => normalizeScoreCommandBindings([{ ...empty, systemKey: 'event', query: [command] }]), /命令名/)
    }
    assert.throws(() => normalizeScoreCommandBindings([
      { ...empty, systemKey: 'event', query: ['活动分'] },
      { ...empty, systemKey: 'season', leaderboard: ['活动分'] },
    ]), /同时绑定/)
    assert.throws(() => normalizeScoreCommandBindings([
      { ...empty, systemKey: 'event' },
      { ...empty, systemKey: 'EVENT' },
    ]), /重复配置/)
  })
})
