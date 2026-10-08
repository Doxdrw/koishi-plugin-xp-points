import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { currentModels, seedCurrentPerson, createCurrentSystem, seedCurrentBalance, seedCurrentReward, bootstrapCurrentSchema } from './current-account-fixture'
import { SubjectLedgerStore, SubjectWriteCoordinator, type SubjectBatchRequest } from '../src/subject-ledger'
import type { AccountConversionRequest } from '../src/account-conversion'

const apps: App[] = []
const context = (idempotencyKey: string) => ({ platform: 'onebot', guildId: 'source',
  reason: 'game reward', source: 'fixture', idempotencyKey })
async function fixture() {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(currentModels)
  const systems = [
    { key: 'event', name: '活动', scope: 'guild' }, { key: 'global', name: '全局', scope: 'global' },
    { key: 'platform', name: '平台', scope: 'platform' },
  ] as const
  await app.start()
  apps.push(app)
  await bootstrapCurrentSchema(app.database)
  for (const system of systems) await createCurrentSystem(app.database, system)
  await app.database.create('xp_score_guild_alias', { systemKey: 'event', platform: 'onebot', sourceGuildId: 'source', targetGuildId: 'pool', createdAt: new Date(), updatedAt: new Date() })
  await app.database.createUser('onebot', 'admin', { authority: 2 })
  await app.database.createUser('onebot', 'main', { authority: 1 })
  const person = await seedCurrentPerson(app.database, 1, 'Example', [['onebot', 'main'], ['other', 'alt'], ['onebot', 'former']], systems)
  const subject = (await app.database.get('xp_score_subject', { profileId: person.profileId, systemKey: 'event' }))[0]
  await seedCurrentBalance(app.database, subject.id, 0.5, 'onebot', 'pool')
  const historical = await seedCurrentReward(app.database, subject.id, 'event', 0.5, 'historical', { platform: 'onebot', guildId: 'pool' })
  const accounts = await app.database.get('xp_account', {})
  const main = { accountId: accounts.find(row => row.userId === 'main')!.id }
  const alt = { accountId: accounts.find(row => row.userId === 'alt')!.id }
  const writes = new SubjectWriteCoordinator()
  const store = new SubjectLedgerStore(app.database, writes)
  const request = (nextMode: 'shared' | 'independent', extra: Partial<AccountConversionRequest> = {}): AccountConversionRequest => ({
    operationId: 'XPAC:' + randomUUID(), profileId: person.profileId, systemKey: 'event', nextMode,
    retainedAccountId: nextMode === 'independent' ? main.accountId : undefined, strategy: 'maximum',
    actor: { kind: 'administrator', platform: 'onebot', userId: 'admin' }, ...extra,
  })
  const convert = async (nextMode: 'shared' | 'independent', extra: Partial<AccountConversionRequest> = {}) => {
    const change = request(nextMode, extra)
    const preview = await store.previewConversion(change)
    return store.convert(change, preview.fingerprint, async () => {})
  }
  return { app, store, writes, person, historical, main, alt, request, convert }
}
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })
async function snapshot(app: App) {
  return Promise.all((['xp_subject_balance', 'xp_score_journal', 'xp_journal_subject', 'xp_person_preference'] as const)
    .map(table => app.database.get(table, {})))
}

