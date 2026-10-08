import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { registerModels } from '../src/model'
import { registerAccountModels } from '../src/account-model'
import { AccountLifecycleStore } from '../src/account-lifecycle'
import { AccountMaintenanceStore } from '../src/account-maintenance'
import { PersonAssociationStore, type PersonAssociationRequest } from '../src/account-association'
import { SubjectLedgerStore, SubjectWriteCoordinator } from '../src/subject-ledger'

const apps: App[] = []
const actor = { platform: 'onebot', userId: 'admin' }
const scoreContext = (id: string) => ({ platform: 'onebot', guildId: 'g', source: 'fixture', reason: 'reward', idempotencyKey: id })
async function fixture() {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(registerModels)
  app.plugin(registerAccountModels)
  await app.start()
  apps.push(app)
  await app.database.createUser('onebot', 'admin', { authority: 2 })
  await app.database.createUser('onebot', 'a', { authority: 1 })
  const writes = new SubjectWriteCoordinator()
  const lifecycle = new AccountLifecycleStore(app.database, writes)
  await lifecycle.bootstrap()
  for (const [key, scope] of [['global', 'global'], ['guild', 'guild']] as const) {
    const now = new Date()
    await app.database.create('xp_score_system', { key, scope, name: key, unit: '分', active: true,
      createdBy: 'fixture', createdAt: now, updatedAt: now })
  }
  const a = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'a', suggestedNickname: 'Alpha' })
  const b = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'b', suggestedNickname: 'Beta' })
  const ledger = new SubjectLedgerStore(app.database, writes)
  const store = new PersonAssociationStore(app.database, writes, async () => {})
  const metadata = new AccountMaintenanceStore(app.database, writes, async () => {})
  await metadata.setPrimary(actor, b.profile.id, b.account.id)
  const reward = await ledger.add('global', { accountId: a.account.id }, 4.5, scoreContext('original'))
  await ledger.add('global', { accountId: b.account.id }, 3, scoreContext('target'))
  await ledger.add('guild', { accountId: a.account.id }, -2, scoreContext('negative'))
  const request = (): PersonAssociationRequest => ({ kind: 'merge-persons', operationId: 'XPAR:' + randomUUID(),
    sourceProfileId: a.profile.id, targetProfileId: b.profile.id, actor,
    systems: ['global', 'guild'].map(systemKey => ({ systemKey, mode: 'shared', strategy: 'maximum' })) })
  return { app, writes, lifecycle, a, b, ledger, store, request, reward }
}
const allTables = ['xp_profile', 'xp_identity', 'xp_account', 'xp_account_policy', 'xp_score_subject', 'xp_subject_balance',
  'xp_person_preference', 'xp_profile_merge', 'xp_score_journal', 'xp_journal_subject', 'xp_account_operation'] as const
const snapshot = (app: App) => Promise.all(allTables.map(table => app.database.get(table, {})))
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

async function movable(independent = false) {
  const f = await fixture()
  const c = await f.lifecycle.ensureIdentity({ platform: 'onebot', userId: 'c', suggestedNickname: 'Gamma' })
  const initial = f.request()
  initial.sourceProfileId = c.profile.id
  initial.targetProfileId = f.a.profile.id
  initial.systems = initial.systems.map(row => ({ ...row, mode: independent ? 'independent' : 'shared',
    sourceRetainedAccountId: c.account.id, targetRetainedAccountId: f.a.account.id }))
  const before = await f.store.preview(initial)
  await f.store.apply(initial, before.fingerprint, () => {})
  const move: PersonAssociationRequest = { ...f.request(), kind: 'move-account', movedAccountId: f.a.account.id }
  return { ...f, c, move }
}

