import { maintainFixtureIdentity } from './managed-account-fixture'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { App } from 'koishi'
import * as xpPointsPlugin from '../src/plugin'

const apps: App[] = []

const config = {
  scoreSystems: [{ key: 'primary', name: '测试积分', unit: '分', scope: 'guild' as const }],
  scoreCommandBindings: [],
  scoreGuildAliases: { primary: { onebot: { source: 'target' } } },
  nicknameConsumers: {
    chatluna: { enabled: false, guilds: [], includePrivate: false },
    chatlunaCharacter: { enabled: false, guilds: [], includePrivate: false },
  },
}

const scoreContext = (guildId: string) => ({ platform: 'onebot', guildId })
const getScore = (app: App, accountId: string, guildId: string) =>
  app.xpPoints.getAccountScore('primary', { accountId }, scoreContext(guildId))
const setScore = (app: App, accountId: string, guildId: string, value: number) =>
  app.xpPoints.setAccountScore('primary', { accountId }, value, {
    ...scoreContext(guildId), source: 'test', reason: 'test set',
  })
const addScore = (app: App, accountId: string, guildId: string, value: number) =>
  app.xpPoints.addAccountScore('primary', { accountId }, value, {
    ...scoreContext(guildId), source: 'test', reason: 'test add',
  })

async function createApp(): Promise<App> {
  const app = new App({ autoAssign: true, autoAuthorize: 1 })
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(xpPointsPlugin, config)
  await app.start()
  apps.push(app)
  return app
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.stop()
})

async function storageSnapshot(app: App) {
  return {
    profiles: await app.database.get('xp_profile', {}),
    identities: await app.database.get('xp_identity', {}),
    scores: await app.database.get('xp_subject_balance', {}),
    subjects: await app.database.get('xp_score_subject', {}),
    accounts: await app.database.get('xp_account', {}),
    policies: await app.database.get('xp_account_policy', {}),
    operations: await app.database.get('xp_account_operation', {}),
    journals: await app.database.get('xp_score_journal', {}),
    merges: await app.database.get('xp_profile_merge', {}),
  }
}

