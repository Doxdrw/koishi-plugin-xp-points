import { maintainFixtureIdentity } from './managed-account-fixture'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { App, Context } from 'koishi'
import * as xpPointsPlugin from '../src/plugin'
import type { ProfileDataConsumer, ProfileDeletionActor, ProfileDeletionScope } from '../src/deletion'

interface DeletionConsumerRow {
  id: number
  profileId: number
  platform: string
  userId: string
  value: string
}

declare module 'koishi' {
  interface Tables {
    deletion_consumer: DeletionConsumerRow
  }
}

const apps: App[] = []

afterEach(async () => {
  while (apps.length) await apps.pop()!.stop()
})

const actor: ProfileDeletionActor = {
  platform: 'onebot',
  userId: 'owner',
  selfId: 'bot',
  channelId: 'guild',
}

async function setup(requiredDeletionConsumers: string[] = ['test-consumer']) {
  const app = new App({ autoAssign: true, autoAuthorize: 1 })
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.model.extend('deletion_consumer', {
    id: 'unsigned',
    profileId: 'unsigned',
    platform: 'string',
    userId: 'string',
    value: 'string',
  }, { primary: 'id', autoInc: true })
  app.plugin(xpPointsPlugin, {
    scoreSystems: [{ key: 'primary', name: '测试积分', unit: '分', scope: 'guild' }],
    scoreCommandBindings: [],
    scoreGuildAliases: {},
    leaderboardInactivePolicy: 'hide',
    requiredDeletionConsumers,
    nicknameConsumers: {
      chatluna: { enabled: false, guilds: [], includePrivate: false },
      chatlunaCharacter: { enabled: false, guilds: [], includePrivate: false },
    },
  })
  await app.start()
  await app.database.createUser('onebot', 'owner', { authority: 5 })
  apps.push(app)
  return app
}

function rowsForScope(rows: DeletionConsumerRow[], scope: ProfileDeletionScope): DeletionConsumerRow[] {
  if (scope.mode === 'identity') {
    return rows.filter(row => row.platform === scope.targetIdentity!.platform
      && row.userId === scope.targetIdentity!.userId)
  }
  const profileIds = new Set(scope.profileIds)
  return rows.filter(row => profileIds.has(row.profileId))
}

function registerConsumer(app: App, options: { failDelete?: boolean } = {}): void {
  const consumer: ProfileDataConsumer = {
    name: 'test-consumer',
    async preview(database, scope) {
      const rows = rowsForScope(await database.get('deletion_consumer', {}), scope)
      return {
        affectedRows: rows.length,
        summary: [`删除 ${rows.length} 条测试消费方数据。`],
        snapshot: rows.map(row => ({
          id: row.id,
          profileId: row.profileId,
          platform: row.platform,
          userId: row.userId,
          value: row.value,
        })),
      }
    },
    async delete(database, scope) {
      const rows = rowsForScope(await database.get('deletion_consumer', {}), scope)
      for (const row of rows) await database.remove('deletion_consumer', { id: row.id })
      if (options.failDelete) throw new Error('consumer deletion failed')
    },
  }
  app.xpPoints.registerProfileDataConsumer(consumer)
}

