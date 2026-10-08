import assert from 'node:assert/strict'
import { it, afterEach } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { registerModels } from '../src/model'
import { registerAccountModels } from '../src/account-model'
import { AccountLifecycleStore } from '../src/account-lifecycle'
import { SubjectLedgerStore, SubjectWriteCoordinator } from '../src/subject-ledger'
import { configurePeriodsIn, resolvePeriodIn } from '../src/period-ledger'
import { PersonAssociationStore } from '../src/account-association'
import { AccountModeStore } from '../src/account-mode'
import { randomUUID } from 'node:crypto'
import { AccountQueryStore } from '../src/account-queries'
import { readAccountDeletion, eraseAccountData, readSystemAccountDeletion, eraseSystemAccountData } from '../src/account-deletion'
const apps: App[] = []
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })
async function fixture() {
  const app = new App(); app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(registerModels); app.plugin(registerAccountModels)
  await app.start(); apps.push(app)
  const writes = new SubjectWriteCoordinator(), lifecycle = new AccountLifecycleStore(app.database, writes)
  await lifecycle.bootstrap()
  const now = new Date()
  await app.database.create('xp_score_system', { key: 'event', name: '活动积分', scope: 'guild', unit: '分', active: true, createdBy: 'test', createdAt: now, updatedAt: now })
  await app.database.create('xp_score_guild_alias', { systemKey: 'event', platform: 'onebot', sourceGuildId: 'source', targetGuildId: 'pool', createdAt: now, updatedAt: now })
  const person = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'a', suggestedNickname: '示例' })
  await app.database.transact(db => configurePeriodsIn(db, 'event', {}, Date.parse('2026-01-10T00:00:00+08:00')))
  const store = new SubjectLedgerStore(app.database, writes)
  const context = { platform: 'onebot', guildId: 'source', source: 'test', reason: '竞技奖励', effectiveAt: Date.parse('2026-02-20T12:00:00+08:00'), businessId: 'game-1' }
  return { app, writes, store, person, context, lifecycle }
}
const scoreValues = async (app: App) => (await app.database.get('xp_period_score', {})).map(r => r.value)
it('records cumulative delta and all five period results in one transaction without clearing the balance', async () => {
  const { app, store, person, context } = await fixture(), target = { accountId: person.account.id }
  await store.add('event', target, 2.5, { ...context, idempotencyKey: 'one' })
  assert.deepEqual(await scoreValues(app), [2.5, 2.5, 2.5, 2.5, 2.5])
  await store.set('event', target, 1, { ...context, idempotencyKey: 'two' })
  assert.deepEqual(await scoreValues(app), [1, 1, 1, 1, 1])
  await store.add('event', target, 7, { ...context, competitive: false })
  assert.equal(await store.get('event', target, context), 8)
  assert.deepEqual(await scoreValues(app), [1, 1, 1, 1, 1])
  assert.ok((await app.database.get('xp_period_score', {})).every(r => r.guildId === 'pool'))
  assert.deepEqual((await app.database.get('xp_period_journal', {})).map(r => r.delta), [2.5, -1.5, 7])
})
it('deduplicates retries and rejects altered competitive flags, business association or date', async () => {
  const { app, store, person, context } = await fixture(), target = { accountId: person.account.id }, ctx = { ...context, idempotencyKey: 'stable' }
  const a = await store.add('event', target, 1, ctx)
  const b = await store.add('event', target, 1, ctx)
  assert.equal(a.journalId, b.journalId); assert.equal(b.deduplicated, true)
  assert.equal((await app.database.get('xp_period_journal', {})).length, 1)
  for (const change of [{ competitive: false }, { effectiveAt: context.effectiveAt + 1 }, { businessId: 'game-2' }])
    await assert.rejects(store.add('event', target, 1, { ...ctx, ...change }), /竞技/)
  assert.deepEqual(await scoreValues(app), [1, 1, 1, 1, 1])
})
it('20 concurrent first increments retain exact cumulative and period balances', async () => {
  const { app, store, person, context } = await fixture()
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.add('event', { accountId: person.account.id }, 0.5, { ...context, idempotencyKey: 'parallel-' + i })))
  assert.deepEqual(await scoreValues(app), [10, 10, 10, 10, 10])
  assert.equal((await app.database.get('xp_period_journal', {})).length, 20)
})
it('rolls cumulative balance and journal back if any period write fails', async () => {
  const { app, writes, person, context } = await fixture()
  const faulty = new Proxy(app.database, { get(target, key) {
    if (key === 'transact') return (callback: any) => target.transact(db => callback(new Proxy(db, { get(tx, prop) {
      if (prop === 'upsert') return (table: string, rows: any) => {
        if (table === 'xp_period_score') throw new Error('injected period failure')
        return (tx.upsert as any)(table, rows)
      }
      const value = Reflect.get(tx, prop); return typeof value === 'function' ? value.bind(tx) : value
    } })))
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(new SubjectLedgerStore(faulty, writes).add('event', { accountId: person.account.id }, 1, context), /injected period failure/)
  for (const table of ['xp_subject_balance', 'xp_score_journal', 'xp_period_journal', 'xp_period_score', 'xp_period_definition'] as const)
    assert.equal((await app.database.get(table, {})).length, 0, table)
})
it('fixes existing season boundaries, stages config at next season, marks partial start and supports explicit backfill', async () => {
  const { app, store, person, context } = await fixture()
  const jan = Date.parse('2026-01-20T00:00:00+08:00')
  const before = await app.database.transact(db => resolvePeriodIn(db, 'event', 'season', jan))
  assert.equal(before!.incomplete, true)
  await app.database.transact(db => configurePeriodsIn(db, 'event', { timeZone: 'Asia/Shanghai', season: { unit: 'day', length: 14, start: '2026-02-01' } }, jan))
  const same = await app.database.transact(db => resolvePeriodIn(db, 'event', 'season', jan))
  assert.equal(same!.id, before!.id)
  const feb = await app.database.transact(db => resolvePeriodIn(db, 'event', 'season', Date.parse('2026-02-02T00:00:00+08:00')))
  assert.equal(feb!.end - feb!.start, 14 * 86400000)
  await store.add('event', { accountId: person.account.id }, -0.5, { ...context, effectiveAt: Date.parse('2025-12-15T00:00:00+08:00') })
  assert.ok((await app.database.get('xp_period_definition', { kind: 'month', label: '2025-12' }))[0].incomplete)
  await assert.rejects(store.add('event', { accountId: person.account.id }, 2, { ...context, effectiveAt: Date.now() + 100000 }), /未来/)
})

it('keeps period maximum separate from cumulative sum and does not duplicate scores through repeated mode changes', async () => {
  const { app, writes, store, person, context, lifecycle } = await fixture()
  await app.database.createUser('onebot', 'admin', { authority: 2 })
  const second = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'b', suggestedNickname: '小号' })
  await store.add('event', { accountId: person.account.id }, 5, { ...context, idempotencyKey: 'first' })
  await store.add('event', { accountId: second.account.id }, 3, { ...context, idempotencyKey: 'second' })
  const associations = new PersonAssociationStore(app.database, writes, async () => {})
  const request = { operationId: 'XPAR:' + randomUUID(), kind: 'merge-persons' as const, sourceProfileId: second.profile.id,
    targetProfileId: person.profile.id, actor: { platform: 'onebot', userId: 'admin' }, systems: [{ systemKey: 'event', mode: 'shared' as const, strategy: 'sum' as const }] }
  const preview = await associations.preview(request)
  await associations.apply(request, preview.fingerprint, () => {})
  assert.equal(await store.get('event', { accountId: person.account.id }, context), 8)
  assert.deepEqual(await scoreValues(app), [5, 5, 5, 5, 5])
  const modes = new AccountModeStore(app.database, writes, async () => {})
  for (let i = 0; i < 2; i++) for (const nextMode of ['independent', 'shared'] as const) {
    const change = { operationId: 'XPAC:' + randomUUID(), profileId: person.profile.id, systemKey: 'event', nextMode,
      retainedAccountId: person.account.id, strategy: 'maximum' as const, actor: { platform: 'onebot', userId: 'admin' } }
    const p = await modes.preview(change); await modes.apply(change, p.fingerprint, () => {})
    assert.deepEqual(await scoreValues(app), [5, 5, 5, 5, 5])
  }
  const retry = await store.add('event', { accountId: second.account.id }, 3, { ...context, idempotencyKey: 'second' })
  assert.equal(retry.deduplicated, true)
  assert.deepEqual(await scoreValues(app), [5, 5, 5, 5, 5])
  assert.ok((await app.database.get('xp_period_adjustment', {})).length >= 5)
})

it('refuses self conversion with negative period scores even when cumulative balance is positive, while admin can separately sum periods', async () => {
  const { app, writes, store, person, context, lifecycle } = await fixture()
  await app.database.createUser('onebot', 'admin', { authority: 2 }); await app.database.createUser('onebot', 'a', { authority: 1 })
  await store.add('event', { accountId: person.account.id }, -2, context)
  await store.add('event', { accountId: person.account.id }, 10, { ...context, competitive: false })
  const modes = new AccountModeStore(app.database, writes, async () => {})
  const change = { operationId: 'XPAC:' + randomUUID(), profileId: person.profile.id, systemKey: 'event', nextMode: 'independent' as const,
    retainedAccountId: person.account.id, strategy: 'maximum' as const, actor: { platform: 'onebot', userId: 'a' } }
  await assert.rejects(modes.preview(change), /负分/)
  const other = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'b', suggestedNickname: '乙' })
  await store.add('event', { accountId: other.account.id }, 6, context)
  const associations = new PersonAssociationStore(app.database, writes, async () => {})
  const req = { operationId: 'XPAR:' + randomUUID(), kind: 'merge-persons' as const, sourceProfileId: other.profile.id,
    targetProfileId: person.profile.id, actor: { platform: 'onebot', userId: 'admin' }, systems: [{ systemKey: 'event', mode: 'shared' as const, strategy: 'maximum' as const, periodStrategy: 'sum' as const }] }
  const p = await associations.preview(req); await associations.apply(req, p.fingerprint, () => {})
  assert.equal(await store.get('event', { accountId: person.account.id }, context), 8)
  assert.deepEqual(await scoreValues(app), [4, 4, 4, 4, 4])
})