describe('staged account-targeted subject ledger', () => {
  it('batch changes shared subjects once, independent subjects separately, and audits exact total impact', async () => {
    const { app, store, person, main, alt, convert } = await fixture()
    const batch = (operation: 'add' | 'set', operand: number): SubjectBatchRequest => ({
      operationId: 'XPAB:' + randomUUID(), systemKey: 'event', profileId: person.profileId, operation, operand,
      actor: { platform: 'onebot', userId: 'admin' }, context: { platform: 'onebot', guildId: 'source' }, reason: 'batch fixture',
    })
    const first = batch('add', 2), preview = await store.previewBatch(first)
    assert.equal(preview.changes.length, 1)
    assert.equal(preview.totalDelta, 2)
    const result = await store.applyBatch(first, preview.fingerprint, () => {})
    assert.equal(result.results.length, 1)
    assert.equal(await store.get('event', main, context('read')), 2.5)
    await convert('independent')
    const next = batch('add', 3), independent = await store.previewBatch(next)
    assert.equal(independent.changes.length, 3)
    assert.equal(independent.totalDelta, 9)
    await store.applyBatch(next, independent.fingerprint, () => {})
    assert.equal(await store.get('event', main, context('read')), 5.5)
    assert.equal(await store.get('event', alt, context('read')), 3)
    const set = batch('set', -1), setPreview = await store.previewBatch(set)
    assert.equal(setPreview.totalDelta, -14.5)
    await store.applyBatch(set, setPreview.fingerprint, () => {})
    assert.deepEqual((await store.overview('event', person.profileId, context('r'))).entries.map(row => row.value), [-1, -1, -1])
    const before = await snapshot(app)
    assert.equal((await store.applyBatch(set, setPreview.fingerprint, () => {})).deduplicated, true)
    assert.deepEqual(await snapshot(app), before)
  })

  it('batch refuses stale snapshots, foreign permissions, expiry and demotion before writing', async () => {
    const { app, store, person, main } = await fixture()
    const request: SubjectBatchRequest = { operationId: 'XPAB:' + randomUUID(), systemKey: 'event', profileId: person.profileId,
      operation: 'add', operand: 2, actor: { platform: 'onebot', userId: 'admin' },
      context: { platform: 'onebot', guildId: 'source' }, reason: 'batch fixture' }
    const preview = await store.previewBatch(request)
    await assert.rejects(store.previewBatch({ ...request, actor: { platform: 'onebot', userId: 'main' } }), /管理员/)
    await assert.rejects(store.applyBatch(request, preview.fingerprint, () => { throw new Error('expired') }), /expired/)
    await store.add('event', main, 1, context('batch-stale-plus'))
    await store.add('event', main, -1, context('batch-stale-minus'))
    const before = await snapshot(app)
    await assert.rejects(store.applyBatch(request, preview.fingerprint, () => {}), /已变化/)
    const fresh = await store.previewBatch(request)
    const binding = (await app.database.get('binding', { platform: 'onebot', pid: 'admin' }))[0]
    await app.database.set('user', { id: binding.aid }, { authority: 1 })
    await assert.rejects(store.applyBatch(request, fresh.fingerprint, () => {}), /管理员/)
    assert.deepEqual(await snapshot(app), before)
  })

  it('batch rolls back all earlier recipients when a later recipient or final audit fails', async () => {
    for (const fault of ['recipient', 'audit']) {
      const { app, store, person, convert } = await fixture()
      await convert('independent')
      const request: SubjectBatchRequest = { operationId: 'XPAB:' + randomUUID(), systemKey: 'event', profileId: person.profileId,
        operation: 'add', operand: 2, actor: { platform: 'onebot', userId: 'admin' },
        context: { platform: 'onebot', guildId: 'source' }, reason: 'batch fixture' }
      const preview = await store.previewBatch(request)
      const table = fault === 'recipient' ? 'xp_subject_balance' : 'xp_account_operation'
      const condition = fault === 'recipient' ? `NEW.subjectId='${preview.entries[1].subjectId}'` : "NEW.kind='score-batch'"
      ;(app.database as any).getDriver(table)._run(`CREATE TRIGGER batch_fault BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(FAIL, 'batch fault'); END`)
      const before = await snapshot(app)
      await assert.rejects(store.applyBatch(request, preview.fingerprint, () => {}))
      assert.deepEqual(await snapshot(app), before)
    }
  })

  it('batch simultaneous confirmations apply once and changing the payload cannot reuse its operation ID', async () => {
    const { app, store, person } = await fixture()
    const request: SubjectBatchRequest = { operationId: 'XPAB:' + randomUUID(), systemKey: 'event', profileId: person.profileId,
      operation: 'set', operand: 8, actor: { platform: 'onebot', userId: 'admin' },
      context: { platform: 'onebot', guildId: 'source' }, reason: 'batch fixture' }
    const preview = await store.previewBatch(request)
    const results = await Promise.all(Array.from({ length: 10 }, () => store.applyBatch(request, preview.fingerprint, () => {})))
    assert.equal(results.filter(row => !row.deduplicated).length, 1)
    const before = await snapshot(app)
    await assert.rejects(store.applyBatch({ ...request, operand: 9 }, preview.fingerprint, () => {}), /操作 ID/)
    assert.deepEqual(await snapshot(app), before)
  })

  it('shares one balance and switches independent account writes without affecting other systems', async () => {
    const { app, store, main, alt, person, convert } = await fixture()
    await store.add('event', alt, 2, context('shared'))
    assert.equal(await store.get('event', main, context('read')), 2.5)
    await assert.rejects((store.get as any)('event', { profileId: person.profileId }, context('read')), /请指定一个有效账号/)
    await convert('independent')
    await store.add('event', alt, 3, context('independent'))
    assert.equal(await store.get('event', main, context('read')), 2.5)
    assert.equal(await store.get('event', alt, context('read')), 3)
    await assert.rejects((store.get as any)('event', { profileId: person.profileId }, context('read')), /请指定一个有效账号/)
    await assert.rejects((store.add as any)('event', { profileId: person.profileId }, 1, context('ambiguous')), /请指定一个有效账号/)
    await store.add('global', main, 1, context('global'))
    assert.equal(await store.get('global', alt, {}), 1)
    assert.equal((app.model as any).tables.xp_score_balance, undefined)
  })

  it('keeps global/platform/guild and applied aliases isolated while retaining source context', async () => {
    const { app, store, main } = await fixture()
    await store.add('global', main, 2, context('g'))
    await store.add('platform', main, 3, context('p'))
    await store.add('event', main, 4, context('s'))
    assert.equal(await store.get('global', main, { platform: 'other' }), 2)
    assert.equal(await store.get('platform', main, { platform: 'other' }), 0)
    assert.equal(await store.get('event', main, { platform: 'onebot', guildId: 'pool' }), 4.5)
    assert.equal(await store.get('event', main, { platform: 'other', guildId: 'source' }), 0)
    const last = (await app.database.get('xp_score_journal', { reason: 'game reward', operand: 4 }))[0]
    assert.equal(last.guildId, 'pool')
    assert.equal(last.originGuildId, 'source')
    await assert.rejects(store.get('event', main, {}), /平台/)
  })

  it('binds new reward retries to their actual account and survives multiple mode transitions', async () => {
    const { app, store, main, alt, person, convert } = await fixture()
    const first = await store.add('event', alt, 0.1, context('actual'))
    await convert('independent')
    const before = await snapshot(app)
    assert.deepEqual(await store.add('event', alt, 0.1, context('actual')), { ...first, deduplicated: true })
    await assert.rejects(store.add('event', main, 0.1, context('actual')), /幂等键/)
    await assert.rejects((store.add as any)('event', { profileId: person.profileId }, 0.1, context('actual')), /请指定一个有效账号/)
    assert.deepEqual(await snapshot(app), before)
    await convert('shared', { strategy: 'sum' })
    assert.equal((await store.add('event', alt, 0.1, context('actual'))).deduplicated, true)
    assert.equal(await store.get('event', alt, context('read')), 0.6)
  })

  it('serializes 20 first writes across multiple handles and deduplicates simultaneous retries', async () => {
    const { app, store, writes, main } = await fixture()
    const second = new SubjectLedgerStore(app.database, writes)
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? store : second).add('platform', main, 0.5, context('concurrent-' + index))))
    assert.equal(new Set(results.map(row => row.journalId)).size, 20)
    assert.equal(await store.get('platform', main, context('read')), 10)
    const retries = await Promise.all(Array.from({ length: 20 }, () => second.add('platform', main, 0.5, context('concurrent-0'))))
    assert.ok(retries.every(row => row.deduplicated))
    assert.equal(await store.get('platform', main, context('read')), 10)
  })

  it('invalidates a conversion preview after a queued reward and preserves the new reward', async () => {
    const { store, main, request } = await fixture()
    const change = request('independent')
    const preview = await store.previewConversion(change)
    const reward = store.add('event', main, 1, context('between'))
    const conversion = store.convert(change, preview.fingerprint, async () => {})
    assert.equal((await reward).after, 1.5)
    await assert.rejects(conversion, /重新预览/)
    assert.equal(await store.get('event', main, context('read')), 1.5)
  })

  it('rolls back balance, journal and account link on each write failure', async () => {
    for (const table of ['xp_subject_balance', 'xp_score_journal', 'xp_journal_subject']) {
      const { app, store, main } = await fixture()
      const before = await snapshot(app)
      ;(app.database as any).getDriver(table)._run(
        `CREATE TRIGGER ledger_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'fixture fault'); END`)
      await assert.rejects(store.add('platform', main, 1, context('fault')))
      assert.deepEqual(await snapshot(app), before)
    }
  })

  it('rejects finite overflow, conflicts and disabled-system writes while permitting exact old retries', async () => {
    const { app, store, main } = await fixture()
    await store.set('platform', main, Number.MAX_VALUE, context('large'))
    const before = await snapshot(app)
    await assert.rejects(store.add('platform', main, Number.MAX_VALUE, context('overflow')), /有限数值/)
    await assert.rejects(store.set('platform', main, Infinity, context('invalid')), /有限数值/)
    await assert.rejects(store.set('platform', main, 1, context('large')), /幂等键/)
    assert.deepEqual(await snapshot(app), before)
    await app.database.set('xp_score_system', { key: 'platform' }, { active: false })
    assert.equal((await store.set('platform', main, Number.MAX_VALUE, context('large'))).deduplicated, true)
    await assert.rejects(store.add('platform', main, 1, context('disabled')), /停用/)
  })

  it('preserves person revision across locking and rejects missing historical links', async () => {
    const { app, store, main, person, historical } = await fixture()
    await app.database.set('xp_person_preference', { profileId: person.profileId }, { revision: 9 })
    await store.add('event', main, 1, context('lock'))
    assert.equal((await app.database.get('xp_person_preference', {}))[0].revision, 9)
    await app.database.remove('xp_journal_subject', { journalId: historical.journalId })
    const before = await snapshot(app)
    await assert.rejects(store.add('event', main, 0.5, context('historical')), /安全重试/)
    assert.deepEqual(await snapshot(app), before)
  })

  it('returns one shared row or separate labeled account rows and the personal maximum without writing', async () => {
    const { app, store, main, alt, person, convert } = await fixture()
    const shared = await store.leaderboard('event', context('read'))
    assert.equal(shared.length, 1)
    assert.equal(shared[0].label, null)
    assert.equal(shared[0].identities.length, 3)
    await convert('independent')
    await store.set('event', alt, 7, context('alt score'))
    const before = await snapshot(app)
    const entries = await store.leaderboard('event', { platform: 'onebot', guildId: 'pool' })
    assert.equal(entries.length, 3)
    assert.deepEqual(entries.map(row => row.value), [7, 0.5, 0])
    assert.ok(entries.every(row => row.nickname === 'Example' && row.label && row.identities.length === 1))
    const overview = await store.overview('event', person.profileId, context('read'))
    assert.equal(overview.maximum, 7)
    assert.equal(overview.entries.find(row => row.accountId === main.accountId)!.value, 0.5)
    assert.deepEqual(await snapshot(app), before)
  })

  it('rejects mixed target identities and missing active subject invariants without guessing', async () => {
    const { app, store, main, person } = await fixture()
    await assert.rejects((store.add as any)('event', { ...main, profileId: person.profileId }, 1, context('mixed')), /请指定一个有效账号/)
    await assert.rejects(store.get('event', { accountId: '' }, context('read')), /有效账号/)
    await app.database.set('xp_score_subject', { systemKey: 'event', active: true }, { active: false })
    await assert.rejects(store.get('event', main, context('read')), /不完整/)
    await assert.rejects(store.leaderboard('event', context('read')), /不一致/)
  })

  it('invalidates a preview even if new rewards leave the balance unchanged', async () => {
    const { store, main, request } = await fixture()
    const change = request('independent')
    const preview = await store.previewConversion(change)
    await store.add('event', main, 1, context('up'))
    await store.add('event', main, -1, context('down'))
    assert.equal(await store.get('event', main, context('read')), 0.5)
    await assert.rejects(store.convert(change, preview.fingerprint, async () => {}), /重新预览/)
  })
})
