import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { registerModels } from '../src/model'
import { registerAccountModels } from '../src/account-model'
import { AccountLifecycleStore } from '../src/account-lifecycle'
import { AccountOperations } from '../src/account-operations'
import { SubjectLedgerStore } from '../src/subject-ledger'
import { SubjectWriteCoordinator } from '../src/mutation-coordinator'

const apps: App[] = []
const admin = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'group', isDirect: false }
const actual = (userId: string) => ({ platform: 'onebot', userId })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture() {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(registerModels); app.plugin(registerAccountModels)
  await app.start(); apps.push(app)
  const writes = new SubjectWriteCoordinator(), lifecycle = new AccountLifecycleStore(app.database, writes)
  await lifecycle.bootstrap()
  const now = new Date()
  await app.database.create('xp_score_system', { key: 'event', name: '活动', unit: '分', scope: 'global',
    active: true, createdBy: 'fixture', createdAt: now, updatedAt: now })
  const one = await lifecycle.ensureIdentity({ ...actual('one'), suggestedNickname: 'Alpha' })
  const two = await lifecycle.ensureIdentity({ ...actual('two'), suggestedNickname: 'Beta' })
  for (const [id, authority] of [['admin', 2], ['one', 1], ['two', 1]] as const) {
    await app.database.createUser('onebot', id, { authority })
  }
  let clock = 0
  const ops = new AccountOperations(app.database, writes, () => clock)
  const ledger = new SubjectLedgerStore(app.database, writes)
  const mode = () => ({ profileId: one.profile.id, systemKey: 'event', nextMode: 'independent' as const,
    retainedAccountId: one.account.id, strategy: 'maximum' as const })
  const association = () => ({ kind: 'merge-persons' as const, sourceProfileId: one.profile.id, targetProfileId: two.profile.id,
    systems: [{ systemKey: 'event', mode: 'shared' as const, strategy: 'maximum' as const }] })
  const batch = () => ({ profileId: one.profile.id, systemKey: 'event', operation: 'add' as const, operand: 3,
    context: {}, reason: 'administrator award' })
  return { app, writes, one, two, ops, ledger, mode, association, batch, advance: (ms: number) => { clock += ms } }
}
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

it('binds real transaction previews to the original session and ignores a forged request actor', async () => {
  const { app, ops, one, mode } = await fixture()
  const own = { ...admin, userId: 'one' }
  await assert.rejects(ops.previewMode(own, { ...mode(), strategy: 'sum', actor: actual('admin') } as any), /本人合并/)
  const preview = await ops.previewMode(own, mode())
  for (const changed of [{ ...own, userId: 'two' }, { ...own, channelId: 'other' }, { ...own, selfId: 'other' }, { ...own, isDirect: true }]) {
    await assert.rejects(ops.confirm(changed, preview.token), /原操作者/)
  }
  assert.equal((await app.database.get('xp_account_policy', { profileId: one.profile.id }))[0].mode, 'shared')
  assert.equal((await ops.confirm(own, preview.token)).kind, 'mode')
  assert.equal((await app.database.get('xp_account_policy', { profileId: one.profile.id }))[0].mode, 'independent')
  await assert.rejects(ops.confirm(own, preview.token), /已经使用/)
})

it('rejects a relation confirmation when a game starts after its preview, then allows a fresh preview after release', async () => {
  const { app, ops, one, two, association } = await fixture()
  const proposal = await ops.previewAssociation(admin, association())
  const game = ops.registerConsumer('example-game')
  const lease = await game.acquire([actual('one'), actual('one')])
  assert.deepEqual(lease.accounts, [{ accountId: one.account.id, profileId: one.profile.id, ...actual('one'), nickname: 'Alpha' }])
  await assert.rejects(ops.confirm(admin, proposal.token), /example-game/)
  await assert.rejects(ops.rename(actual('admin'), one.profile.id, 'Changed'), /example-game/)
  assert.equal((await app.database.get('xp_identity', actual('one')))[0].profileId, one.profile.id)
  lease.release(); lease.release()
  const fresh = await ops.previewAssociation(admin, association())
  await ops.confirm(admin, fresh.token)
  const current = await game.acquire([actual('one'), actual('two')])
  assert.deepEqual(current.accounts.map(row => row.profileId), [two.profile.id, two.profile.id])
  assert.deepEqual(current.accounts.map(row => row.nickname), ['Beta', 'Beta'])
  await assert.rejects(ops.setNickname(actual('admin'), two.profile.id, one.account.id, 'Own name'), /example-game/)
  current.release(); game.dispose()
})