it('filters presence by the source guild and retains period scores when cumulative balance is zero', async () => {
  const { app, writes, store, person, context } = await fixture(), target = { accountId: person.account.id }
  await store.add('event', target, 3, context)
  await store.set('event', target, 0, { ...context, competitive: false })
  const period = (await app.database.get('xp_period_definition', { kind: 'month' }))[0]
  const query = new AccountQueryStore(app.database, writes)
  const now = new Date()
  await app.database.create('xp_guild_presence', { platform: 'onebot', guildId: 'source', userId: 'a', state: 'inactive', reason: 'left', firstConfirmedAt: now, lastConfirmedAt: now, inactiveAt: now })
  assert.equal((await query.leaderboardEntries('event', context, { periodId: period.id })).length, 0)
  const shown = await query.leaderboardEntries('event', context, { periodId: period.id, inactivePolicy: 'show' })
  assert.equal(shown[0].value, 3); assert.equal(shown[0].inactive, true)
  const other = await query.leaderboardEntries('event', { platform: 'onebot', guildId: 'pool' }, { periodId: period.id })
  assert.equal(other[0].value, 3); assert.equal(other[0].inactive, undefined)
})

it('deletes period balances journals and adjustment details with the person, and definitions with the system', async () => {
  const { app, store, person, context } = await fixture()
  await store.add('event', { accountId: person.account.id }, 2, context)
  const scope = { mode: 'profile' as const, rootProfileId: person.profile.id, profileIds: [person.profile.id],
    identities: [{ platform: 'onebot', userId: 'a', profileId: person.profile.id }] }
  await app.database.transact(async db => { const p = await readAccountDeletion(db, scope); await eraseAccountData(db, scope, p) })
  assert.equal((await app.database.get('xp_period_score', {})).length, 0)
  assert.equal((await app.database.get('xp_period_journal', {})).length, 0)
  assert.equal((await app.database.get('xp_period_definition', {})).length, 5)
  await app.database.transact(async db => { const p = await readSystemAccountDeletion(db, 'event'); await eraseSystemAccountData(db, 'event', p) })
  assert.equal((await app.database.get('xp_period_definition', {})).length, 0)
  assert.equal((await app.database.get('xp_period_policy', {})).length, 0)
})