it('single shared-account movement leaves original shared balances in its nonempty group', async () => {
  const { app, a, b, c, ledger, store, move, reward } = await movable()
  const metadata = new AccountMaintenanceStore(app.database, new SubjectWriteCoordinator(), async () => {})
  await metadata.setPrimary(actor, a.profile.id, a.account.id)
  const beforeSubjects = await app.database.get('xp_score_subject', { profileId: a.profile.id, active: true })
  const preview = await store.preview(move)
  await store.apply(move, preview.fingerprint, () => {})
  assert.equal(await ledger.get('global', { accountId: c.account.id }, {}), 4.5)
  assert.equal(await ledger.get('global', { accountId: a.account.id }, {}), 3)
  assert.equal(await ledger.get('global', { accountId: b.account.id }, {}), 3)
  assert.deepEqual(await app.database.get('xp_score_subject', { profileId: a.profile.id, active: true }), beforeSubjects)
  assert.equal((await app.database.get('xp_person_preference', { profileId: a.profile.id }))[0].primaryAccountId, null)
  assert.equal((await app.database.get('xp_profile_merge', { sourceProfileId: a.profile.id })).length, 0)
  const retry = await ledger.add('global', { accountId: a.account.id }, 4.5, scoreContext('original'))
  assert.equal(retry.journalId, reward.journalId)
  assert.equal(retry.deduplicated, true)
  assert.equal(await ledger.get('global', { accountId: a.account.id }, {}), 3)
  const sharedRetry = await ledger.add('global', { accountId: b.account.id }, 4.5, scoreContext('original'))
  assert.equal(sharedRetry.journalId, reward.journalId)
  assert.equal(sharedRetry.deduplicated, true)
})

it('single independent-account movement carries only its balances and keeps both persons valid', async () => {
  const { app, a, b, c, ledger, store, move } = await movable(true)
  await ledger.add('global', { accountId: c.account.id }, 8, scoreContext('remaining'))
  move.systems = move.systems.map(row => ({ ...row, mode: 'independent', targetRetainedAccountId: b.account.id }))
  const preview = await store.preview(move)
  await store.apply(move, preview.fingerprint, () => {})
  assert.equal(await ledger.get('global', { accountId: a.account.id }, {}), 4.5)
  assert.equal(await ledger.get('global', { accountId: c.account.id }, {}), 8)
  assert.equal(await ledger.get('global', { accountId: b.account.id }, {}), 3)
  assert.equal((await app.database.get('xp_identity', { userId: 'c' }))[0].profileId, a.profile.id)
  assert.equal((await app.database.get('xp_account', { id: a.account.id }))[0].nickname, 'Alpha')
  assert.equal((await app.database.get('xp_profile', {})).length, 2)
})

it('refuses moving the last account or another person account and cannot hide corrupted source policy', async () => {
  const f = await fixture()
  await assert.rejects(f.store.preview({ ...f.request(), kind: 'move-account', movedAccountId: f.a.account.id }), /最后一个/)
  const { app, store, move, b, a } = await movable()
  await assert.rejects(store.preview({ ...move, movedAccountId: b.account.id }), /不属于/)
  await app.database.remove('xp_score_subject', { profileId: a.profile.id, systemKey: 'global', active: true })
  await assert.rejects(store.preview(move), /原组计分主体/)
})

it('single-account movement rolls back ownership and balances on final audit failure', async () => {
  const { app, store, move } = await movable(true)
  const preview = await store.preview(move)
  ;(app.database as any).getDriver('xp_account_operation')._run(
    "CREATE TRIGGER move_fault BEFORE INSERT ON xp_account_operation WHEN NEW.kind='account-move' BEGIN SELECT RAISE(FAIL, 'move fault'); END")
  const before = await snapshot(app)
  await assert.rejects(store.apply(move, preview.fingerprint, () => {}))
  assert.deepEqual(await snapshot(app), before)
})

it('associates all systems atomically, preserving account names, main selection, journals and exact reward retries', async () => {
  const { app, a, b, ledger, store, request, reward } = await fixture()
  const change = request()
  const beforeJournal = await app.database.get('xp_score_journal', {})
  const preview = await store.preview(change)
  assert.equal(preview.labelChanges[0].after, '账号1-2')
  assert.equal(preview.systemPlans.find(row => row.system.key === 'guild')!.plan.pools[0].discardedNegativeSources[0].value, -2)
  const result = await store.apply(change, preview.fingerprint, () => {})
  assert.equal(result.profileId, b.profile.id)
  assert.equal((await app.database.get('xp_profile', { id: a.profile.id })).length, 0)
  assert.equal((await app.database.get('xp_identity', { userId: 'a' }))[0].profileId, b.profile.id)
  assert.equal((await app.database.get('xp_account', { id: a.account.id }))[0].nickname, 'Alpha')
  assert.equal((await app.database.get('xp_person_preference', { profileId: b.profile.id }))[0].primaryAccountId, b.account.id)
  assert.equal(await ledger.get('global', { accountId: a.account.id }, {}), 4.5)
  assert.equal(await ledger.get('global', { accountId: b.account.id }, {}), 4.5)
  assert.deepEqual(await app.database.get('xp_score_journal', {}), beforeJournal)
  const stable = await snapshot(app)
  assert.equal((await store.apply(change, preview.fingerprint, () => {})).deduplicated, true)
  const retry = await ledger.add('global', { accountId: a.account.id }, 4.5, scoreContext('original'))
  assert.equal(retry.journalId, reward.journalId)
  assert.equal(retry.deduplicated, true)
  assert.deepEqual(await snapshot(app), stable)
})