it('keeps multiple consumer leases until settlement but still permits scoring while occupied', async () => {
  const { ops, ledger, one, mode } = await fixture()
  const first = ops.registerConsumer('game'), second = ops.registerConsumer('quiz')
  const a = await first.acquire([actual('one')]), b = await second.acquire([actual('one')])
  await ledger.add('event', { accountId: one.account.id }, 2.5, { source: 'game', reason: 'settlement', idempotencyKey: 'match-award' })
  a.release()
  await assert.rejects(ops.previewMode(admin, mode()), /quiz/)
  b.release()
  const preview = await ops.previewMode(admin, mode())
  await ops.confirm(admin, preview.token)
  assert.equal(await ledger.get('event', { accountId: one.account.id }, {}), 2.5)
})

it('checks occupancy after queue wait, rejects stale handles, and does not release a replacement registration', async () => {
  const { ops, writes, mode } = await fixture()
  const old = ops.registerConsumer('game')
  const blocker = deferred()
  const held = writes.run(() => blocker.promise)
  const pending = old.acquire([actual('one')])
  old.dispose()
  const replacement = ops.registerConsumer('game')
  blocker.resolve(); await held
  await assert.rejects(pending, /注销/)
  const lease = await replacement.acquire([actual('one')])
  old.dispose()
  await assert.rejects(ops.previewMode(admin, mode()), /game/)
  lease.release()
  const preview = await ops.previewMode(admin, mode())
  await ops.confirm(admin, preview.token)
})

it('uses exact pasted tokens for atomic batches, rechecks demotion, and single-flights concurrent confirmations', async () => {
  const { app, ops, ledger, one, batch } = await fixture()
  const blocked = await ops.previewBatch(admin, batch())
  const binding = (await app.database.get('binding', { platform: admin.platform, pid: admin.userId }))[0]
  await app.database.set('user', { id: binding.aid }, { authority: 1 })
  await assert.rejects(ops.confirm(admin, blocked.token), /管理员/)
  assert.equal(await ledger.get('event', { accountId: one.account.id }, {}), 0)
  await app.database.set('user', { id: binding.aid }, { authority: 2 })
  const preview = await ops.previewBatch(admin, batch())
  assert.equal(ops.matchesConfirmation(preview.token + ' extra'), false)
  const results = await Promise.all(Array.from({ length: 10 }, () => ops.confirm(admin, preview.token)))
  assert.equal(results.length, 10)
  assert.equal(await ledger.get('event', { accountId: one.account.id }, {}), 3)
  assert.equal((await app.database.get('xp_account_operation', { kind: 'score-batch' })).length, 1)
})

it('expires queued operations without writes and cancels only the original session pending tokens', async () => {
  const { ops, writes, ledger, one, batch, advance } = await fixture()
  const expired = await ops.previewBatch(admin, batch())
  const blocker = deferred()
  const held = writes.run(() => blocker.promise)
  const queued = ops.confirm(admin, expired.token)
  advance(300_000); blocker.resolve(); await held
  await assert.rejects(queued, /过期/)
  assert.equal(await ledger.get('event', { accountId: one.account.id }, {}), 0)
  const first = await ops.previewBatch(admin, batch()), second = await ops.previewBatch({ ...admin, channelId: 'private', isDirect: true }, batch())
  assert.equal(ops.cancel({ ...admin, userId: 'one' }), 0)
  assert.equal(ops.cancel(admin), 1)
  await assert.rejects(ops.confirm(admin, first.token), /已经使用/)
  await ops.confirm({ ...admin, channelId: 'private', isDirect: true }, second.token)
  assert.equal(await ledger.get('event', { accountId: one.account.id }, {}), 3)
})

it('does not leave leases for unknown identities, and disposal cancels uncommitted operations', async () => {
  const { ops, ledger, one, batch } = await fixture()
  const game = ops.registerConsumer('game')
  await assert.rejects(game.acquire([actual('one'), actual('unknown')]), /建档/)
  const pending = await ops.previewBatch(admin, batch())
  ops.dispose()
  await assert.rejects(ops.confirm(admin, pending.token), /注销/)
  assert.throws(() => game.acquire([actual('one')]), /注销/)
  assert.equal(await ledger.get('event', { accountId: one.account.id }, {}), 0)
})
