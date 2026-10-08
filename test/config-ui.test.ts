import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { Config } from '../src/plugin'
import { assertGroups, fields, semanticSchema } from './config-contract'

const before = JSON.parse(readFileSync(new URL('./fixtures/config-before-ui.json', import.meta.url), 'utf8'))

const currentDefaults = {
  scoreGuildAliasDefaults: { balance: 'maximum', period: 'maximum' },
}

function expectedDefaults() {
  return { ...before.defaults, ...currentDefaults }
}

function expectedSchema() {
  const schema = structuredClone(before.schema)
  schema.dict.scoreGuildAliasDefaults = {
    type: 'object',
    meta: { default: { balance: 'maximum', period: 'maximum' } },
    dict: {
      balance: { type: 'union', meta: { default: 'maximum' }, list: [
        { type: 'const', meta: { required: true }, value: 'maximum' },
        { type: 'const', meta: { required: true }, value: 'sum' },
      ] },
      period: { type: 'union', meta: { default: 'maximum' }, list: [
        { type: 'const', meta: { required: true }, value: 'maximum' },
        { type: 'const', meta: { required: true }, value: 'sum' },
      ] },
    },
  }
  return schema
}

it('preserves every configuration key, type, default, constraint and enum value', () => {
  assert.deepEqual(semanticSchema(Config), expectedSchema())
  assert.deepEqual(Config({}), expectedDefaults())
  assert.deepEqual(Config(), expectedDefaults())
  // Object and intersect simplify an empty configuration to null and {}.
  // Verify both old and new serializations against the untouched baseline.
  assert.deepEqual(Config(before.emptySimplified), expectedDefaults())
  assert.deepEqual(Config(Config.simplify(Config({}))), expectedDefaults())
})

it('preserves independent defaults, period definitions, bindings and aliases', () => {
  const input = { accountDefaults: { mode: 'independent', combineStrategy: 'sum' },
    scoreSystems: [{ key: 'neutral', name: '积分', unit: '点', scope: 'platform' }],
    scoreCommandBindings: [{ systemKey: 'neutral', query: ['积分查询'], leaderboard: [], setSelf: [], addSelf: [], setTarget: [], addTarget: [] }],
    scoreGuildAliases: { neutral: { test: { source: 'target' } } },
    scorePeriods: { neutral: { timeZone: 'UTC', season: { unit: 'day', length: 3, start: '2024-02-29' } } },
    requiredDeletionConsumers: [], leaderboardInactivePolicy: 'show', leaderboardPageSize: 10,
    leaderboardEntriesPerLine: 1, memberScanPreviewLimit: 10,
    nicknameConsumers: { chatluna: { enabled: true, guilds: [], includePrivate: false },
      chatlunaCharacter: { enabled: false, guilds: ['test-guild'], includePrivate: true } } }
  assert.deepEqual(Config(structuredClone(input)), { ...expectedDefaults(), ...input })
  assert.deepEqual(Config(Config.simplify(Config(structuredClone(input)))), { ...expectedDefaults(), ...input })
})

it('organizes creation, default scoring, display, integration and maintenance separately', () => {
  assertGroups(Config, ['预置积分系统', '账号默认与合分', '排行榜显示', '周期与赛季', '业务快捷指令', '昵称适配', '群挂靠默认策略', '群积分池挂靠（高级）', '维护与删除安全'])
  const all = fields(Config)
  assert.equal(all.accountDefaults.meta.description, undefined, 'no prose as a category title')
  assert.equal(all.nicknameConsumers.dict.chatluna.meta.description, 'ChatLuna')
  assert.equal(all.nicknameConsumers.dict.chatlunaCharacter.meta.description, 'ChatLuna Character')
  for (const key of ['scoreCommandBindings', 'scoreGuildAliases']) assert.equal(all[key].meta.collapse, true)
  assert.match(all.scoreSystems.meta.description, /首次创建/)
  assert.match(all.scoreSystems.meta.description, /积分系统/)
  assert.match(all.scoreGuildAliases.meta.description, /预览确认/)
})

it('labels scoring, merge, scope and season choices with Chinese explanations', () => {
  const all = fields(Config)
  assert.deepEqual(all.accountDefaults.dict.mode.list.map((item: any) => [item.value, item.meta.description]),
    [['shared', '共享积分'], ['independent', '账号分别计分']])
  assert.deepEqual(all.accountDefaults.dict.combineStrategy.list.map((item: any) => [item.value, item.meta.description]),
    [['maximum', '取最高'], ['sum', '累加（管理员）']])
  for (const item of all.scoreSystems.inner.dict.scope.list) assert.match(item.meta.description, /[\u4e00-\u9fff]/)
  const season = all.scorePeriods.inner.dict.season.dict
  assert.deepEqual(season.unit.list.map((item: any) => [item.value, item.meta.description]), [['month', '自然月'], ['day', '天']])
  assert.match(season.length.meta.description, /N.*天.*自然月/)
})