it('independent association retains original account balances across all pools, including disabled systems', async () => {
  const { app, a, b, ledger, store, request } = await fixture()
  await app.database.set('xp_score_system', { key: 'guild' }, { active: false })
  const change = request()
  change.systems = change.systems.map(row => ({ ...row, mode: 'independent' }))
  change.primaryAccountId = b.account.id
  const preview = await store.preview(change)
  await store.apply(change, preview.fingerprint, () => {})
  assert.equal(await ledger.get('global', { accountId: a.account.id }, {}), 4.5)
  assert.equal(await ledger.get('global', { accountId: b.account.id }, {}), 3)
  assert.equal(await ledger.get('guild', { accountId: a.account.id }, scoreContext('r')), -2)
  assert.equal(await ledger.get('guild', { accountId: b.account.id }, scoreContext('r')), 0)
  await assert.rejects((ledger.get as any)('global', { profileId: b.profile.id }, {}), /请指定一个有效账号/)
  assert.equal((await app.database.get('xp_account', { id: a.account.id }))[0].nickname, 'Alpha')
  assert.equal((await app.database.get('xp_account', { id: b.account.id }))[0].nickname, 'Beta')
  assert.equal((await app.database.get('xp_person_preference', { profileId: b.profile.id }))[0].primaryAccountId, b.account.id)
})

it('keeps primary changes in the preview fingerprint, transaction and retry payload', async () => {
  const { app, a, b, store, request } = await fixture()
  const change = { ...request(), primaryAccountId: a.account.id }
  const preview = await store.preview(change)
  assert.deepEqual(preview.primaryChange, { before: b.account.id, after: a.account.id })
  const before = await snapshot(app)
  await assert.rejects(store.preview({ ...change, primaryAccountId: 'unknown' }), /指定主号/)
  await assert.rejects(store.apply({ ...change, primaryAccountId: b.account.id }, preview.fingerprint, () => {}), /已变化/)
  assert.deepEqual(await snapshot(app), before)
  const driver = (app.database as any).getDriver('xp_account_operation')
  driver._run("CREATE TRIGGER primary_fault BEFORE INSERT ON xp_account_operation BEGIN SELECT RAISE(FAIL, 'primary fault'); END")
  await assert.rejects(store.apply(change, preview.fingerprint, () => {}))
  assert.deepEqual(await snapshot(app), before)
  driver._run('DROP TRIGGER primary_fault')
  await store.apply(change, preview.fingerprint, () => {})
  assert.equal((await app.database.get('xp_person_preference', { profileId: b.profile.id }))[0].primaryAccountId, a.account.id)
  assert.equal((await store.apply(change, preview.fingerprint, () => {})).deduplicated, true)
  await assert.rejects(store.apply({ ...change, primaryAccountId: b.account.id }, preview.fingerprint, () => {}), /操作 ID/)
})

it('does not infer a balance recipient when a multi-account shared group becomes independent', async () => {
  const { app, a, b, c, ledger, store, request } = await movable()
  const change = request()
  change.primaryAccountId = b.account.id
  change.systems = change.systems.map(row => ({ ...row, mode: 'independent' }))
  const before = await snapshot(app)
  await assert.rejects(store.preview(change), /承接账号/)
  assert.deepEqual(await snapshot(app), before)
  change.systems = change.systems.map(row => ({ ...row, sourceRetainedAccountId: c.account.id }))
  const preview = await store.preview(change)
  await store.apply(change, preview.fingerprint, () => {})
  assert.equal(await ledger.get('global', { accountId: c.account.id }, {}), 4.5)
  assert.equal(await ledger.get('global', { accountId: a.account.id }, {}), 0)
  assert.equal(await ledger.get('global', { accountId: b.account.id }, {}), 3)
})

