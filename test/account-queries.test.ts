import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { App } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { registerModels } from '../src/model'
import { registerAccountModels } from '../src/account-model'
import { AccountLifecycleStore } from '../src/account-lifecycle'
import { AccountOperations } from '../src/account-operations'
import { AccountQueryStore } from '../src/account-queries'
import { SubjectLedgerStore } from '../src/subject-ledger'
import { SubjectWriteCoordinator } from '../src/mutation-coordinator'

const apps: App[] = []
const admin = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'A', isDirect: false }
async function fixture() {
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(registerModels); app.plugin(registerAccountModels)
  await app.start(); apps.push(app)
  const writes = new SubjectWriteCoordinator(), lifecycle = new AccountLifecycleStore(app.database, writes)
  await lifecycle.bootstrap()
  const now = new Date()
  await app.database.create('xp_score_system', { key: 'event', name: '活动', unit: '分', scope: 'guild',
    active: true, createdBy: 'fixture', createdAt: now, updatedAt: now })
  await app.database.create('xp_score_guild_alias', { systemKey: 'event', platform: 'onebot', sourceGuildId: 'A',
    targetGuildId: 'pool', createdAt: now, updatedAt: now })
  await app.database.create('xp_score_guild_alias', { systemKey: 'event', platform: 'onebot', sourceGuildId: 'B',
    targetGuildId: 'pool', createdAt: now, updatedAt: now })
  const make = async (userId: string, nickname: string) => {
    await app.database.createUser('onebot', userId, { authority: 1 })
    return lifecycle.ensureIdentity({ platform: 'onebot', userId, suggestedNickname: nickname })
  }
  await app.database.createUser('onebot', 'admin', { authority: 2 })
  const main = await make('main', 'MainName'), alt = await make('alt', 'AltName'), other = await make('other', 'OtherName')
  const ops = new AccountOperations(app.database, writes), ledger = new SubjectLedgerStore(app.database, writes)
  const queries = new AccountQueryStore(app.database, writes), context = { platform: 'onebot', guildId: 'A' }
  const merge = await ops.previewAssociation(admin, { kind: 'merge-persons', sourceProfileId: alt.profile.id,
    targetProfileId: main.profile.id, systems: [{ systemKey: 'event', mode: 'shared', strategy: 'maximum' }] })
  await ops.confirm(admin, merge.token)
  await ops.setPrimary(admin, main.profile.id, main.account.id)
  const presence = async (userId: string, guildId: string, state: 'active' | 'inactive') => {
    await app.database.upsert('xp_guild_presence', [{ platform: 'onebot', guildId, userId, state, reason: 'test',
      firstConfirmedAt: now, lastConfirmedAt: now, inactiveAt: state === 'inactive' ? now : null }])
  }
  const authority = async (userId: string, value: number) => {
    const binding = (await app.database.get('binding', { platform: 'onebot', pid: userId }))[0]
    await app.database.set('user', { id: binding.aid }, { authority: value })
  }
  const independent = async () => {
    const proposal = await ops.previewMode(admin, { systemKey: 'event', profileId: main.profile.id,
      nextMode: 'independent', retainedAccountId: main.account.id, strategy: 'maximum' })
    await ops.confirm(admin, proposal.token)
  }
  const score = (accountId: string, value: number) => ledger.set('event', { accountId }, value, { ...context, source: 'fixture', reason: 'score' })
  return { app, main, alt, other, ops, queries, lifecycle, context, presence, authority, independent, score }
}
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })

it('filters platforms before counting/searching but preserves complete person details', async () => {
  const { app, queries, main, alt, lifecycle, ops, presence } = await fixture()
  const remote = await lifecycle.ensureIdentity({ platform: 'sandbox:test', userId: 'bot-alt', suggestedNickname: 'SandboxOnly' })
  const p = await ops.previewAssociation(admin, { kind: 'merge-persons', sourceProfileId: remote.profile.id,
    targetProfileId: main.profile.id, systems: [{ systemKey: 'event', mode: 'shared', strategy: 'maximum' }] })
  await ops.confirm(admin, p.token)
  await ops.setPrimary(admin, main.profile.id, remote.account.id)
  await app.database.set('xp_account', { id: remote.account.id }, { nicknameStatus: 'unknown' })
  await presence('main', 'A', 'active')
  const before = await app.database.get('xp_account_operation', {})
  const view = await queries.platform(admin, 'onebot')
  assert.equal(view.total, 1)
  assert.equal(view.knownAccounts, 3)
  assert.deepEqual(new Set(view.entries[0].accounts.map(row => row.id)), new Set([main.account.id, alt.account.id]))
  assert.equal(view.entries[0].primaryOutsidePlatform, true)
  assert.equal(view.entries[0].needsReview, false)
  assert.equal((await queries.platform(admin, 'onebot', 1, 5, { keyword: 'SandboxOnly' })).total, 0)
  assert.equal((await queries.platform(admin, 'sandbox:test')).total, 0)
  assert.equal((await queries.platform(admin, 'sandbox:test', 1, 5, { includeSingles: true })).total, 1)
  assert.equal((await queries.guild(admin, 'onebot', 'A')).entries[0].accounts.length, 2)
  assert.equal((await queries.person(admin, main.profile.id)).accounts.length, 3)
  assert.equal((await queries.all(admin)).entries[0].accounts.length, 3)
  assert.deepEqual(await app.database.get('xp_account_operation', {}), before)
})

