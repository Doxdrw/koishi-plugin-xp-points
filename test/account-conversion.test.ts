import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { currentModels, seedCurrentPerson, createCurrentSystem, seedCurrentBalance, bootstrapCurrentSchema } from './current-account-fixture'
import { applyAccountConversionIn, previewAccountConversion, type AccountConversionRequest } from '../src/account-conversion'

const apps: App[] = []
async function fixture() {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(currentModels)
  const systems = [
    { key: 'event', name: '活动', scope: 'guild' }, { key: 'other', name: '其他', scope: 'global' },
  ] as const
  await app.start()
  apps.push(app)
  await bootstrapCurrentSchema(app.database)
  for (const system of systems) await createCurrentSystem(app.database, system)
  const main = await seedCurrentPerson(app.database, 1, 'Example', [['onebot', 'main'], ['onebot', 'alt']], systems)
  for (const [guildId, value] of [['a', 10], ['b', 0.5]] as const) {
    const subject = (await app.database.get('xp_score_subject', { profileId: main.profileId, systemKey: 'event' }))[0]
    await seedCurrentBalance(app.database, subject.id, value, 'onebot', guildId)
  }
  const accounts = await app.database.get('xp_account', {})
  const retained = accounts.find(row => row.userId === 'main')!.id
  const request = (extra: Partial<AccountConversionRequest> = {}): AccountConversionRequest => ({
    operationId: 'XPAC:' + randomUUID(), profileId: main.profileId, systemKey: 'event', nextMode: 'independent',
    retainedAccountId: retained, strategy: 'maximum', actor: { kind: 'self', platform: 'onebot', userId: 'main' }, ...extra,
  })
  // Production integration must recheck permissions and occupancy here. This
  // isolated fixture has no command sessions/consumers; guard behavior is tested below.
  const guard = async () => {}
  const convert = async (change: AccountConversionRequest) => {
    const preview = await previewAccountConversion(app.database, change)
    return app.database.transact(db => applyAccountConversionIn(db, change, preview.fingerprint, guard))
  }
  return { app, main, retained, request, convert, guard }
}
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

const tracked = ['xp_score_subject', 'xp_subject_balance', 'xp_score_guild_component', 'xp_period_guild_component',
  'xp_account_policy', 'xp_account_operation', 'xp_journal_subject'] as const
async function snapshot(app: App) {
  return Promise.all(tracked.map(table => app.database.get(table, {})))
}

