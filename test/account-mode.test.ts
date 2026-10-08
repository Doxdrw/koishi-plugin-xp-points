import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { registerModels } from '../src/model'
import { registerAccountModels } from '../src/account-model'
import { AccountLifecycleStore } from '../src/account-lifecycle'
import { AccountModeStore, type AccountModeRequest } from '../src/account-mode'
import { PersonAssociationStore } from '../src/account-association'
import { SubjectLedgerStore, SubjectWriteCoordinator } from '../src/subject-ledger'

const apps: App[] = []
async function fixture() {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(registerModels)
  app.plugin(registerAccountModels)
  await app.start(); apps.push(app)
  const writes = new SubjectWriteCoordinator()
  const lifecycle = new AccountLifecycleStore(app.database, writes)
  await lifecycle.bootstrap()
  const now = new Date()
  await app.database.create('xp_score_system', { key: 'event', name: '活动', unit: '分', scope: 'global',
    active: true, createdBy: 'fixture', createdAt: now, updatedAt: now })
  const own = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'own', suggestedNickname: 'Example' })
  for (const [id, authority] of [['own', 1], ['admin', 2], ['other', 1]] as const) await app.database.createUser('onebot', id, { authority })
  const modes = new AccountModeStore(app.database, writes, async () => {})
  const ledger = new SubjectLedgerStore(app.database, writes)
  const request = (userId = 'own'): AccountModeRequest => ({ operationId: 'XPAC:' + randomUUID(), profileId: own.profile.id,
    systemKey: 'event', nextMode: 'independent', retainedAccountId: own.account.id, strategy: 'maximum', actor: { platform: 'onebot', userId } })
  return { app, writes, own, modes, ledger, request, lifecycle }
}
const snapshot = (app: App) => Promise.all((['xp_subject_balance', 'xp_score_subject', 'xp_score_guild_component', 'xp_period_guild_component',
  'xp_account_policy', 'xp_account_operation'] as const).map(table => app.database.get(table, {})))
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

async function multiFixture() {
  const f = await fixture()
  const other = await f.lifecycle.ensureIdentity({ platform: 'onebot', userId: 'alt', suggestedNickname: 'AltName' })
  const now = new Date()
  for (const [key, scope] of [['platform', 'platform'], ['guild', 'guild']] as const) {
    await f.app.database.create('xp_score_system', { key, name: key, unit: '分', scope, active: true,
      createdBy: 'fixture', createdAt: now, updatedAt: now })
    await f.lifecycle.initializeSystem(key)
  }
  const relation = new PersonAssociationStore(f.app.database, f.writes, async () => {})
  const req = { operationId: 'XPAR:' + randomUUID(), kind: 'merge-persons' as const,
    sourceProfileId: other.profile.id, targetProfileId: f.own.profile.id, actor: { platform: 'onebot', userId: 'admin' },
    defaultScoreMode: 'independent' as const,
    systems: ['event', 'platform', 'guild'].map(systemKey => ({ systemKey, mode: 'independent' as const, strategy: 'maximum' as const })) }
  const preview = await relation.preview(req)
  await relation.apply(req, preview.fingerprint, () => {})
  const contexts = { event: {}, platform: { platform: 'onebot' }, guild: { platform: 'onebot', guildId: 'g' } }
  for (const key of ['event', 'platform', 'guild'] as const) {
    await f.ledger.add(key, { accountId: f.own.account.id }, 7.5, { ...contexts[key], source: 'fixture', reason: 'reward', idempotencyKey: 'old-' + key })
    await f.ledger.add(key, { accountId: other.account.id }, 3, { ...contexts[key], source: 'fixture', reason: 'reward' })
  }
  const all = () => ({ operationId: 'XPAC:' + randomUUID(), profileId: f.own.profile.id,
    nextMode: 'shared' as const, strategy: 'maximum' as const, actor: { platform: 'onebot', userId: 'admin' } })
  return { ...f, other, all, contexts }
}