it('private person overview reports per-account balances and per-pool maximum without summing related accounts', async () => {
  const { queries, main, alt, score, independent } = await fixture()
  await score(main.account.id, 5)
  await independent()
  await score(alt.account.id, 12)
  const view = await queries.person(admin, main.profile.id)
  assert.equal(view.systems[0].mode, 'independent')
  assert.equal(view.systems[0].pools[0].highest, 12)
  assert.equal(view.systems[0].pools[0].guildId, 'pool')
  assert.deepEqual(view.systems[0].pools[0].entries.map(row => row.value).sort((a, b) => a - b), [5, 12])
  assert.ok(view.accounts.some(row => row.nickname === 'AltName'))
})

it('shows a shared subject once and never adds synthetic unscored accounts to the public board', async () => {
  const { queries, main, context, score } = await fixture()
  assert.equal((await queries.leaderboard('event', context)).total, 0)
  await score(main.account.id, 12.5)
  const result = await queries.leaderboard('event', context)
  assert.equal(result.total, 1)
  assert.equal(result.entries[0].nickname, 'MainName')
  assert.equal(result.entries[0].accountId, null)
  assert.equal('identities' in result.entries[0], false)
})

it('preserves own account names and global score ordering rather than grouping independent siblings', async () => {
  const { queries, main, alt, other, context, independent, score } = await fixture()
  await score(main.account.id, 30); await score(other.account.id, 20); await independent(); await score(alt.account.id, 10)
  const result = await queries.leaderboard('event', context)
  assert.deepEqual(result.entries.map(row => row.value), [30, 20, 10])
  assert.deepEqual(result.entries.map(row => row.nickname), ['MainName', 'OtherName', 'AltName（MainName的小号）'])
  const page = await queries.leaderboard('event', context, { page: 2, pageSize: 1 })
  assert.equal(page.entries[0].nickname, 'OtherName')
  assert.equal(page.total, 3)
  await assert.rejects(queries.leaderboard('event', context, { page: 4, pageSize: 1 }), /只有 3 页/)
})

it('filters independent accounts separately and restores them on rejoin or unblocking without losing scores', async () => {
  const { queries, main, alt, context, score, independent, presence, authority } = await fixture()
  await score(main.account.id, 30); await independent(); await score(alt.account.id, 10)
  await presence('alt', 'A', 'inactive')
  let board = await queries.leaderboard('event', context)
  assert.deepEqual(board.entries.map(row => row.value), [30])
  const visible = await queries.leaderboard('event', context, { inactivePolicy: 'show' })
  assert.equal(visible.entries[1].inactive, true)
  assert.equal((await queries.leaderboard('event', { ...context, guildId: 'B' })).total, 2)
  await presence('alt', 'A', 'active'); await authority('main', 0)
  board = await queries.leaderboard('event', context)
  assert.deepEqual(board.entries.map(row => row.value), [10])
  await authority('main', 1)
  assert.deepEqual((await queries.leaderboard('event', context)).entries.map(row => row.value), [30, 10])
})

it('keeps a shared person visible while any linked source-guild account is usable', async () => {
  const { queries, main, context, score, presence, authority } = await fixture()
  await score(main.account.id, 7)
  await presence('main', 'A', 'inactive')
  assert.equal((await queries.leaderboard('event', context)).total, 1)
  await authority('alt', 0)
  assert.equal((await queries.leaderboard('event', context)).total, 0)
  assert.equal((await queries.leaderboard('event', { ...context, guildId: 'B' })).total, 1)
  await authority('alt', 1)
  assert.equal((await queries.leaderboard('event', context)).entries[0].value, 7)
})

it('restricts person relationship inspection to the actual owner or administrator without inheriting sibling authority', async () => {
  const { queries, main, alt, other, authority } = await fixture()
  const owner = await queries.person({ platform: 'onebot', userId: 'alt' })
  assert.equal(owner.accounts.length, 2)
  assert.equal(owner.primaryAccountId, main.account.id)
  assert.deepEqual(owner.accounts.map(row => row.nickname).sort(), ['AltName', 'MainName'])
  assert.equal(owner.systems[0].mode, 'shared')
  await authority('main', 5)
  await assert.rejects(queries.person({ platform: 'onebot', userId: 'alt' }, other.profile.id), /本人/)
  assert.equal((await queries.person(admin, other.profile.id)).profile.nickname, 'OtherName')
  assert.equal((await queries.person(admin, main.profile.id)).accounts.some(row => row.id === alt.account.id), true)
})

