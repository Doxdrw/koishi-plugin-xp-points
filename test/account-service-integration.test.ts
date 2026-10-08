import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import * as xp from '../src/plugin'
import { maintainFixtureIdentity } from './managed-account-fixture'

const apps: App[] = []
const admin = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private:admin', isDirect: true }
const pool = { platform: 'onebot', guildId: 'source' }
const mutation = (idempotencyKey: string) => ({ ...pool, source: 'fixture', reason: 'reward', idempotencyKey })
async function fixture() {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(xp, { scoreSystems: [{ key: 'event', name: '活动积分', scope: 'guild' }],
    scoreGuildAliases: { event: { onebot: { source: 'pool' } } } })
  await app.start(); apps.push(app)
  await app.database.createUser('onebot', 'admin', { authority: 2 })
  const main = await maintainFixtureIdentity(app, 'onebot', 'main', 'MainName')
  const alternate = await maintainFixtureIdentity(app, 'onebot', 'alt', 'AltName')
  const link = await app.xpPoints.accountOperations.previewAssociation(admin, {
    kind: 'merge-persons', sourceProfileId: alternate.profileId, targetProfileId: main.profileId,
    systems: [{ systemKey: 'event', mode: 'shared', strategy: 'maximum' }],
  })
  await app.xpPoints.accountOperations.confirm(admin, link.token)
  await app.xpPoints.reload()
  return { app, main, alternate }
}
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

it('production service exposes actual account IDs and writes only the new subject balance', async () => {
  const { app, main, alternate } = await fixture()
  assert.equal((await app.xpPoints.getManagedIdentity('onebot', 'alt'))!.accountId, alternate.accountId)
  const consumer = app.xpPoints.registerScoreConsumer({ consumer: 'example', systemKey: 'event' })
  await consumer.addAccount({ accountId: main.accountId }, 0.5, mutation('one'))
  assert.equal(await consumer.getAccount({ accountId: alternate.accountId }, pool), 0.5)
  assert.equal(await consumer.getAccount({ accountId: main.accountId }, pool), 0.5)
  assert.equal((await app.database.get('xp_subject_balance', {})).length, 1)
  assert.equal((app.model as any).tables.xp_score_balance, undefined)
  assert.equal(app.xpPoints.resolveNickname('onebot', 'alt'), 'MainName')
  assert.equal((await app.database.get('xp_account', { id: alternate.accountId }))[0].nickname, 'AltName')
})

it('production handles target independent accounts and rejects person-only writes', async () => {
  const { app, main, alternate } = await fixture()
  const consumer = app.xpPoints.registerScoreConsumer({ consumer: 'example', systemKey: 'event' })
  await consumer.addAccount({ accountId: main.accountId }, 4, mutation('original'))
  const change = await app.xpPoints.accountOperations.previewMode(admin, {
    profileId: main.profileId, systemKey: 'event', nextMode: 'independent', strategy: 'maximum', retainedAccountId: main.accountId,
  })
  await app.xpPoints.accountOperations.confirm(admin, change.token)
  await assert.rejects(consumer.addAccount({ profileId: main.profileId } as any, 1, mutation('ambiguous')), /账号/)
  await consumer.addAccount({ accountId: alternate.accountId }, 9, mutation('alt-reward'))
  assert.equal(await consumer.getAccount({ accountId: main.accountId }, pool), 4)
  assert.equal(await consumer.getAccount({ accountId: alternate.accountId }, pool), 9)
  assert.equal((await consumer.addAccount({ accountId: main.accountId }, 4, mutation('original'))).deduplicated, true)
  const board = await consumer.leaderboard(pool)
  assert.deepEqual(board.map(row => row.value), [9, 4])
  assert.match(board[0].nickname, /AltName/)
  assert.equal((app.model as any).tables.xp_score_balance, undefined)
})

it('new systems initialize all existing persons atomically without rewriting existing policies', async () => {
  const { app, main } = await fixture()
  const before = await app.database.get('xp_account_policy', {})
  await app.xpPoints.createScoreSystem({ key: 'global', name: '全局', scope: 'global' }, 'fixture')
  assert.deepEqual(await app.database.get('xp_account_policy', { systemKey: 'event' }), before)
  assert.equal(await app.xpPoints.getAccountScore('global', { accountId: main.accountId }, {}), 0)
  const driver = (app.database as any).getDriver('xp_account_policy')
  driver._run("CREATE TRIGGER fail_policy BEFORE INSERT ON xp_account_policy BEGIN SELECT RAISE(FAIL, 'fixture fault'); END")
  await assert.rejects(app.xpPoints.createScoreSystem({ key: 'failed', name: '失败', scope: 'global' }, 'fixture'))
  assert.deepEqual(await app.database.get('xp_score_system', { key: 'failed' }), [])
  assert.deepEqual(await app.database.get('xp_score_subject', { systemKey: 'failed' }), [])
})

it('public service occupancy protects relation and rename even after a preview while permitting settlement', async () => {
  const { app, main } = await fixture()
  const proposal = await app.xpPoints.accountOperations.previewMode(admin, {
    profileId: main.profileId, systemKey: 'event', nextMode: 'independent', strategy: 'maximum', retainedAccountId: main.accountId,
  })
  const consumer = app.xpPoints.registerAccountConsumer('example-game')
  const lease = await consumer.acquire([{ platform: 'onebot', userId: 'main' }])
  await assert.rejects(app.xpPoints.accountOperations.confirm(admin, proposal.token), /example-game/)
  await assert.rejects(app.xpPoints.setManagedNickname('onebot', 'alt', 'New', admin), /example-game/)
  await app.xpPoints.addAccountScore('event', { accountId: main.accountId }, 2, mutation('settlement'))
  lease.release()
  await app.xpPoints.setManagedNickname('onebot', 'alt', 'New', admin)
  assert.equal(app.xpPoints.resolveNickname('onebot', 'main'), 'New')
  consumer.dispose()
})

it('rename never silently associates an occupied nickname and requires the actual administrator', async () => {
  const { app, main } = await fixture()
  const other = await app.xpPoints.ensureManagedIdentity('onebot', 'other', 'Other')
  const before = await app.database.get('xp_identity', {})
  await assert.rejects(app.xpPoints.setManagedNickname('onebot', 'other', 'MainName'), /实际管理员/)
  await assert.rejects(app.xpPoints.setManagedNickname('onebot', 'other', 'MainName', admin), /关联大小号/)
  assert.deepEqual(await app.database.get('xp_identity', {}), before)
  assert.notEqual(other.profileId, main.profileId)
})

it('alias drift keeps the applied mapping and marks an online remap pending', async () => {
  const { app, main } = await fixture()
  await app.xpPoints.addAccountScore('event', { accountId: main.accountId }, 2, mutation('pool'))
  const service = app.xpPoints as any
  service.config.scoreGuildAliases = { event: { onebot: { source: 'different' } } }
  service.scoreLoaded = false
  await app.xpPoints.requireScoreSystem('event')
  assert.equal((await app.xpPoints.getGuildAliasRemapStatus()).pending, true)
  assert.equal((await app.database.get('xp_score_guild_alias', {}))[0].targetGuildId, 'pool')
  assert.equal((await app.database.get('xp_subject_balance', {}))[0].value, 2)
})