it('unifies three scopes including disabled systems, inherits future defaults and preserves old reward retries', async () => {
  const f = await multiFixture()
  await f.app.database.set('xp_score_system', { key: 'platform' }, { active: false })
  const request = f.all(), preview = await f.modes.previewAll(request)
  assert.equal(preview.changes.length, 3)
  await f.modes.applyAll(request, preview.fingerprint, () => {})
  assert.equal((await f.app.database.get('xp_score_system', { key: 'platform' }))[0].active, false)
  assert.equal((await f.app.database.get('xp_person_preference', { profileId: f.own.profile.id }))[0].defaultScoreMode, 'shared')
  assert.ok((await f.app.database.get('xp_account_policy', { profileId: f.own.profile.id })).every(row => row.mode === 'shared'))
  assert.ok((await f.app.database.get('xp_subject_balance', {})).every(row => row.value === 7.5))
  const prior = await f.ledger.add('event', { accountId: f.own.account.id }, 7.5, { source: 'fixture', reason: 'reward', idempotencyKey: 'old-event' })
  assert.equal(prior.deduplicated, true)
  assert.equal(await f.ledger.get('event', { accountId: f.other.account.id }, {}), 7.5)
  const before = await snapshot(f.app)
  assert.equal((await f.modes.applyAll(request, preview.fingerprint, () => {})).deduplicated, true)
  assert.deepEqual(await snapshot(f.app), before)
  const now = new Date()
  await f.app.database.create('xp_score_system', { key: 'future', name: 'future', unit: '', scope: 'global', active: true, createdBy: 'fixture', createdAt: now, updatedAt: now })
  await f.lifecycle.initializeSystem('future')
  assert.equal((await f.app.database.get('xp_account_policy', { systemKey: 'future', profileId: f.own.profile.id }))[0].mode, 'shared')
})

it('keeps already-independent balances untouched while splitting only shared pools to one recipient', async () => {
  const f = await multiFixture()
  const single = { ...f.request('admin'), nextMode: 'shared' as const }
  const first = await f.modes.preview(single); await f.modes.apply(single, first.fingerprint, () => {})
  const unchanged = await f.app.database.get('xp_subject_balance', { platform: 'onebot' })
  const request = { ...f.all(), nextMode: 'independent' as const, retainedAccountId: f.other.account.id }
  const preview = await f.modes.previewAll(request)
  assert.equal(preview.changes.length, 1)
  await f.modes.applyAll(request, preview.fingerprint, () => {})
  assert.equal(await f.ledger.get('event', { accountId: f.own.account.id }, {}), 0)
  assert.equal(await f.ledger.get('event', { accountId: f.other.account.id }, {}), 7.5)
  assert.deepEqual(await f.app.database.get('xp_subject_balance', { platform: 'onebot' }), unchanged)
})

it('rejects stale all-system previews after a new system or a reward and rolls all changed pools back on failure', async () => {
  const f = await multiFixture()
  const request = f.all(), preview = await f.modes.previewAll(request)
  await f.ledger.add('event', { accountId: f.own.account.id }, 1, { source: 'fixture', reason: 'later' })
  await assert.rejects(f.modes.applyAll(request, preview.fingerprint, () => {}), /变化/)
  const fresh = await f.modes.previewAll(request)
  const now = new Date()
  await f.app.database.create('xp_score_system', { key: 'later', name: 'later', unit: '', scope: 'global', active: true, createdBy: 'fixture', createdAt: now, updatedAt: now })
  await f.lifecycle.initializeSystem('later')
  await assert.rejects(f.modes.applyAll(request, fresh.fingerprint, () => {}), /变化/)
  const last = await f.modes.previewAll(request)
  const before = await snapshot(f.app)
  const pref = await f.app.database.get('xp_person_preference', {})
  const driver = (f.app.database as any).getDriver('xp_account_operation')
  driver._run("CREATE TRIGGER all_fault BEFORE INSERT ON xp_account_operation WHEN NEW.kind='all-mode-conversion' BEGIN SELECT RAISE(FAIL, 'fixture fault'); END")
  await assert.rejects(f.modes.applyAll(request, last.fingerprint, () => {}))
  assert.deepEqual(await snapshot(f.app), before)
  assert.deepEqual(await f.app.database.get('xp_person_preference', {}), pref)
  driver._run('DROP TRIGGER all_fault')
  await f.modes.applyAll(request, last.fingerprint, () => {})
})