describe('staged transactional account conversion', () => {
  it('splits all pools to one account, leaves other systems untouched and never counts conversion as a reward', async () => {
    const { app, main, retained, request, convert } = await fixture()
    const shared = (await app.database.get('xp_score_subject', { profileId: main.profileId, systemKey: 'event', active: true }))[0]
    await app.database.create('xp_score_guild_component', { systemKey: 'event', subjectId: shared.id, platform: 'onebot',
      targetGuildId: 'a', sourceGuildId: 'a', value: 10, kind: 'source', updatedAt: new Date() })
    const other = await app.database.get('xp_score_subject', { systemKey: 'other' })
    const result = await convert(request())
    const active = await app.database.get('xp_score_subject', { systemKey: 'event', active: true })
    assert.equal(active.length, 2)
    assert.equal(active.find(row => row.accountId === retained)!.id, (await app.database.get('xp_subject_balance', {}))[0].subjectId)
    assert.deepEqual((await app.database.get('xp_subject_balance', {})).map(row => row.value), [10, 0.5])
    assert.equal((await app.database.get('xp_subject_balance', { subjectId: result.retiredSubjectIds })).length, 0)
    const components = await app.database.get('xp_score_guild_component', { systemKey: 'event' })
    assert.equal(components.length, 2)
    assert.ok(components.every(row => row.subjectId !== shared.id))
    assert.ok(components.some(row => row.targetGuildId === 'a' && row.sourceGuildId === 'a' && row.value === 10))
    assert.ok(components.some(row => row.targetGuildId === 'b' && row.kind === 'baseline' && row.value === 0.5))
    assert.deepEqual(await app.database.get('xp_score_subject', { systemKey: 'other' }), other)
    const op = (await app.database.get('xp_account_operation', { id: result.operationId }))[0]
    assert.equal(JSON.parse(op.snapshot).plan.pools.length, 2)
  })

  it('replays the original result without changing balances and rejects ID reuse by a different actor or payload', async () => {
    const { app, request, guard } = await fixture()
    const change = request()
    const preview = await previewAccountConversion(app.database, change)
    const first = await app.database.transact(db => applyAccountConversionIn(db, change, preview.fingerprint, guard))
    const before = await snapshot(app)
    const retry = await app.database.transact(db => applyAccountConversionIn(db, change, preview.fingerprint, guard))
    assert.deepEqual(retry, { ...first, deduplicated: true })
    assert.deepEqual(await snapshot(app), before)
    await assert.rejects(app.database.transact(db => applyAccountConversionIn(db, { ...change, strategy: 'sum' }, preview.fingerprint, guard)), /其他请求/)
    await assert.rejects(app.database.transact(db => applyAccountConversionIn(db, { ...change,
      actor: { ...change.actor, userId: 'alt' } }, preview.fingerprint, guard)), /其他请求/)
  })

  it('requires a new preview when balances, nickname, labels or guild aliases change', async () => {
    for (const mutate of [
      async (app: App) => app.database.set('xp_subject_balance', {}, { value: 7 }),
      async (app: App) => app.database.set('xp_profile', {}, { nickname: 'Changed' }),
      async (app: App) => app.database.set('xp_account', { userId: 'alt' }, { label: 'New label' }),
      async (app: App) => app.database.create('xp_score_guild_alias', { systemKey: 'event', platform: 'onebot', sourceGuildId: 'c', targetGuildId: 'a', updatedAt: new Date() }),
    ]) {
      const { app, request, guard } = await fixture()
      const change = request()
      const preview = await previewAccountConversion(app.database, change)
      await mutate(app)
      const before = await snapshot(app)
      await assert.rejects(app.database.transact(db => applyAccountConversionIn(db, change, preview.fingerprint, guard)), /重新预览/)
      assert.deepEqual(await snapshot(app), before)
    }
  })

  it('runs the mandatory authorization/occupancy guard before both first execution and retries', async () => {
    const { app, request, guard } = await fixture()
    const change = request()
    const preview = await previewAccountConversion(app.database, change)
    const denied = async () => { throw new Error('active consumer or revoked authority') }
    const before = await snapshot(app)
    await assert.rejects(app.database.transact(db => applyAccountConversionIn(db, change, preview.fingerprint, denied)), /active consumer/)
    assert.deepEqual(await snapshot(app), before)
    await app.database.transact(db => applyAccountConversionIn(db, change, preview.fingerprint, guard))
    const after = await snapshot(app)
    await assert.rejects(app.database.transact(db => applyAccountConversionIn(db, change, preview.fingerprint, denied)), /revoked authority/)
    assert.deepEqual(await snapshot(app), after)
    await assert.rejects(previewAccountConversion(app.database, request({ nextMode: 'shared',
      actor: { kind: 'self', platform: 'onebot', userId: 'stranger' } })), /本人账号/)
  })

  it('rolls back every write boundary, including the final audit insert', async () => {
    for (const [verb, table] of [
      ['DELETE', 'xp_subject_balance'], ['UPDATE', 'xp_score_subject'], ['INSERT', 'xp_score_subject'],
      ['INSERT', 'xp_subject_balance'], ['UPDATE', 'xp_account_policy'], ['INSERT', 'xp_account_operation'],
    ]) {
      const { app, request, guard } = await fixture()
      const change = request()
      const preview = await previewAccountConversion(app.database, change)
      const before = await snapshot(app)
      const driver = (app.database as any).getDriver(table)
      driver._run(`CREATE TRIGGER conversion_fault BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(FAIL, 'fixture fault'); END`)
      await assert.rejects(app.database.transact(db => applyAccountConversionIn(db, change, preview.fingerprint, guard)))
      assert.deepEqual(await snapshot(app), before, `${verb} ${table}`)
    }
  })

  it('keeps one spendable copy across repeated real database split/sum conversions', async () => {
    const { app, request, convert } = await fixture()
    for (let index = 0; index < 5; index++) {
      await convert(request())
      await convert(request({ nextMode: 'shared', retainedAccountId: undefined, strategy: 'sum',
        actor: { kind: 'administrator', platform: 'onebot', userId: 'admin' } }))
      assert.deepEqual((await app.database.get('xp_subject_balance', {})).map(row => row.value), [10, 0.5])
      assert.equal((await app.database.get('xp_score_subject', { systemKey: 'event', active: true })).length, 1)
    }
    assert.equal((await app.database.get('xp_account_operation', { kind: 'mode-conversion' })).length, 10)
  })

  it('previews sacrificed negative scores for administrators but blocks self conversion and retired balances', async () => {
    const { app, request, convert } = await fixture()
    await convert(request())
    await app.database.set('xp_subject_balance', { guildId: 'a' }, { value: -3 })
    await assert.rejects(previewAccountConversion(app.database, request({ nextMode: 'shared' })), /负分/)
    const admin = request({ nextMode: 'shared', actor: { kind: 'administrator', platform: 'onebot', userId: 'admin' } })
    const preview = await previewAccountConversion(app.database, admin)
    const pool = preview.plan.pools.find(row => row.guildId === 'a')!
    assert.equal(pool.value, 0)
    assert.ok(pool.sources.some(row => row.value === -3))
    const retired = (await app.database.get('xp_score_subject', { systemKey: 'event', active: false }))[0]
    await app.database.create('xp_subject_balance', { subjectId: retired.id, platform: 'onebot', guildId: 'a', value: 20, updatedAt: new Date() })
    await assert.rejects(previewAccountConversion(app.database, admin), /退休/)
  })
})