it('refuses stale metadata, net-zero rewards, missing systems and unknown actor authority without mutations', async () => {
  const { app, a, b, ledger, store, request } = await fixture()
  const change = request(), preview = await store.preview(change)
  await ledger.add('global', { accountId: a.account.id }, 1, scoreContext('plus'))
  await ledger.add('global', { accountId: a.account.id }, -1, scoreContext('minus'))
  const before = await snapshot(app)
  await assert.rejects(store.apply(change, preview.fingerprint, () => {}), /已变化/)
  await assert.rejects(store.preview({ ...request(), systems: [] }), /全部积分系统/)
  await assert.rejects(store.preview({ ...request(), actor: { platform: 'onebot', userId: 'a' } }), /管理员/)
  assert.deepEqual(await snapshot(app), before)
  const fresh = await store.preview(request())
  await app.database.set('xp_account', { id: b.account.id }, { nickname: 'Changed' })
  await assert.rejects(store.apply(fresh.request, fresh.fingerprint, () => {}), /已变化/)
})

it('rechecks authority, occupancy and token freshness at commit time', async () => {
  const { app, a, b, writes, store, request } = await fixture()
  const change = request(), preview = await store.preview(change)
  const blocked = new PersonAssociationStore(app.database, writes, async scope => {
    assert.deepEqual(new Set(scope.profileIds), new Set([a.profile.id, b.profile.id]))
    throw new Error('game occupied')
  })
  const before = await snapshot(app)
  await assert.rejects(blocked.apply(change, preview.fingerprint, () => {}), /occupied/)
  await assert.rejects(store.apply(change, preview.fingerprint, () => { throw new Error('expired') }), /expired/)
  assert.deepEqual(await snapshot(app), before)
  const binding = (await app.database.get('binding', { platform: actor.platform, pid: actor.userId }))[0]
  await app.database.set('user', { id: binding.aid }, { authority: 1 })
  await assert.rejects(store.apply(change, preview.fingerprint, () => {}), /管理员/)
  assert.deepEqual(await snapshot(app), before)
})

it('serializes duplicate confirmations and rejects operation-ID payload reuse', async () => {
  const { app, store, request } = await fixture()
  const change = request(), preview = await store.preview(change)
  const results = await Promise.all(Array.from({ length: 10 }, () => store.apply(change, preview.fingerprint, () => {})))
  assert.equal(results.filter(row => !row.deduplicated).length, 1)
  const before = await snapshot(app)
  await assert.rejects(store.apply({ ...change, systems: change.systems.map(row => ({ ...row, strategy: 'sum' })) }, preview.fingerprint, () => {}), /操作 ID/)
  assert.deepEqual(await snapshot(app), before)
})

it('rolls back every relation/subject/balance/metadata write boundary when its database operation fails', async () => {
  for (const [table, operation] of [
    ['xp_subject_balance', 'DELETE'], ['xp_score_subject', 'UPDATE'], ['xp_score_subject', 'INSERT'],
    ['xp_subject_balance', 'INSERT'], ['xp_account_policy', 'UPDATE'], ['xp_account_policy', 'DELETE'],
    ['xp_account', 'UPDATE'], ['xp_identity', 'UPDATE'], ['xp_profile', 'UPDATE'],
    ['xp_profile_merge', 'INSERT'], ['xp_person_preference', 'DELETE'], ['xp_profile', 'DELETE'], ['xp_account_operation', 'INSERT'],
  ]) {
    const { app, store, request } = await fixture()
    const change = request(), preview = await store.preview(change)
    ;(app.database as any).getDriver(table)._run(`CREATE TRIGGER association_fault BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(FAIL, 'fixture fault'); END`)
    const before = await snapshot(app)
    await assert.rejects(store.apply(change, preview.fingerprint, () => {}), undefined, `${operation} ${table}`)
    assert.deepEqual(await snapshot(app), before, `${operation} ${table}`)
    await app.stop(); apps.splice(apps.indexOf(app), 1)
  }
})
