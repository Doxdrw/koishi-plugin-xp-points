import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import * as xpPointsPlugin from '../src/plugin'

const apps: App[] = []
const baseConfig = {
  scoreSystems: [{ key: 'event', name: '活动', unit: '分', scope: 'guild' as const }],
  scoreCommandBindings: [],
  scoreGuildAliases: { event: { onebot: { source: 'pool-a' } } },
  nicknameConsumers: {
    chatluna: { enabled: false, guilds: [], includePrivate: false },
    chatlunaCharacter: { enabled: false, guilds: [], includePrivate: false },
  },
}

async function createApp() {
  const app = new App({ autoAssign: true, autoAuthorize: 1 })
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(xpPointsPlugin, baseConfig)
  await app.start()
  await app.database.createUser('onebot', 'admin', { authority: 5 })
  apps.push(app)
  return app
}

afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

describe('online guild alias remap', () => {
  it('previews and confirms a sum remap atomically, preserving source components', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', 'alice', 'Alice')
    const bob = await app.xpPoints.ensureManagedIdentity('onebot', 'bob', 'Bob')
    const context = { platform: 'onebot', guildId: 'source', source: 'fixture', reason: 'seed' }
    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 4, context)
    await app.xpPoints.addAccountScore('event', { accountId: bob.accountId }, 7, context)
    ;(app.xpPoints.config.scoreGuildAliases as any).event.onebot.source = 'pool-b'
    const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private' }
    const preview = await app.xpPoints.previewGuildAliasRemap(actor, { balanceStrategy: 'sum', periodStrategy: 'maximum' })
    assert.equal(preview.changes.length, 1)
    assert.equal(preview.balancePlans.length, 2)
    assert.ok(preview.token.startsWith('XPALIAS-'))
    const result = await app.xpPoints.confirmGuildAliasRemap(preview.token, actor)
    assert.equal(result.executed, true)
    assert.equal(await app.xpPoints.getAccountScore('event', { accountId: alice.accountId }, { platform: 'onebot', guildId: 'source' }), 4)
    const components = await app.database.get('xp_score_guild_component', {})
    assert.equal(components.length, 2)
    assert.deepEqual(components.map(row => row.value).sort((a, b) => a - b), [4, 7])
    await assert.rejects(() => app.xpPoints.confirmGuildAliasRemap(preview.token, actor), /不存在或已经使用/)
  })

  it('keeps the applied mapping when configuration differs and service can still write scores', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', 'alice', 'Alice')
    ;(app.xpPoints.config.scoreGuildAliases as any).event.onebot.source = 'pool-c'
    const status = await app.xpPoints.getGuildAliasRemapStatus()
    assert.equal(status.pending, true)
    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 2, { platform: 'onebot', guildId: 'source', source: 'fixture', reason: 'pending write' })
    assert.equal(await app.xpPoints.resolveScoreGuild('event', 'onebot', 'source'), 'pool-a')
  })

  it('splits a previously shared target using source components without duplicating balances', async () => {
    const config = structuredClone(baseConfig)
    config.scoreGuildAliases = { event: { onebot: { a: 'pool', b: 'pool' } } }
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' })
    app.plugin(xpPointsPlugin, config)
    await app.start(); apps.push(app)
    await app.database.createUser('onebot', 'admin', { authority: 5 })
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', 'alice', 'Alice')
    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 6, { platform: 'onebot', guildId: 'a', source: 'fixture', reason: 'a' })
    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 4, { platform: 'onebot', guildId: 'b', source: 'fixture', reason: 'b' })
    ;(app.xpPoints.config.scoreGuildAliases as any).event.onebot.a = 'new'
    const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private' }
    const preview = await app.xpPoints.previewGuildAliasRemap(actor, { balanceStrategy: 'maximum', periodStrategy: 'maximum' })
    await app.xpPoints.confirmGuildAliasRemap(preview.token, actor)
    assert.equal(await app.xpPoints.getAccountScore('event', { accountId: alice.accountId }, { platform: 'onebot', guildId: 'a' }), 6)
    assert.equal(await app.xpPoints.getAccountScore('event', { accountId: alice.accountId }, { platform: 'onebot', guildId: 'b' }), 4)
    assert.deepEqual((await app.database.get('xp_subject_balance', {})).map(row => [row.guildId, row.value]).sort(), [['new', 6], ['pool', 4]])
  })

  it('applies sum to one shared target and preserves each source when the target is split', async () => {
    const config = structuredClone(baseConfig)
    config.scoreGuildAliases = { event: { onebot: { a: 'pool', b: 'pool' } } }
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' })
    app.plugin(xpPointsPlugin, config)
    await app.start(); apps.push(app)
    await app.database.createUser('onebot', 'admin', { authority: 5 })
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', 'alice', 'Alice')
    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 4, { platform: 'onebot', guildId: 'a', source: 'fixture', reason: 'a' })
    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 7, { platform: 'onebot', guildId: 'b', source: 'fixture', reason: 'b' })

    const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private' }
    const strategyPreview = await app.xpPoints.previewGuildAliasRemap(actor, { balanceStrategy: 'sum', periodStrategy: 'maximum' })
    await app.xpPoints.confirmGuildAliasRemap(strategyPreview.token, actor)
    assert.deepEqual((await app.database.get('xp_subject_balance', {})).map(row => [row.guildId, row.value]), [['pool', 11]])

    ;(app.xpPoints.config.scoreGuildAliases as any).event.onebot.a = 'new'
    const splitPreview = await app.xpPoints.previewGuildAliasRemap(actor, { balanceStrategy: 'sum', periodStrategy: 'maximum' })
    await app.xpPoints.confirmGuildAliasRemap(splitPreview.token, actor)
    assert.deepEqual((await app.database.get('xp_subject_balance', {})).map(row => [row.guildId, row.value]).sort(), [['new', 4], ['pool', 7]])

    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 2, { platform: 'onebot', guildId: 'a', source: 'fixture', reason: 'after split' })
    assert.deepEqual((await app.database.get('xp_subject_balance', {})).map(row => [row.guildId, row.value]).sort(), [['new', 6], ['pool', 7]])
  })

  it('rebases a period strategy change without repeating an existing shared-pool adjustment', async () => {
    const config = structuredClone(baseConfig)
    config.scorePeriods = { event: {} }
    config.scoreGuildAliases = { event: { onebot: { a: 'pool', b: 'pool' } } }
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' })
    app.plugin(xpPointsPlugin, config)
    await app.start(); apps.push(app)
    await app.database.createUser('onebot', 'admin', { authority: 5 })
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', 'alice', 'Alice')
    const effectiveAt = Date.parse('2026-10-01T12:00:00+08:00')
    const common = { platform: 'onebot', source: 'fixture', reason: 'period seed', effectiveAt, businessId: 'period-seed' }
    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 4, { ...common, guildId: 'a', idempotencyKey: 'a' })
    await app.xpPoints.addAccountScore('event', { accountId: alice.accountId }, 7, { ...common, guildId: 'b', idempotencyKey: 'b' })
    const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private' }
    const preview = await app.xpPoints.previewGuildAliasRemap(actor, { balanceStrategy: 'maximum', periodStrategy: 'sum' })
    await app.xpPoints.confirmGuildAliasRemap(preview.token, actor)
    assert.ok((await app.database.get('xp_period_score', {})).every(row => row.guildId === 'pool' && row.value === 11))
  })
})
