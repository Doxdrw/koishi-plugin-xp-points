import { maintainFixtureIdentity } from './managed-account-fixture'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { App } from 'koishi'
import * as xpPointsPlugin from '../src/plugin'

const apps: App[] = []

async function createApp(scoreGuildAliases: Record<string, Record<string, Record<string, string>>> = {}): Promise<App> {
  const app = new App({ autoAssign: true, autoAuthorize: 1 })
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(xpPointsPlugin, {
    scoreSystems: [{ key: 'primary', name: '测试积分', unit: '分', scope: 'guild' }],
    scoreCommandBindings: [],
    scoreGuildAliases,
    leaderboardInactivePolicy: 'hide',
    requiredDeletionConsumers: [],
    nicknameConsumers: {
      chatluna: { enabled: false, guilds: [], includePrivate: false },
      chatlunaCharacter: { enabled: false, guilds: [], includePrivate: false },
    },
  })
  await app.start()
  apps.push(app)
  return app
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.stop()
})

describe('generic multi-score ledger', () => {
  it('rolls back non-finite additions, set deltas and driver results without audit changes', async () => {
    const app = await createApp()
    const { accountId } = await app.xpPoints.ensureManagedIdentity('test', 'overflow', 'Example')
    const context = { source: 'test', reason: 'finite', platform: 'test', guildId: 'g' }
    await app.xpPoints.setAccountScore('primary', { accountId }, Number.MAX_VALUE, context)
    await assert.rejects(() => app.xpPoints.addAccountScore('primary', { accountId }, Number.MAX_VALUE, context), /有限数值/)
    await assert.rejects(() => app.xpPoints.setAccountScore('primary', { accountId }, -Number.MAX_VALUE, context), /有限数值/)
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId }, context), Number.MAX_VALUE)
    assert.equal((await app.database.get('xp_score_journal', {})).length, 1)
    await app.xpPoints.setAccountScore('primary', { accountId }, 1, context)
    const original = app.database.upsert.bind(app.database)
    app.database.upsert = (async (table: string, rows: any, ...rest: any[]) => {
      const result = await (original as any)(table, rows, ...rest)
      if (table === 'xp_subject_balance') {
        await app.database.set('xp_subject_balance', {}, { value: Infinity })
      }
      return result
    }) as typeof app.database.upsert
    try {
      await assert.rejects(() => app.xpPoints.addAccountScore('primary', { accountId }, 1, context), /有限数值/)
    } finally { app.database.upsert = original }
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId }, context), 1)
    assert.equal((await app.database.get('xp_score_journal', {})).length, 2)
  })

  it('rolls back an entire profile merge when a maximum-merge audit delta overflows', async () => {
    const app = await createApp()
    const source = await app.xpPoints.ensureManagedIdentity('test', 'source', 'Source')
    const target = await app.xpPoints.ensureManagedIdentity('test', 'target', 'Target')
    const context = { source: 'test', reason: 'finite', platform: 'test', guildId: 'g' }
    await app.xpPoints.setAccountScore('primary', { accountId: source.accountId }, Number.MAX_VALUE, context)
    await app.xpPoints.setAccountScore('primary', { accountId: target.accountId }, -Number.MAX_VALUE, context)
    const tables = ['xp_profile', 'xp_identity', 'xp_score_subject', 'xp_subject_balance', 'xp_score_journal', 'xp_profile_merge'] as const
    const before = await Promise.all(tables.map(table => app.database.get(table, {})))
    await assert.rejects(() => maintainFixtureIdentity(app, 'test', 'source', 'Target'), /有限数值/)
    assert.deepEqual(await Promise.all(tables.map(table => app.database.get(table, {}))), before)
    assert.equal(app.xpPoints.resolveNickname('test', 'source'), 'Source')
  })

  it('deduplicates original decimal operands without subtracting rounded balances', async () => {
    const app = await createApp()
    const { accountId } = await app.xpPoints.ensureManagedIdentity('test', 'decimal', 'Example')
    const context = { source: 'test', reason: 'decimal', platform: 'test', guildId: 'g' }
    await app.xpPoints.setAccountScore('primary', { accountId }, 0.1, context)
    const request = { ...context, idempotencyKey: 'decimal-add' }
    const first = await app.xpPoints.addAccountScore('primary', { accountId }, 0.2, request)
    assert.equal(first.after, 0.1 + 0.2)
    assert.notEqual(first.delta, 0.2)
    assert.deepEqual(await app.xpPoints.addAccountScore('primary', { accountId }, 0.2, request), {
      ...first, deduplicated: true,
    })
    await assert.rejects(() => app.xpPoints.addAccountScore('primary', { accountId }, first.delta, request), /幂等键/)
    const journal = (await app.database.get('xp_score_journal', { id: first.journalId }))[0]
    assert.equal(journal.operand, 0.2)
    // Old rows retain no original input: exact replay, never epsilon matching.
    await app.database.set('xp_score_journal', { id: first.journalId }, { operand: null })
    assert.equal((await app.xpPoints.addAccountScore('primary', { accountId }, 0.2, request)).deduplicated, true)
    await assert.rejects(() => app.xpPoints.addAccountScore('primary', { accountId }, 0.21, request), /幂等键/)
    assert.equal((await app.database.get('xp_score_journal', {})).length, 2)
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId }, context), first.after)
  })

  it('isolates global, platform, and guild score pools', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    await app.xpPoints.createScoreSystem({ key: 'global-test', name: '全局分', scope: 'global' }, 'test')
    await app.xpPoints.createScoreSystem({ key: 'platform-test', name: '平台分', scope: 'platform' }, 'test')
    await app.xpPoints.createScoreSystem({ key: 'guild-test', name: '群分', scope: 'guild' }, 'test')

    await app.xpPoints.addAccountScore('global-test', { accountId: alice.accountId }, 1.5, {
      source: 'test', reason: 'global add', platform: 'onebot', guildId: 'g1',
    })
    assert.equal(await app.xpPoints.getAccountScore('global-test', { accountId: alice.accountId }, { platform: 'discord', guildId: 'g2' }), 1.5)

    await app.xpPoints.addAccountScore('platform-test', { accountId: alice.accountId }, 2, {
      source: 'test', reason: 'onebot add', platform: 'onebot', guildId: 'g1',
    })
    assert.equal(await app.xpPoints.getAccountScore('platform-test', { accountId: alice.accountId }, { platform: 'onebot', guildId: 'g2' }), 2)
    assert.equal(await app.xpPoints.getAccountScore('platform-test', { accountId: alice.accountId }, { platform: 'discord', guildId: 'g1' }), 0)

    await app.xpPoints.addAccountScore('guild-test', { accountId: alice.accountId }, -0.5, {
      source: 'test', reason: 'guild add', platform: 'onebot', guildId: 'g1',
    })
    assert.equal(await app.xpPoints.getAccountScore('guild-test', { accountId: alice.accountId }, { platform: 'onebot', guildId: 'g1' }), -0.5)
    assert.equal(await app.xpPoints.getAccountScore('guild-test', { accountId: alice.accountId }, { platform: 'onebot', guildId: 'g2' }), 0)
  })

  it('shares a system across consumers and deduplicates retries with a journal', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    await app.xpPoints.createScoreSystem({ key: 'shared', name: '共享积分', unit: '星', scope: 'guild' }, 'test')
    const first = app.xpPoints.registerScoreConsumer({ consumer: 'plugin-a', systemKey: 'shared' })
    const second = app.xpPoints.registerScoreConsumer({ consumer: 'plugin-b', systemKey: 'shared' })
    const context = {
      platform: 'onebot', guildId: 'g1', reason: 'round result', idempotencyKey: 'round-1:alice',
    }
    const written = await first.addAccount({ accountId: alice.accountId }, 3, context)
    const retried = await first.addAccount({ accountId: alice.accountId }, 3, context)
    await second.addAccount({ accountId: alice.accountId }, 2, { platform: 'onebot', guildId: 'g1', reason: 'quiz reward' })

    assert.equal(written.deduplicated, false)
    assert.equal(retried.deduplicated, true)
    assert.equal(await second.getAccount({ accountId: alice.accountId }, { platform: 'onebot', guildId: 'g1' }), 5)
    assert.equal((await app.database.get('xp_score_journal', {})).length, 2)

    await assert.rejects(
      () => first.addAccount({ accountId: alice.accountId }, 4, context),
      /幂等键已被其他变更使用/,
    )
    await assert.rejects(
      () => first.addAccount({ accountId: alice.accountId }, 3, { ...context, guildId: 'g2' }),
      /幂等键已被其他变更使用/,
    )
    assert.equal(await first.getAccount({ accountId: alice.accountId }, { platform: 'onebot', guildId: 'g1' }), 5)
    assert.equal(await first.getAccount({ accountId: alice.accountId }, { platform: 'onebot', guildId: 'g2' }), 0)
  })

  it('applies only non-chain guild aliases and leaves populated drift for online confirmation', async () => {
    const app = await createApp({ primary: { onebot: { source: 'shared' } } })
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    await app.xpPoints.addAccountScore('primary', { accountId: alice.accountId }, 4, {
      source: 'test', reason: 'alias add', platform: 'onebot', guildId: 'source',
    })
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId: alice.accountId }, {
      platform: 'onebot', guildId: 'shared',
    }), 4)

    const service = app.xpPoints as any
    service.config.scoreGuildAliases = { primary: { onebot: { source: 'other' } } }
    service.scoreLoaded = false
    await app.xpPoints.requireScoreSystem('primary')
    assert.equal((await app.xpPoints.getGuildAliasRemapStatus()).pending, true)
    assert.equal(await app.xpPoints.resolveScoreGuild('primary', 'onebot', 'source'), 'shared')
  })

  it('merges every system by score-pool maximum', async () => {
    const app = await createApp()
    await app.xpPoints.createScoreSystem({ key: 'second', name: '第二积分', scope: 'global' }, 'test')
    const alice = await maintainFixtureIdentity(app, 'onebot', '1001', 'Alice')
    const bob = await maintainFixtureIdentity(app, 'onebot', '1002', 'Bob')
    await app.xpPoints.setAccountScore('primary', { accountId: alice.accountId }, 4, {
      source: 'test', reason: 'seed', platform: 'onebot', guildId: 'g1',
    })
    await app.xpPoints.setAccountScore('primary', { accountId: bob.accountId }, 9, {
      source: 'test', reason: 'seed', platform: 'onebot', guildId: 'g1',
    })
    await app.xpPoints.setAccountScore('second', { accountId: alice.accountId }, 8, { source: 'test', reason: 'seed' })
    await app.xpPoints.setAccountScore('second', { accountId: bob.accountId }, 3, { source: 'test', reason: 'seed' })

    await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId: alice.accountId }, { platform: 'onebot', guildId: 'g1' }), 9)
    assert.equal(await app.xpPoints.getAccountScore('second', { accountId: alice.accountId }, {}), 8)
    assert.equal((app.model as any).tables.xp_score_balance, undefined)
  })

  it('deduplicates the original mutation after its profile is merged', async () => {
    const app = await createApp()
    const alice = await maintainFixtureIdentity(app, 'onebot', '1001', 'Alice')
    const bob = await maintainFixtureIdentity(app, 'onebot', '1002', 'Bob')
    const context = {
      source: 'test-consumer',
      reason: 'round result',
      idempotencyKey: 'round-7:bob',
      platform: 'onebot',
      guildId: 'g1',
    }
    const first = await app.xpPoints.addAccountScore('primary', { accountId: bob.accountId }, 3, context)

    await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    const retryByOldId = await app.xpPoints.addAccountScore('primary', { accountId: bob.accountId }, 3, context)
    const retryByCanonicalId = await app.xpPoints.addAccountScore('primary', { accountId: alice.accountId }, 3, context)

    assert.equal(retryByOldId.deduplicated, true)
    assert.equal(retryByCanonicalId.deduplicated, true)
    assert.equal(retryByOldId.journalId, first.journalId)
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId: alice.accountId }, {
      platform: 'onebot', guildId: 'g1',
    }), 3)
  })

  it('blocks configured-system deletion and does not recreate a deleted unbound consumer default', async () => {
    const app = await createApp()
    const actor = { platform: 'onebot', userId: 'owner', selfId: 'bot', channelId: 'g1' }
    await app.database.createUser('onebot', 'owner', { authority: 5 })
    await assert.rejects(
      () => app.xpPoints.previewDeleteScoreSystem('primary', actor),
      /scoreSystems 配置/,
    )

    const handle = app.xpPoints.registerScoreConsumer({
      consumer: 'temporary-plugin',
      systemKey: 'temporary',
      defaultSystem: { key: 'temporary', name: '临时积分', scope: 'global' },
    })
    await handle.getSystem()
    handle.dispose()
    const preview = await app.xpPoints.previewDeleteScoreSystem('temporary', actor)
    await app.xpPoints.confirmDeleteScoreSystem(preview.token, actor)

    assert.equal((await app.xpPoints.listScoreSystems()).some(system => system.key === 'temporary'), false)
  })

  it('paginates leaderboards and journals without losing deterministic order', async () => {
    const app = await createApp()
    for (let index = 1; index <= 12; index++) {
      const nickname = `Player ${String(index).padStart(2, '0')}`
      const identity = await app.xpPoints.ensureManagedIdentity('onebot', `user-${index}`, nickname)
      await app.xpPoints.addAccountScore('primary', { accountId: identity.accountId }, index, {
        source: 'pagination-test',
        reason: `seed ${index}`,
        idempotencyKey: `seed-${index}`,
        platform: 'onebot',
        guildId: 'g1',
      })
    }

    const first = await app.xpPoints.getScoreLeaderboardPage('primary', {
      platform: 'onebot', guildId: 'g1',
    }, { page: 1, pageSize: 10 })
    const second = await app.xpPoints.getScoreLeaderboardPage('primary', {
      platform: 'onebot', guildId: 'g1',
    }, { page: 2, pageSize: 10 })
    assert.equal(first.total, 12)
    assert.equal(first.totalPages, 2)
    assert.deepEqual(first.entries.map(entry => entry.value), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    assert.deepEqual(second.entries.map(entry => entry.value), [2, 1])

    const journals = await app.xpPoints.getScoreJournalPage('primary', { page: 2, pageSize: 10 })
    assert.equal(journals.total, 12)
    assert.deepEqual(journals.entries.map(entry => entry.after), [2, 1])
    await assert.rejects(
      () => app.xpPoints.getScoreLeaderboardPage('primary', {
        platform: 'onebot', guildId: 'g1',
      }, { page: 3, pageSize: 10 }),
      /只有 2 页/,
    )
  })
})
