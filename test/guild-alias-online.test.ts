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

async function createApp(config = structuredClone(baseConfig)) {
  const app = new App({ autoAssign: true, autoAuthorize: 1 })
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(xpPointsPlugin, config)
  await app.start()
  await app.database.createUser('onebot', 'admin', { authority: 5 })
  apps.push(app)
  return app
}

afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

describe('online guild alias remap', () => {
  it('keeps independent accounts and other people separate while merging signed source balances', async () => {
    const config = structuredClone(baseConfig)
    config.scoreGuildAliases = { event: { onebot: {} } }
    const app = await createApp(config)
    const main = await app.xpPoints.ensureManagedIdentity('onebot', 'main', 'Main')
    const alt = await app.xpPoints.ensureManagedIdentity('onebot', 'alt', 'Alternate')
    const other = await app.xpPoints.ensureManagedIdentity('onebot', 'other', 'Other')
    const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private', isDirect: true }
    const relation = await app.xpPoints.accountOperations.previewAssociation(actor, {
      kind: 'merge-persons', sourceProfileId: alt.profileId, targetProfileId: main.profileId,
      systems: [{ systemKey: 'event', mode: 'independent', strategy: 'maximum' }],
    })
    await app.xpPoints.accountOperations.confirm(actor, relation.token)
    const context = { platform: 'onebot', source: 'fixture', reason: 'signed score' }
    for (const [account, values] of [[main, [4, -2]], [alt, [7, -1]], [other, [9, 3]]] as const) {
      for (const [index, guildId] of ['a', 'b'].entries()) {
        await app.xpPoints.addAccountScore('event', { accountId: account.accountId }, values[index], { ...context, guildId })
      }
    }
    app.xpPoints.config.scoreGuildAliases = { event: { onebot: { a: 'pool', b: 'pool' } } }
    const preview = await app.xpPoints.previewGuildAliasRemap(actor, { balanceStrategy: 'sum', periodStrategy: 'sum' })
    await app.xpPoints.confirmGuildAliasRemap(preview.token, actor)
    for (const [account, expected] of [[main, 2], [alt, 6], [other, 12]] as const) {
      assert.equal(await app.xpPoints.getAccountScore('event', { accountId: account.accountId }, { ...context, guildId: 'pool' }), expected)
    }
    const rewards = await app.database.get('xp_period_journal', {})
    assert.equal(rewards.length, 6, 'remapping is not a competitive reward')
    const periods = await app.database.get('xp_period_definition', {})
    for (const period of periods) {
      assert.deepEqual((await app.database.get('xp_period_score', { periodId: period.id })).map(row => row.value).sort((a, b) => a - b), [2, 6, 12])
    }
  })

  it('rejects invalid systems, non-guild systems and chained mappings without writes', async () => {
    const app = await createApp()
    await app.xpPoints.createScoreSystem({ key: 'global', name: 'Global', scope: 'global', unit: '分' }, 'admin')
    const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private' }
    const before = await app.database.get('xp_score_guild_alias', {})
    for (const config of [
      { missing: { onebot: { a: 'pool' } } },
      { global: { onebot: { a: 'pool' } } },
      { event: { onebot: { a: 'b', b: 'pool' } } },
    ]) {
      app.xpPoints.config.scoreGuildAliases = config
      await assert.rejects(app.xpPoints.previewGuildAliasRemap(actor), /不存在|群|链式|循环/)
      assert.deepEqual(await app.database.get('xp_score_guild_alias', {}), before)
    }
  })

  it('binds confirmation to the administrator, bot and session and rejects a changed balance', async () => {
    const app = await createApp()
    const person = await app.xpPoints.ensureManagedIdentity('onebot', 'person', 'Person')
    const context = { platform: 'onebot', guildId: 'source', source: 'fixture', reason: 'seed' }
    await app.xpPoints.addAccountScore('event', { accountId: person.accountId }, 4, context)
    app.xpPoints.config.scoreGuildAliases = { event: { onebot: { source: 'new' } } }
    const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private' }
    const preview = await app.xpPoints.previewGuildAliasRemap(actor)
    for (const changed of [{ userId: 'other' }, { selfId: 'other-bot' }, { channelId: 'other-session' }]) {
      await assert.rejects(app.xpPoints.confirmGuildAliasRemap(preview.token, { ...actor, ...changed }), /不属于/)
    }
    await app.xpPoints.addAccountScore('event', { accountId: person.accountId }, 1, context)
    await assert.rejects(app.xpPoints.confirmGuildAliasRemap(preview.token, actor), /已经变化/)
    assert.equal(await app.xpPoints.resolveScoreGuild('event', 'onebot', 'source'), 'pool-a')
    const fresh = await app.xpPoints.previewGuildAliasRemap(actor)
    await app.xpPoints.confirmGuildAliasRemap(fresh.token, actor)
    assert.equal(await app.xpPoints.getAccountScore('event', { accountId: person.accountId }, context), 5)
  })

  it('rolls back balances, components, journals and aliases when a remap write fails', async () => {
    const app = await createApp()
    const person = await app.xpPoints.ensureManagedIdentity('onebot', 'person', 'Person')
    await app.xpPoints.addAccountScore('event', { accountId: person.accountId }, 4, {
      platform: 'onebot', guildId: 'source', source: 'fixture', reason: 'seed',
    })
    app.xpPoints.config.scoreGuildAliases = { event: { onebot: { source: 'new' } } }
    const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private' }
    const preview = await app.xpPoints.previewGuildAliasRemap(actor)
    const tables = ['xp_subject_balance', 'xp_score_guild_component', 'xp_period_score',
      'xp_period_guild_component', 'xp_score_journal', 'xp_score_guild_alias'] as const
    const before = await Promise.all(tables.map(table => app.database.get(table, {})))
    const original = app.database.transact.bind(app.database)
    app.database.transact = ((callback: any) => original(db => callback(new Proxy(db, {
      get(target, key) {
        if (key === 'create') return (table: string, row: any) => {
          if (table === 'xp_score_journal') throw new Error('injected remap failure')
          return (target.create as any)(table, row)
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })))) as any
    try {
      await assert.rejects(app.xpPoints.confirmGuildAliasRemap(preview.token, actor), /injected remap failure/)
    } finally {
      app.database.transact = original
    }
    assert.deepEqual(await Promise.all(tables.map(table => app.database.get(table, {}))), before)
    assert.equal(await app.xpPoints.resolveScoreGuild('event', 'onebot', 'source'), 'pool-a')
    await app.xpPoints.confirmGuildAliasRemap(preview.token, actor)
    assert.equal(await app.xpPoints.resolveScoreGuild('event', 'onebot', 'source'), 'new')
  })

  it('uses the configured common timezone and preserves previous periods after a timezone change', async () => {
    const config = { ...structuredClone(baseConfig), scorePeriods: { event: { timeZone: 'Europe/London' } } }
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' })
    const fork = app.plugin(xpPointsPlugin, config)
    await app.start()
    apps.push(app)
    const at = Date.now()
    const first = await app.xpPoints.getPeriodDefinition('event', { kind: 'day', at })
    assert.equal(first!.timeZone, 'Europe/London')
    const formatted = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    assert.equal(formatted.format(new Date(first!.start)), '00:00')
    const currentSeason = await app.xpPoints.getPeriodDefinition('event', { kind: 'season', at })
    await fork.dispose()
    app.plugin(xpPointsPlugin, { ...config, scorePeriods: { event: { timeZone: 'America/New_York' } } })
    assert.deepEqual(await app.xpPoints.getPeriodDefinition('event', { kind: 'day', at }), first)
    const policy = (await app.database.get('xp_period_policy', { systemKey: 'event' }))[0]
    const revisions = JSON.parse(policy.revisions)
    assert.equal(revisions.at(-1).effectiveAt, currentSeason!.end)
    assert.equal(revisions.at(-1).config.timeZone, 'America/New_York')
    const { resolvePeriodIn } = await import('../src/period-ledger')
    const next = await app.database.transact(db => resolvePeriodIn(db, 'event', 'day', currentSeason!.end + 1))
    assert.equal(next!.timeZone, 'America/New_York')
  })

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