describe('token-bound profile deletion coordinator', () => {
  it('runs attached-file cleanup only after commit and reports its failure without claiming rollback', async () => {
    const app = await setup(['files'])
    await app.xpPoints.ensureManagedIdentity('onebot', 'target', 'Target')
    let called = 0
    app.xpPoints.registerProfileDataConsumer({ name: 'files', preview: async () => ({ affectedRows: 0, summary: [], snapshot: null }),
      delete: async () => {}, afterDelete: async () => {
        called++
        assert.equal((await app.database.get('xp_profile', { nickname: 'Target' })).length, 0)
        throw new Error('disk cleanup failed')
      } })
    const preview = await app.xpPoints.previewDeleteProfile('Target', actor)
    const result = await app.xpPoints.confirmProfileDeletion(preview.token, actor)
    assert.equal(called, 1)
    assert.match(result.warnings!.join(''), /附属文件清理未完成/)
    assert.equal((await app.database.get('xp_identity', { userId: 'target' })).length, 0)
  })
  it('never calls attached-file cleanup when another deletion consumer rolls back', async () => {
    const app = await setup(['files', 'fault'])
    await app.xpPoints.ensureManagedIdentity('onebot', 'target', 'Target')
    let called = 0
    app.xpPoints.registerProfileDataConsumer({ name: 'files', preview: async () => ({ affectedRows: 0, summary: [], snapshot: null }),
      delete: async () => {}, afterDelete: async () => { called++ } })
    app.xpPoints.registerProfileDataConsumer({ name: 'fault', preview: async () => ({ affectedRows: 0, summary: [], snapshot: null }),
      delete: async db => { await db.get('xp_profile', {}); throw new Error('rollback') } })
    const preview = await app.xpPoints.previewDeleteProfile('Target', actor)
    await assert.rejects(app.xpPoints.confirmProfileDeletion(preview.token, actor), /rollback/)
    assert.equal(called, 0)
    assert.equal((await app.database.get('xp_identity', { userId: 'target' })).length, 1)
  })
  it('erases new account rows and private details but refuses an old reward after recreation', async () => {
    const app = await setup([])
    const identity = await app.xpPoints.ensureManagedIdentity('onebot', 'recreated', 'ErasedName')
    const context = { platform: 'onebot', guildId: 'guild', source: 'game', reason: 'reward', idempotencyKey: 'stable-reward' }
    await app.xpPoints.addAccountScore('primary', { accountId: identity.accountId }, 3, context)
    const preview = await app.xpPoints.previewDeleteProfile('ErasedName', actor)
    await app.xpPoints.confirmProfileDeletion(preview.token, actor)
    for (const table of ['xp_account', 'xp_person_preference', 'xp_account_policy', 'xp_score_subject',
      'xp_subject_balance', 'xp_score_journal', 'xp_journal_subject'] as const) {
      assert.deepEqual(await app.database.get(table, {}), [], table)
    }
    const markers = await app.database.get('xp_erased_operation', {})
    assert.ok(markers.length)
    assert.ok(markers.every(row => Object.keys(row).join() === 'digest' && /^[a-f0-9]{64}$/.test(row.digest)))
    const replacement = await app.xpPoints.ensureManagedIdentity('onebot', 'recreated', 'NewName')
    await assert.rejects(app.xpPoints.addAccountScore('primary', { accountId: replacement.accountId }, 3, context), /详细记录已经删除/)
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId: replacement.accountId }, context), 0)
    await app.xpPoints.addAccountScore('primary', { accountId: replacement.accountId }, 2, { ...context, idempotencyKey: 'new-reward' })
  })

  it('retains a moved account current balance while erasing its source-person history and retry protection detail', async () => {
    const app = await setup([])
    const source = await maintainFixtureIdentity(app, 'onebot', 'source-main', 'Source')
    const alternate = await maintainFixtureIdentity(app, 'onebot', 'moving-alt', 'Source')
    const target = await maintainFixtureIdentity(app, 'onebot', 'target-main', 'Target')
    const operator = { ...actor, isDirect: true }
    const conversion = await app.xpPoints.accountOperations.previewMode(operator, {
      profileId: source.profileId, systemKey: 'primary', nextMode: 'independent', strategy: 'maximum', retainedAccountId: source.accountId,
    })
    await app.xpPoints.accountOperations.confirm(operator, conversion.token)
    const context = { platform: 'onebot', guildId: 'guild', source: 'game', reason: 'reward', idempotencyKey: 'before-move' }
    await app.xpPoints.addAccountScore('primary', { accountId: alternate.accountId }, 8, context)
    const move = await app.xpPoints.accountOperations.previewAssociation(operator, {
      kind: 'move-account', sourceProfileId: source.profileId, targetProfileId: target.profileId, movedAccountId: alternate.accountId,
      systems: [{ systemKey: 'primary', mode: 'independent', strategy: 'maximum', targetRetainedAccountId: target.accountId }],
    })
    await app.xpPoints.accountOperations.confirm(operator, move.token)
    await app.xpPoints.reload()
    const deletion = await app.xpPoints.previewDeleteProfile('Source', actor)
    await app.xpPoints.confirmProfileDeletion(deletion.token, actor)
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId: alternate.accountId }, context), 8)
    await assert.rejects(app.xpPoints.addAccountScore('primary', { accountId: alternate.accountId }, 8, context), /详细记录已经删除/)
    assert.deepEqual(await app.database.get('xp_score_journal', { profileId: source.profileId }), [])
    const operations = await app.database.get('xp_account_operation', {})
    assert.ok(operations.every(row => !['account-move', 'person-association', 'mode-conversion'].includes(row.kind)))
    assert.ok(operations.every(row => row.kind !== 'storage-upgrade'))
    assert.ok(operations.every(row => JSON.parse(row.snapshot).profileId === target.profileId))
    assert.equal((await app.xpPoints.getManagedIdentity('onebot', 'moving-alt'))!.profileId, target.profileId)
  })

  it('checks actual authority and occupancy again at confirmation, preserving all data on refusal', async () => {
    const app = await setup([])
    const identity = await app.xpPoints.ensureManagedIdentity('onebot', 'player', 'Player')
    const preview = await app.xpPoints.previewDeleteProfile('Player', actor)
    const binding = (await app.database.get('binding', { platform: actor.platform, pid: actor.userId }))[0]
    await app.database.set('user', { id: binding.aid }, { authority: 4 })
    await assert.rejects(app.xpPoints.confirmProfileDeletion(preview.token, actor), /权限 5/)
    await assert.rejects(app.xpPoints.previewDeleteProfile('Player', actor), /权限 5/)
    await app.database.set('user', { id: binding.aid }, { authority: 5 })
    const pending = await app.xpPoints.previewDeleteProfile('Player', actor)
    const consumer = app.xpPoints.registerAccountConsumer('running-game')
    const lease = await consumer.acquire([{ platform: 'onebot', userId: 'player' }])
    await assert.rejects(app.xpPoints.confirmProfileDeletion(pending.token, actor), /running-game/)
    assert.equal((await app.xpPoints.getManagedIdentity('onebot', 'player'))!.accountId, identity.accountId)
    lease.release(); consumer.dispose()
  })

  it('rolls back markers, ledger and consumer data when the final new-account deletion fails', async () => {
    const app = await setup()
    registerConsumer(app)
    const identity = await app.xpPoints.ensureManagedIdentity('onebot', 'rollback', 'Rollback')
    await app.xpPoints.addAccountScore('primary', { accountId: identity.accountId }, 3,
      { platform: 'onebot', guildId: 'guild', source: 'test', reason: 'seed', idempotencyKey: 'rollback' })
    await app.database.create('deletion_consumer', { profileId: identity.profileId, platform: 'onebot', userId: 'rollback', value: 'keep' })
    const tables = ['xp_account', 'xp_identity', 'xp_score_subject', 'xp_subject_balance', 'xp_score_journal',
      'xp_journal_subject', 'xp_account_operation', 'xp_erased_operation', 'deletion_consumer'] as const
    const snapshot = async () => Promise.all(tables.map(table => app.database.get(table, {})))
    const before = await snapshot()
    const preview = await app.xpPoints.previewDeleteProfile('Rollback', actor)
    const driver = (app.database as any).getDriver('xp_account')
    driver._run("CREATE TRIGGER fail_account_delete BEFORE DELETE ON xp_account BEGIN SELECT RAISE(FAIL, 'delete fault'); END")
    await assert.rejects(app.xpPoints.confirmProfileDeletion(preview.token, actor), /delete fault/)
    assert.deepEqual(await snapshot(), before)
    assert.ok(await app.xpPoints.getManagedIdentity('onebot', 'rollback'))
  })

  it('deletes one shared identity while retaining the profile and all scores', async () => {
    const app = await setup()
    registerConsumer(app)
    const alice = await app.xpPoints.ensureManagedGuildIdentity('onebot', '1001', 'guild', 'Alice')
    await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    await app.xpPoints.ensureManagedGuildIdentity('onebot', '1002', 'guild', 'Alice')
    await app.xpPoints.setAccountScore('primary', { accountId: alice.accountId }, 9, {
      platform: 'onebot', guildId: 'guild', source: 'test', reason: 'seed',
    })
    await app.database.create('deletion_consumer', {
      profileId: alice.profileId, platform: 'onebot', userId: '1001', value: 'first',
    })
    await app.database.create('deletion_consumer', {
      profileId: alice.profileId, platform: 'onebot', userId: '1002', value: 'second',
    })

    const preview = await app.xpPoints.previewDeleteIdentity('onebot:1002', actor)
    assert.equal(preview.mode, 'identity')
    assert.match(preview.summary.join('\n'), /共享档案和积分保留/)
    const result = await app.xpPoints.confirmProfileDeletion(preview.token, actor)
    assert.equal(result.deletedIdentities, 1)
    assert.equal(await app.xpPoints.getManagedIdentity('onebot', '1002'), null)
    assert.equal((await app.xpPoints.getManagedIdentity('onebot', '1001'))?.profileId, alice.profileId)
    assert.equal(await app.xpPoints.getAccountScore('primary', { accountId: alice.accountId }, {
      platform: 'onebot', guildId: 'guild',
    }), 9)
    assert.equal((await app.database.get('xp_guild_presence', { userId: '1002' })).length, 0)
    assert.deepEqual((await app.database.get('deletion_consumer', {})).map(row => row.userId), ['1001'])
  })

  it('upgrades the last-account request to a whole-profile deletion including merge history', async () => {
    const app = await setup()
    registerConsumer(app)
    const alice = await maintainFixtureIdentity(app, 'onebot', '1001', 'Alice')
    const bob = await maintainFixtureIdentity(app, 'onebot', '1002', 'Bob')
    await app.xpPoints.setAccountScore('primary', { accountId: bob.accountId }, 7, {
      platform: 'onebot', guildId: 'guild', source: 'test', reason: 'seed',
    })
    await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    await app.database.create('deletion_consumer', {
      profileId: bob.profileId, platform: 'onebot', userId: '1001', value: 'historical',
    })

    const preview = await app.xpPoints.previewDeleteIdentity('onebot:1001', actor)
    assert.equal(preview.mode, 'identity')
    const first = await app.xpPoints.confirmProfileDeletion(preview.token, actor)
    assert.equal(first.deletedProfiles, 0)

    const lastPreview = await app.xpPoints.previewDeleteIdentity('onebot:1002', actor)
    assert.equal(lastPreview.mode, 'profile')
    assert.match(lastPreview.summary.join('\n'), /删除整个档案/)
    await app.xpPoints.confirmProfileDeletion(lastPreview.token, actor)
    assert.equal((await app.database.get('xp_profile', { id: alice.profileId })).length, 0)
    assert.equal((await app.database.get('xp_identity', {})).length, 0)
    assert.equal((app.model as any).tables.xp_score_balance, undefined)
    assert.equal((await app.database.get('xp_score_journal', {})).length, 0)
    assert.equal((await app.database.get('xp_profile_merge', {})).length, 0)
    assert.equal((await app.database.get('deletion_consumer', {})).length, 0)
  })

  it('refuses missing consumers, foreign actors, expired tokens, and changed snapshots', async () => {
    const app = await setup()
    await app.xpPoints.ensureManagedGuildIdentity('onebot', '1001', 'guild', 'Alice')
    await assert.rejects(
      app.xpPoints.previewDeleteIdentity('onebot:1001', actor),
      /test-consumer/,
    )
    registerConsumer(app)

    const foreignPreview = await app.xpPoints.previewDeleteIdentity('onebot:1001', actor)
    await assert.rejects(
      app.xpPoints.confirmProfileDeletion(foreignPreview.token, { ...actor, channelId: 'other' }),
      /不属于当前管理员、机器人或会话/,
    )
    await app.xpPoints.confirmProfileDeletion(foreignPreview.token, actor)
    assert.equal(await app.xpPoints.getManagedIdentity('onebot', '1001'), null)
    await app.xpPoints.ensureManagedGuildIdentity('onebot', '1001', 'guild', 'Alice')

    const expiredPreview = await app.xpPoints.previewDeleteIdentity('onebot:1001', actor)
    const tokenMap = (app.xpPoints as any).deletionTokens as Map<string, { expiresAt: number }>
    tokenMap.get(expiredPreview.token)!.expiresAt = Date.now() - 1
    await assert.rejects(app.xpPoints.confirmProfileDeletion(expiredPreview.token, actor), /已过期/)

    const changedPreview = await app.xpPoints.previewDeleteIdentity('onebot:1001', actor)
    await app.xpPoints.markGuildPresence('onebot', 'guild', '1001', 'inactive', 'changed')
    await assert.rejects(
      app.xpPoints.confirmProfileDeletion(changedPreview.token, actor),
      /数据已经变化/,
    )
    assert.ok(await app.xpPoints.getManagedIdentity('onebot', '1001'))
  })

  it('rolls back xp and consumer rows when any consumer fails', async () => {
    const app = await setup()
    registerConsumer(app, { failDelete: true })
    const alice = await app.xpPoints.ensureManagedGuildIdentity('onebot', '1001', 'guild', 'Alice')
    await app.xpPoints.setAccountScore('primary', { accountId: alice.accountId }, 4, {
      platform: 'onebot', guildId: 'guild', source: 'test', reason: 'seed',
    })
    await app.database.create('deletion_consumer', {
      profileId: alice.profileId, platform: 'onebot', userId: '1001', value: 'keep',
    })
    const preview = await app.xpPoints.previewDeleteProfile('Alice', actor)
    await assert.rejects(
      app.xpPoints.confirmProfileDeletion(preview.token, actor),
      /consumer deletion failed/,
    )
    await assert.rejects(
      app.xpPoints.confirmProfileDeletion(preview.token, actor),
      /不存在或已经使用/,
    )
    assert.ok(await app.xpPoints.getManagedIdentity('onebot', '1001'))
    assert.equal((await app.database.get('xp_subject_balance', {})).length, 1)
    assert.equal((await app.database.get('deletion_consumer', {})).length, 1)
  })
})