describe('dedicated xp-points storage', () => {
  it('characterizes shared alternate-account writes without multiplying rewards', async () => {
    const app = await createApp()
    const main = await maintainFixtureIdentity(app, 'onebot', 'main', 'Example')
    const alternate = await maintainFixtureIdentity(app, 'onebot', 'alternate', 'Example')
    assert.equal(alternate.profileId, main.profileId)
    const context = { ...scoreContext('source'), source: 'fixture', reason: 'one reward', idempotencyKey: 'reward-1' }
    const first = await app.xpPoints.addAccountScore('primary', { accountId: alternate.accountId }, 0.5, context)
    const retry = await app.xpPoints.addAccountScore('primary', { accountId: main.accountId }, 0.5, context)
    assert.equal(first.after, 0.5)
    assert.equal(retry.deduplicated, true)
    assert.equal((await app.database.get('xp_subject_balance', {})).length, 1)
    assert.equal((app.model as any).tables.xp_score_balance, undefined)
    assert.equal((await app.database.get('xp_score_journal', {})).length, 1)
    assert.equal((await app.xpPoints.getScoreLeaderboard('primary', scoreContext('source'))).length, 1)
  })

  it('preserves the original reward journal through chained profile merges and retries', async () => {
    const app = await createApp()
    const first = await maintainFixtureIdentity(app, 'onebot', 'first', 'First')
    await maintainFixtureIdentity(app, 'onebot', 'second', 'Second')
    const last = await maintainFixtureIdentity(app, 'onebot', 'last', 'Last')
    const context = { ...scoreContext('source'), source: 'fixture', reason: 'original reward', idempotencyKey: 'old-reward' }
    const reward = await app.xpPoints.addAccountScore('primary', { accountId: first.accountId }, 2.5, context)
    await maintainFixtureIdentity(app, 'onebot', 'first', 'Second')
    const middle = (await app.xpPoints.getManagedIdentity('onebot', 'first'))!
    const actor = { platform: 'fixture-admin', userId: 'maintainer', selfId: 'bot', channelId: 'private', isDirect: true }
    const proposal = await app.xpPoints.accountOperations.previewAssociation(actor, {
      kind: 'merge-persons', sourceProfileId: middle.profileId, targetProfileId: last.profileId,
      systems: [{ systemKey: 'primary', mode: 'shared', strategy: 'maximum' }],
    })
    await app.xpPoints.accountOperations.confirm(actor, proposal.token)
    await app.xpPoints.reload()
    const before = await storageSnapshot(app)
    const retry = await app.xpPoints.addAccountScore('primary', { accountId: first.accountId }, 2.5, context)
    assert.equal(retry.journalId, reward.journalId)
    assert.equal(retry.deduplicated, true)
    assert.equal(await app.xpPoints.resolveCanonicalProfileId(first.profileId), last.profileId)
    assert.deepEqual(await storageSnapshot(app), before)
    const original = (await app.database.get('xp_score_journal', { id: reward.journalId }))[0]
    assert.equal(original.profileId, first.profileId)
  })

  it('characterizes a shared-account move as zero-score membership rather than a whole-person merge', async () => {
    const app = await createApp()
    const source = await maintainFixtureIdentity(app, 'onebot', 'main', 'Source')
    await maintainFixtureIdentity(app, 'onebot', 'alternate', 'Source')
    const target = await maintainFixtureIdentity(app, 'onebot', 'target', 'Target')
    await setScore(app, source.accountId, 'source', 20)
    await setScore(app, target.accountId, 'source', 3)
    const merges = await app.xpPoints.listProfileMerges()
    await maintainFixtureIdentity(app, 'onebot', 'alternate', 'Target')
    assert.equal((await app.xpPoints.getManagedIdentity('onebot', 'main'))?.profileId, source.profileId)
    assert.equal((await app.xpPoints.getManagedIdentity('onebot', 'alternate'))?.profileId, target.profileId)
    assert.equal(await getScore(app, source.accountId, 'source'), 20)
    assert.equal(await getScore(app, target.accountId, 'source'), 3)
    assert.deepEqual(await app.xpPoints.listProfileMerges(), merges)
  })

  it('never registers removed profile fields on a clean user model', async () => {
    const app = await createApp()
    const fields = Object.keys((app.model as any).tables.user.fields)
    assert.equal(fields.includes('nickname'), false)
    assert.equal(fields.includes('exp'), false)

    await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    assert.deepEqual(Object.keys((app.model as any).tables.user.fields), fields)
  })

  it('creates automatic profiles, resolves collisions, and freezes the first nickname', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', '12345678', 'Alice')
    const duplicate = await app.xpPoints.ensureManagedIdentity('onebot', '87654321', 'Alice')
    const duplicateAgain = await app.xpPoints.ensureManagedIdentity('onebot', '00004321', 'Alice')
    assert.equal(alice.nickname, 'Alice')
    assert.equal(alice.automatic, true)
    assert.equal(duplicate.nickname, 'Alice#4321')
    assert.equal(duplicateAgain.nickname, 'Alice#4321-2')

    const frozen = await app.xpPoints.ensureManagedIdentity('onebot', '12345678', 'Changed card')
    assert.equal(frozen.nickname, 'Alice')
    assert.equal((await app.database.get('xp_profile', {})).length, 3)
  })

  it('repairs only automatic user-id placeholders when a platform nickname becomes available', async () => {
    const app = await createApp()
    const placeholder = await app.xpPoints.ensureManagedIdentity('onebot', '1001')
    assert.equal(placeholder.nickname, '1001')

    const repaired = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Platform Alice')
    assert.equal(repaired.nickname, 'Platform Alice')
    assert.equal(repaired.profileId, placeholder.profileId)

    await maintainFixtureIdentity(app, 'onebot', '1001', 'Managed Alice')
    const formal = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Changed Platform Name')
    assert.equal(formal.nickname, 'Managed Alice')
    assert.equal(formal.automatic, false)
  })

  it('uses the collision suffix when repairing a user-id placeholder', async () => {
    const app = await createApp()
    await app.xpPoints.ensureManagedIdentity('onebot', '2001', 'Alice')
    await app.xpPoints.ensureManagedIdentity('onebot', '1001')
    const repaired = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    assert.equal(repaired.nickname, 'Alice#1001')
  })

  it('coalesces concurrent automatic creation for the same identity', async () => {
    const app = await createApp()
    const identities = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice'),
      ),
    )
    assert.equal(new Set(identities.map(item => item.profileId)).size, 1)
    assert.equal((await app.database.get('xp_profile', {})).length, 1)
    assert.equal((await app.database.get('xp_identity', {})).length, 1)
  })

  it('retries a transient cross-process identity conflict without leaving an orphan profile', async () => {
    const app = await createApp()
    const originalCreate = app.database.create.bind(app.database)
    let injected = false
    app.database.create = (async (table: string, data: any) => {
      if (table === 'xp_identity' && !injected) {
        injected = true
        throw new Error('UNIQUE constraint failed: xp_identity.platform, xp_identity.userId')
      }
      return (originalCreate as any)(table, data)
    }) as typeof app.database.create
    const identity = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    assert.equal(identity.nickname, 'Alice')
    assert.equal((await app.database.get('xp_profile', {})).length, 1)
    assert.equal((await app.database.get('xp_identity', {})).length, 1)
  })

  it('atomically applies twenty concurrent first score increments', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    const values = await Promise.all(Array.from({ length: 20 }, () =>
      addScore(app, alice.accountId, 'source', 1).then(result => result.after),
    ))
    assert.equal(values.length, 20)
    assert.equal(await getScore(app, alice.accountId, 'source'), 20)
    assert.equal((await app.database.get('xp_subject_balance', {})).length, 1)
  })

  it('retries a transient database lock while adding a score', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    const database = app.database as any
    const originalTransact = database.transact.bind(database)
    let injected = false
    database.transact = async (...args: unknown[]) => {
      if (!injected) {
        injected = true
        throw new Error('database is locked')
      }
      return originalTransact(...args)
    }
    assert.equal((await addScore(app, alice.accountId, 'source', 2)).after, 2)
    assert.equal(await getScore(app, alice.accountId, 'source'), 2)
  })

  it('renames the whole person without implicitly splitting a shared account or changing scores', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    await setScore(app, alice.accountId, 'source', 8)

    const bob = await maintainFixtureIdentity(app, 'onebot', '1002', 'Bob')
    assert.equal(bob.nickname, 'Bob')
    assert.equal(bob.automatic, false)
    assert.equal(bob.profileId, alice.profileId)
    assert.equal(await getScore(app, bob.accountId, 'source'), 8)
    assert.equal(await getScore(app, alice.accountId, 'source'), 8)

    const carol = await maintainFixtureIdentity(app, 'onebot', '1002', 'Carol')
    assert.equal(carol.profileId, bob.profileId)
    assert.equal(carol.nickname, 'Carol')
    assert.equal(await getScore(app, carol.accountId, 'source'), 8)
  })

  it('merges a sole profile into an existing profile by per-guild maximum and journals once', async () => {
    const app = await createApp()
    const alice = await maintainFixtureIdentity(app, 'onebot', '1001', 'Alice')
    const bob = await maintainFixtureIdentity(app, 'onebot', '1002', 'Bob')
    await setScore(app, alice.accountId, 'source', 4.5)
    await setScore(app, bob.accountId, 'source', 9)
    await setScore(app, bob.accountId, 'other', 3)

    const merged = await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    assert.equal(merged.profileId, alice.profileId)
    assert.equal(await getScore(app, alice.accountId, 'source'), 9)
    assert.equal(await getScore(app, alice.accountId, 'other'), 3)
    assert.equal(await app.xpPoints.resolveCanonicalProfileId(bob.profileId), alice.profileId)

    const journal = await app.xpPoints.listProfileMerges()
    assert.deepEqual(journal.map(item => [item.sourceProfileId, item.targetProfileId]), [
      [bob.profileId, alice.profileId],
    ])
    await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    assert.equal((await app.xpPoints.listProfileMerges()).length, 1)
  })

  it('rolls back every merge write boundary and leaves the cache unchanged', async () => {
    const failureTriggers = [
      'CREATE TRIGGER fail_merge BEFORE INSERT ON xp_subject_balance BEGIN SELECT RAISE(FAIL, "score insert"); END',
      'CREATE TRIGGER fail_merge BEFORE UPDATE ON xp_identity BEGIN SELECT RAISE(FAIL, "identity update"); END',
      'CREATE TRIGGER fail_merge BEFORE INSERT ON xp_profile_merge BEGIN SELECT RAISE(FAIL, "merge journal"); END',
      'CREATE TRIGGER fail_merge BEFORE DELETE ON xp_subject_balance BEGIN SELECT RAISE(FAIL, "score delete"); END',
      'CREATE TRIGGER fail_merge BEFORE DELETE ON xp_profile BEGIN SELECT RAISE(FAIL, "profile delete"); END',
    ]
    for (const trigger of failureTriggers) {
      const app = await createApp()
      const alice = await maintainFixtureIdentity(app, 'onebot', '1001', 'Alice')
      const bob = await maintainFixtureIdentity(app, 'onebot', '1002', 'Bob')
      await setScore(app, alice.accountId, 'source', 4)
      await setScore(app, bob.accountId, 'source', 9)
      const before = await storageSnapshot(app)
      const driver = (app.database as any).getDriver('xp_profile')
      driver._run(trigger)
      await assert.rejects(() => maintainFixtureIdentity(app, 'onebot', '1002', 'Alice'))
      assert.deepEqual(await storageSnapshot(app), before)
      assert.equal((await app.xpPoints.getManagedIdentity('onebot', '1002'))?.nickname, 'Bob')
      driver._run('DROP TRIGGER fail_merge')
      await app.stop()
      apps.splice(apps.indexOf(app), 1)
    }
  })

  it('applies guild aliases without depending on channel ordering', async () => {
    const app = await createApp()
    const alice = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    await setScore(app, alice.accountId, 'source', 2.5)
    assert.equal(await getScore(app, alice.accountId, 'target'), 2.5)
    assert.deepEqual(await app.xpPoints.getScoreLeaderboard('primary', scoreContext('source')), [{
      profileId: alice.profileId,
      nickname: 'Alice',
      value: 2.5,
    }])
  })
})
