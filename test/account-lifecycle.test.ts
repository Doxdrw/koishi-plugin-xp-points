import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { registerModels } from '../src/model'
import { registerAccountModels } from '../src/account-model'
import { AccountLifecycleStore, normalizeAccountDefaults } from '../src/account-lifecycle'
import { SubjectLedgerStore, SubjectWriteCoordinator } from '../src/subject-ledger'

const apps: App[] = []
const tables = ['xp_profile', 'xp_identity', 'xp_account', 'xp_person_preference', 'xp_account_policy', 'xp_score_subject',
  'xp_subject_balance', 'xp_score_journal', 'xp_journal_subject', 'xp_account_operation', 'xp_account_schema'] as const
const input = (userId: string, suggestedNickname?: string) => ({ platform: 'onebot', userId, suggestedNickname })
async function fixture(bootstrap = true) {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(registerModels)
  app.plugin(registerAccountModels)
  await app.start()
  apps.push(app)
  const writes = new SubjectWriteCoordinator()
  const lifecycle = new AccountLifecycleStore(app.database, writes)
  const ledger = new SubjectLedgerStore(app.database, writes)
  const createSystem = async (key: string) => {
    const now = new Date()
    await app.database.create('xp_score_system', { key, name: key, scope: 'guild', unit: '分', active: true,
      createdBy: 'fixture', createdAt: now, updatedAt: now })
  }
  if (bootstrap) await lifecycle.bootstrap()
  return { app, writes, lifecycle, ledger, createSystem }
}
const snapshot = (app: App) => Promise.all(tables.map(table => app.database.get(table, {})))
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

