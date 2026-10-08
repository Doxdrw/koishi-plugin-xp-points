import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { currentModels, seedCurrentPerson, createCurrentSystem, seedCurrentBalance, bootstrapCurrentSchema } from './current-account-fixture'
import { AccountMaintenanceStore } from '../src/account-maintenance'
import { SubjectWriteCoordinator } from '../src/subject-ledger'

const apps: App[] = []
const actor = (userId: string) => ({ platform: 'onebot', userId })
async function fixture() {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(currentModels)
  await app.start()
  apps.push(app)
  await bootstrapCurrentSchema(app.database)
  const system = { key: 'event', name: '活动', scope: 'global' } as const
  await createCurrentSystem(app.database, system)
  const person = await seedCurrentPerson(app.database, 1, 'Example', [['onebot', 'main'], ['onebot', 'alt']], [system])
  const other = await seedCurrentPerson(app.database, 2, 'Other', [['onebot', 'other']], [system])
  const subject = (await app.database.get('xp_score_subject', { profileId: person.profileId, systemKey: 'event' }))[0]
  await seedCurrentBalance(app.database, subject.id, 8)
  for (const [id, authority] of [['main', 2], ['alt', 1], ['other', 1], ['admin', 2], ['blocked', 0]] as const) {
    await app.database.createUser('onebot', id, { authority })
  }
  const accounts = await app.database.get('xp_account', {})
  const main = accounts.find(row => row.userId === 'main')!
  const alt = accounts.find(row => row.userId === 'alt')!
  const otherAccount = accounts.find(row => row.userId === 'other')!
  await app.database.set('xp_account', { id: main.id }, { nicknameStatus: 'unknown' })
  await app.database.set('xp_account', { id: otherAccount.id }, { nicknameStatus: 'managed' })
  main.nicknameStatus = 'unknown'
  otherAccount.nicknameStatus = 'managed'
  const writes = new SubjectWriteCoordinator()
  const store = new AccountMaintenanceStore(app.database, writes, async () => {})
  return { app, store, writes, person, other, main, alt, otherAccount }
}
const snapshot = (app: App) => Promise.all((['xp_profile', 'xp_identity', 'xp_account', 'xp_person_preference',
  'xp_score_subject', 'xp_subject_balance', 'xp_account_operation', 'xp_profile_merge'] as const).map(table => app.database.get(table, {})))
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