it('supports no-system preferences, rejects self sum/negative conversion and rechecks live occupancy', async () => {
  const empty = await fixture()
  await empty.app.database.remove('xp_account_policy', {})
  await empty.app.database.remove('xp_score_subject', {})
  await empty.app.database.remove('xp_score_system', {})
  const { systemKey, ...req } = empty.request()
  const zero = await empty.modes.previewAll(req)
  assert.equal(zero.changes.length, 0)
  await empty.modes.applyAll(req, zero.fingerprint, () => {})
  assert.equal((await empty.app.database.get('xp_person_preference', {}))[0].defaultScoreMode, 'independent')
  const f = await multiFixture()
  const self = { ...f.all(), actor: { platform: 'onebot', userId: 'own' } }
  await assert.rejects(f.modes.previewAll({ ...self, strategy: 'sum' }), /本人合并/)
  await f.ledger.add('event', { accountId: f.other.account.id }, -5, { source: 'fixture', reason: 'penalty' })
  await assert.rejects(f.modes.previewAll(self), /负分/)
  const admin = { ...f.all(), strategy: 'sum' as const }, preview = await f.modes.previewAll(admin)
  const blocked = new AccountModeStore(f.app.database, f.writes, async () => { throw new Error('occupied') })
  await assert.rejects(blocked.applyAll(admin, preview.fingerprint, () => {}), /occupied/)
  await f.modes.applyAll(admin, preview.fingerprint, () => {})
  assert.equal(await f.ledger.get('event', { accountId: f.own.account.id }, {}), 5.5)
})

it('derives actual self authority, rejects forged administrator status, sum and other-person requests', async () => {
  const { app, modes, request } = await fixture()
  const before = await snapshot(app)
  await assert.rejects(modes.preview({ ...request(), strategy: 'sum', actor: { ...request().actor, kind: 'administrator' } } as any), /本人合并/)
  await assert.rejects(modes.preview(request('other')), /本人/)
  assert.deepEqual(await snapshot(app), before)
  const change = request(), preview = await modes.preview(change)
  assert.equal(preview.request.actor.kind, 'self')
  await modes.apply(change, preview.fingerprint, () => {})
  assert.equal((await app.database.get('xp_account_policy', {}))[0].mode, 'independent')
})

it('requires administrator handling of negative balances and cannot turn negative self balances into zero', async () => {
  const { own, modes, ledger, request } = await fixture()
  await ledger.add('event', { accountId: own.account.id }, -3, { source: 'fixture', reason: 'penalty' })
  await assert.rejects(modes.preview(request()), /负分/)
  const change = request('admin'), preview = await modes.preview(change)
  await modes.apply(change, preview.fingerprint, () => {})
  assert.equal(await ledger.get('event', { accountId: own.account.id }, {}), -3)
})

it('rechecks demoted authority, occupancy and queued token expiry before mode writes', async () => {
  const { app, own, writes, modes, request } = await fixture()
  const change = request('admin'), preview = await modes.preview(change)
  const blocked = new AccountModeStore(app.database, writes, async scope => {
    assert.ok(scope.accountIds.includes(own.account.id)); throw new Error('occupied')
  })
  const before = await snapshot(app)
  await assert.rejects(blocked.apply(change, preview.fingerprint, () => {}), /occupied/)
  await assert.rejects(modes.apply(change, preview.fingerprint, () => { throw new Error('expired') }), /expired/)
  const binding = (await app.database.get('binding', { platform: 'onebot', pid: 'admin' }))[0]
  await app.database.set('user', { id: binding.aid }, { authority: 1 })
  await assert.rejects(modes.apply(change, preview.fingerprint, () => {}), /本人/)
  assert.deepEqual(await snapshot(app), before)
})