describe('staged account lifecycle initialization', () => {
  it('persists a person default with no systems and inherits it in future systems despite changed config', async () => {
    const { app, writes, createSystem } = await fixture()
    const independent = new AccountLifecycleStore(app.database, writes, { mode: 'independent' })
    const own = await independent.ensureIdentity(input('own'))
    assert.equal((await app.database.get('xp_person_preference', { profileId: own.profile.id }))[0].defaultScoreMode, 'independent')
    assert.equal(own.policies.length, 0)
    await createSystem('later')
    const shared = new AccountLifecycleStore(app.database, writes, { mode: 'shared' })
    await shared.initializeSystem('later')
    assert.equal((await app.database.get('xp_account_policy', { profileId: own.profile.id }))[0].mode, 'independent')
    assert.deepEqual(await app.database.get('xp_subject_balance', {}), [])
  })

  it('backfills only missing defaults from uniform or mixed policies, preserving all balances and choices', async () => {
    const { app, lifecycle, writes, createSystem } = await fixture()
    await createSystem('a'); await createSystem('b')
    const own = await lifecycle.ensureIdentity(input('old'))
    const id = own.profile.id
    await app.database.set('xp_person_preference', { profileId: id }, { defaultScoreMode: null })
    const changedConfig = new AccountLifecycleStore(app.database, writes, { mode: 'independent' })
    const before = await app.database.get('xp_account_policy', {})
    await changedConfig.bootstrap()
    assert.equal((await app.database.get('xp_person_preference', { profileId: id }))[0].defaultScoreMode, 'shared')
    assert.deepEqual(await app.database.get('xp_account_policy', {}), before)
    // A singleton independent system has one account subject and remains valid.
    await app.database.set('xp_account_policy', { profileId: id, systemKey: 'b' }, { mode: 'independent' })
    await app.database.set('xp_score_subject', { profileId: id, systemKey: 'b' }, { accountId: own.account.id })
    await app.database.set('xp_person_preference', { profileId: id }, { defaultScoreMode: null })
    const mixed = await app.database.get('xp_account_policy', {})
    await changedConfig.bootstrap()
    assert.equal((await app.database.get('xp_person_preference', { profileId: id }))[0].defaultScoreMode, 'independent')
    assert.deepEqual(await app.database.get('xp_account_policy', {}), mixed)
    const frozen = await snapshot(app)
    await lifecycle.bootstrap()
    assert.deepEqual(await snapshot(app), frozen)
  })

  it('bootstraps an empty installation without old user fields and refuses uninitialized stores', async () => {
    const { app, lifecycle } = await fixture()
    const before = await snapshot(app)
    await lifecycle.bootstrap()
    assert.deepEqual(await snapshot(app), before)
    assert.equal((await app.database.get('xp_score_system', {})).length, 0)
    for (const field of ['nickname', 'exp', 'exp_keju']) assert.equal((app.model as any).tables.user.fields[field], undefined)
    const old = await fixture(false)
    await old.app.database.create('xp_profile', { nickname: 'Existing', automatic: false, createdAt: new Date(), updatedAt: new Date() })
    const oldBefore = await snapshot(old.app)
    await assert.rejects(old.lifecycle.bootstrap(), /账号数据结构尚未初始化|版本不兼容|标记缺失/)
    assert.deepEqual(await snapshot(old.app), oldBefore)
    await assert.rejects(old.lifecycle.ensureIdentity(input('new')), /账号数据结构尚未初始化|版本不兼容|标记缺失/)
  })

  it('uses suggested names, never auto-links duplicate names, and freezes maintained names', async () => {
    const { app, lifecycle } = await fixture()
    const first = await lifecycle.ensureIdentity(input('11112222', 'Example'))
    const second = await lifecycle.ensureIdentity(input('33332222', 'Example'))
    const third = await lifecycle.ensureIdentity(input('44442222', 'Example'))
    assert.deepEqual([first.profile.nickname, second.profile.nickname, third.profile.nickname], ['Example', 'Example#2222', 'Example#2222-2'])
    assert.equal(new Set([first.profile.id, second.profile.id, third.profile.id]).size, 3)
    assert.equal((await lifecycle.ensureIdentity(input('11112222', 'New platform name'))).profile.nickname, 'Example')
    const placeholder = await lifecycle.ensureIdentity(input('unknown'))
    assert.equal(placeholder.profile.nickname, 'unknown')
    assert.equal((await lifecycle.ensureIdentity(input('unknown', 'Known'))).profile.nickname, 'Known')
    const managed = await lifecycle.ensureIdentity(input('frozen'))
    await app.database.set('xp_profile', { id: managed.profile.id }, { automatic: false })
    assert.equal((await lifecycle.ensureIdentity(input('frozen', 'Updated'))).profile.nickname, 'frozen')
  })

  it('initializes and freezes account names separately, repairing only automatic ID placeholders', async () => {
    const { app, lifecycle } = await fixture()
    const first = await lifecycle.ensureIdentity(input('first', 'FirstName'))
    assert.equal(first.account.nickname, 'FirstName')
    assert.equal(first.account.nicknameStatus, 'automatic')
    assert.equal((await lifecycle.ensureIdentity(input('first', 'Changed'))).account.nickname, 'FirstName')
    const placeholder = await lifecycle.ensureIdentity(input('placeholder'))
    assert.equal((await lifecycle.ensureIdentity(input('placeholder', 'KnownName'))).account.nickname, 'KnownName')
    await app.database.set('xp_account', { id: placeholder.account.id }, { nickname: 'placeholder', nicknameStatus: 'managed' })
    assert.equal((await lifecycle.ensureIdentity(input('placeholder', 'Again'))).account.nickname, 'placeholder')
    await app.database.set('xp_account', { id: first.account.id }, { nicknameStatus: 'unknown' })
    assert.equal((await lifecycle.ensureIdentity(input('first', 'Guessed'))).account.nickname, 'FirstName')
  })

  it('creates complete zero-score subjects for all systems and preserves existing policy under new defaults', async () => {
    const { app, lifecycle, ledger, writes, createSystem } = await fixture()
    await createSystem('first')
    const one = await lifecycle.ensureIdentity(input('one', 'One'))
    assert.equal(one.policies[0].mode, 'shared')
    assert.equal((await app.database.get('xp_person_preference', { profileId: one.profile.id }))[0].primaryAccountId, null)
    const independent = new AccountLifecycleStore(app.database, writes, { mode: 'independent', combineStrategy: 'sum' })
    const two = await independent.ensureIdentity(input('two', 'Two'))
    assert.equal(two.policies[0].mode, 'independent')
    assert.equal((await independent.ensureIdentity(input('one'))).policies[0].mode, 'shared')
    assert.equal(await ledger.get('first', { accountId: one.account.id }, { platform: 'onebot', guildId: 'g' }), 0)
    await createSystem('second')
    await independent.initializeSystem('second')
    assert.equal((await app.database.get('xp_account_policy', { systemKey: 'second' })).length, 2)
    assert.equal((await app.database.get('xp_account_policy', { systemKey: 'first', profileId: one.profile.id }))[0].mode, 'shared')
    assert.deepEqual(await app.database.get('xp_subject_balance', {}), [])
    const before = await snapshot(app)
    await lifecycle.initializeSystem('second')
    assert.deepEqual(await snapshot(app), before)
  })

  it('serializes 20 new-account requests across lifecycle instances with no orphan people', async () => {
    const { app, lifecycle, writes, createSystem } = await fixture()
    await createSystem('event')
    const other = new AccountLifecycleStore(app.database, writes)
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? lifecycle : other).ensureIdentity(input('same', 'Example'))))
    assert.equal(new Set(results.map(row => row.profile.id)).size, 1)
    assert.equal(new Set(results.map(row => row.account.id)).size, 1)
    for (const table of ['xp_profile', 'xp_identity', 'xp_account', 'xp_account_policy', 'xp_score_subject'] as const) {
      assert.equal((await app.database.get(table, {})).length, 1)
    }
  })

  it('rolls back every new-account write boundary and can retry after the fault is removed', async () => {
    for (const table of ['xp_profile', 'xp_identity', 'xp_account', 'xp_person_preference', 'xp_account_policy', 'xp_score_subject']) {
      const { app, lifecycle, createSystem } = await fixture()
      await createSystem('event')
      const before = await snapshot(app)
      const driver = (app.database as any).getDriver(table)
      driver._run(`CREATE TRIGGER lifecycle_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'fixture fault'); END`)
      await assert.rejects(lifecycle.ensureIdentity(input('new', 'Example')))
      assert.deepEqual(await snapshot(app), before, table)
      driver._run('DROP TRIGGER lifecycle_fault')
      assert.equal((await lifecycle.ensureIdentity(input('new', 'Example'))).profile.nickname, 'Example')
    }
  })

  it('does not repair missing account rows or resurrect subjects after policy deletion', async () => {
    const { app, lifecycle, createSystem } = await fixture()
    await createSystem('event')
    const one = await lifecycle.ensureIdentity(input('one'))
    await app.database.remove('xp_account_policy', { profileId: one.profile.id })
    const before = await snapshot(app)
    await assert.rejects(lifecycle.ensureIdentity(input('one')), /历史计分主体/)
    assert.deepEqual(await snapshot(app), before)
    await app.database.remove('xp_account', { id: one.account.id })
    await assert.rejects(lifecycle.ensureIdentity(input('one')), /不一致/)
  })

  it('rolls back system initialization for all people when a later person cannot initialize', async () => {
    const { app, lifecycle, createSystem } = await fixture()
    await lifecycle.ensureIdentity(input('one'))
    const two = await lifecycle.ensureIdentity(input('two'))
    await createSystem('new')
    const driver = (app.database as any).getDriver('xp_score_subject')
    driver._run(`CREATE TRIGGER system_fault BEFORE INSERT ON xp_score_subject WHEN NEW.profileId = ${two.profile.id} BEGIN SELECT RAISE(FAIL, 'fixture fault'); END`)
    const before = await snapshot(app)
    await assert.rejects(lifecycle.initializeSystem('new'))
    assert.deepEqual(await snapshot(app), before)
  })

  it('validates defaults and refuses partial bootstrap without writing', async () => {
    assert.deepEqual(normalizeAccountDefaults(), { mode: 'shared', combineStrategy: 'maximum' })
    assert.throws(() => normalizeAccountDefaults({ mode: 'invalid' as any }), /无效/)
    const { app, lifecycle } = await fixture(false)
    await app.database.create('xp_account', { id: 'partial', platform: 'onebot', userId: 'x', label: '账号1', createdAt: new Date() })
    const before = await snapshot(app)
    await assert.rejects(lifecycle.bootstrap(), /账号数据结构尚未初始化|版本不兼容|标记缺失/)
    assert.deepEqual(await snapshot(app), before)
  })
})