describe('staged pure rename and account metadata', () => {
  it('preserves independent account names through person rename and self label changes', async () => {
    const { app, store, person, main, alt, otherAccount } = await fixture()
    assert.equal(main.nicknameStatus, 'unknown')
    assert.equal(otherAccount.nicknameStatus, 'managed')
    await assert.rejects(store.setNickname(actor('alt'), person.profileId, alt.id, 'Cannot self rename'), /管理员/)
    await store.setNickname(actor('admin'), person.profileId, alt.id, 'AlternateName')
    await store.rename(actor('admin'), person.profileId, 'NewPersonName')
    await store.setLabel(actor('alt'), person.profileId, alt.id, 'LabelOnly')
    const updated = (await app.database.get('xp_account', { id: alt.id }))[0]
    assert.equal(updated.nickname, 'AlternateName')
    assert.equal(updated.nicknameStatus, 'managed')
    assert.equal(updated.label, 'LabelOnly')
    const before = await snapshot(app)
    await store.setNickname(actor('admin'), person.profileId, alt.id, 'AlternateName')
    assert.deepEqual(await snapshot(app), before)
    await assert.rejects(store.setNickname(actor('admin'), person.profileId, otherAccount.id, 'Wrong owner'), /不属于/)
    await assert.rejects(store.setNickname(actor('admin'), person.profileId, alt.id, '\n'), /不能为空/)
    assert.deepEqual(await snapshot(app), before)
  })

  it('rolls back account nickname and status with audit failure', async () => {
    const { app, store, person, alt } = await fixture()
    ;(app.database as any).getDriver('xp_account_operation')._run(
      "CREATE TRIGGER nickname_fault BEFORE INSERT ON xp_account_operation BEGIN SELECT RAISE(FAIL, 'fixture fault'); END")
    const before = await snapshot(app)
    await assert.rejects(store.setNickname(actor('admin'), person.profileId, alt.id, 'NotSaved'))
    assert.deepEqual(await snapshot(app), before)
  })

  it('renames the whole person without detaching accounts or touching scores and returns collision without mutation', async () => {
    const { app, store, person, other } = await fixture()
    const identities = await app.database.get('xp_identity', {})
    const balances = await app.database.get('xp_subject_balance', {})
    assert.equal((await store.rename(actor('admin'), person.profileId, 'Renamed')).kind, 'renamed')
    assert.deepEqual(await app.database.get('xp_identity', {}), identities)
    assert.deepEqual(await app.database.get('xp_subject_balance', {}), balances)
    const before = await snapshot(app)
    assert.deepEqual(await store.rename(actor('admin'), person.profileId, 'Other'), {
      kind: 'association-required', profileId: person.profileId, targetProfileId: other.profileId, nickname: 'Other',
    })
    assert.deepEqual(await snapshot(app), before)
    assert.equal((await store.rename(actor('admin'), person.profileId, 'Renamed')).kind, 'unchanged')
    assert.deepEqual(await snapshot(app), before)
  })

  it('does not grant a secondary account its primary account authority', async () => {
    const { app, store, person, main, alt, otherAccount } = await fixture()
    const before = await snapshot(app)
    await assert.rejects(store.rename(actor('alt'), person.profileId, 'Not allowed'), /管理员/)
    await assert.rejects(store.setLabel(actor('other'), person.profileId, alt.id, 'Hijack'), /管理员|本人/)
    await assert.rejects(store.setPrimary(actor('blocked'), person.profileId, main.id), /权限/)
    await assert.rejects(store.setPrimary(actor('unknown'), person.profileId, main.id), /权限/)
    await assert.rejects(store.setPrimary(actor('alt'), person.profileId, otherAccount.id), /已关联/)
    assert.deepEqual(await snapshot(app), before)
    await store.setPrimary(actor('alt'), person.profileId, main.id)
    await store.setLabel(actor('alt'), person.profileId, alt.id, '小号')
    assert.equal((await app.database.get('xp_person_preference', { profileId: person.profileId }))[0].primaryAccountId, main.id)
    const binding = (await app.database.get('binding', { platform: 'onebot', pid: 'alt' }))[0]
    assert.equal((await app.database.get('user', { id: binding.aid }))[0].authority, 1)
  })

  it('enforces unique labels and persists operation actor and revision without changing balances', async () => {
    const { app, store, person, main, alt } = await fixture()
    await store.setLabel(actor('alt'), person.profileId, alt.id, 'Alternate')
    const before = await snapshot(app)
    await assert.rejects(store.setLabel(actor('admin'), person.profileId, main.id, 'Alternate'), /重复/)
    await assert.rejects(store.setLabel(actor('alt'), person.profileId, alt.id, '\n'), /不能为空/)
    assert.deepEqual(await snapshot(app), before)
    const op = (await app.database.get('xp_account_operation', { kind: 'account-label' }))[0]
    assert.equal(op.actorUserId, 'alt')
    assert.equal(JSON.parse(op.snapshot).after.label, 'Alternate')
    assert.equal((await app.database.get('xp_person_preference', { profileId: person.profileId }))[0].revision, 1)
  })

  it('rechecks actual permission and occupancy on every operation', async () => {
    const { app, store, writes, person, alt } = await fixture()
    const binding = (await app.database.get('binding', { platform: 'onebot', pid: 'admin' }))[0]
    await app.database.set('user', { id: binding.aid }, { authority: 1 })
    await assert.rejects(store.rename(actor('admin'), person.profileId, 'Blocked'), /管理员/)
    const blocked = new AccountMaintenanceStore(app.database, writes, async scope => {
      assert.equal(scope.profileId, person.profileId)
      assert.ok(scope.accountIds.includes(alt.id))
      throw new Error('busy game')
    })
    const before = await snapshot(app)
    await assert.rejects(blocked.setLabel(actor('alt'), person.profileId, alt.id, 'Blocked'), /busy game/)
    assert.deepEqual(await snapshot(app), before)
  })

  it('rolls back metadata and revision on audit failure', async () => {
    const { app, store, person, alt } = await fixture()
    ;(app.database as any).getDriver('xp_account_operation')._run(
      "CREATE TRIGGER metadata_fault BEFORE INSERT ON xp_account_operation BEGIN SELECT RAISE(FAIL, 'fixture fault'); END")
    const before = await snapshot(app)
    await assert.rejects(store.rename(actor('admin'), person.profileId, 'Renamed'))
    await assert.rejects(store.setLabel(actor('alt'), person.profileId, alt.id, 'Alternate'))
    await assert.rejects(store.setPrimary(actor('alt'), person.profileId, alt.id))
    assert.deepEqual(await snapshot(app), before)
  })
})