it('paginates local-known guild relationships, labels incomplete knowledge, and makes no writes', async () => {
  const { app, queries, main, other, presence } = await fixture()
  await presence('main', 'A', 'active'); await presence('other', 'A', 'inactive')
  const before = await app.database.get('xp_guild_presence', {})
  await assert.rejects(queries.guild({ platform: 'onebot', userId: 'alt' }, 'onebot', 'A'), /管理员/)
  const page = await queries.guild(admin, 'onebot', 'A', 1, 1)
  assert.equal(page.total, 1)
  assert.equal(page.entries[0].profile.id, main.profile.id)
  assert.equal(page.knownAccounts, 2)
  assert.equal(page.completeness, 'local-only')
  assert.equal((await queries.guild(admin, 'onebot', 'A', 2, 1, { includeSingles: true })).entries[0].profile.id, other.profile.id)
  assert.equal((await queries.guild(admin, 'onebot', 'unknown')).total, 0)
  assert.deepEqual(await app.database.get('xp_guild_presence', {}), before)
})

it('filters multi-account work before pagination and searches linked accounts outside the source guild', async () => {
  const { app, queries, main, alt, presence, independent } = await fixture()
  await independent()
  await presence('main', 'A', 'active')
  await presence('other', 'A', 'active')
  await app.database.set('xp_account', { id: alt.account.id }, { nicknameStatus: 'unknown' })
  const before = await app.database.get('xp_account', {})
  const result = await queries.guild(admin, 'onebot', 'A', 1, 1, { pendingOnly: true, keyword: 'AltName' })
  assert.equal(result.total, 1)
  assert.equal(result.knownPeople, 2)
  assert.equal(result.multiPeople, 1)
  assert.equal(result.pendingPeople, 1)
  assert.equal(result.entries[0].profile.id, main.profile.id)
  assert.equal(result.entries[0].accounts.find(row => row.id === alt.account.id)!.guildState, 'unknown')
  assert.equal('pools' in result.entries[0].systems[0], false)
  await app.database.set('xp_account', { id: alt.account.id }, { nicknameStatus: 'managed' })
  assert.equal((await queries.guild(admin, 'onebot', 'A', 1, 5, { pendingOnly: true })).total, 0)
  assert.equal((await queries.guild(admin, 'onebot', 'B')).total, 0)
  assert.equal(before.length, (await app.database.get('xp_account', {})).length)
})

it('shared account metadata is optional; only independent systems create review tasks without rewriting provenance', async () => {
  const { app, queries, main, alt, presence, independent, score } = await fixture()
  await presence('main', 'A', 'active'); await score(main.account.id, 12.5)
  await app.database.set('xp_person_preference', { profileId: main.profile.id }, { primaryAccountId: null })
  await app.database.set('xp_account', { id: [main.account.id, alt.account.id] }, { nicknameStatus: 'unknown' })
  const before = await app.database.get('xp_account', {})
  const balances = await app.database.get('xp_subject_balance', {})
  const shared = await queries.guild(admin, 'onebot', 'A')
  assert.equal(shared.pendingPeople, 0)
  assert.equal(shared.entries[0].missingPrimary, false)
  assert.equal(shared.entries[0].unknownNames, 0)
  assert.equal((await queries.all(admin, 1, 5, { pendingOnly: true })).total, 0)
  assert.deepEqual(await app.database.get('xp_account', {}), before)
  assert.deepEqual(await app.database.get('xp_subject_balance', {}), balances)
  await independent()
  const mixed = await queries.all(admin, 1, 5, { pendingOnly: true })
  assert.equal(mixed.total, 1)
  assert.equal(mixed.entries[0].missingPrimary, true)
  assert.equal(mixed.entries[0].unknownNames, 2)
  assert.deepEqual(mixed.entries[0].independentSystems.map(row => row.key), ['event'])
})

it('global relationship queries include all registered platforms without relying on guild presence and remain read-only', async () => {
  const { app, queries, main, lifecycle, ops } = await fixture()
  const remote = await lifecycle.ensureIdentity({ platform: 'other-platform', userId: 'remote', suggestedNickname: 'RemoteName' })
  const p = await ops.previewAssociation(admin, { kind: 'merge-persons', sourceProfileId: remote.profile.id,
    targetProfileId: main.profile.id, systems: [{ systemKey: 'event', mode: 'shared', strategy: 'maximum' }] })
  await ops.confirm(admin, p.token)
  const before = await app.database.get('xp_account_operation', {})
  const result = await queries.all(admin)
  assert.equal(result.total, 1)
  assert.equal(result.knownPeople, 2)
  assert.equal(result.knownAccounts, 4)
  assert.equal(result.entries[0].accounts.length, 3)
  assert.equal((await queries.all(admin, 1, 5, { keyword: 'RemoteName' })).total, 1)
  assert.equal((await queries.all(admin, 1, 5, { includeSingles: true })).total, 2)
  assert.equal((await queries.guild(admin, 'onebot', 'unknown')).total, 0)
  await assert.rejects(queries.all({ platform: 'onebot', userId: 'alt' }), /管理员/)
  assert.deepEqual(await app.database.get('xp_guild_presence', {}), [])
  assert.deepEqual(await app.database.get('xp_account_operation', {}), before)
})
