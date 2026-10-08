import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { App, Bot, Context, h, Universal } from 'koishi'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { registerModels } from '../src/model'
import { registerAccountModels } from '../src/account-model'
import { registerAccountCommands } from '../src/account-commands'
import { AccountLifecycleStore } from '../src/account-lifecycle'
import { AccountOperations } from '../src/account-operations'
import { AccountQueryStore } from '../src/account-queries'
import { SubjectWriteCoordinator } from '../src/mutation-coordinator'
import { SubjectLedgerStore } from '../src/subject-ledger'

class TestBot extends Bot<Context> {
  hidden = true
  outputs: Array<{ destination: string, content: string }> = []
  failPrivate = false
  counter = 0
  constructor(ctx: Context) { super(ctx, {}, 'account-command-test'); this.platform = 'onebot'; this.selfId = 'bot' }
  async sendMessage(channelId: string, content: h.Fragment) {
    this.outputs.push({ destination: channelId, content: h.normalize(content).join('') })
    return [String(++this.counter)]
  }
  async sendPrivateMessage(userId: string, content: h.Fragment) {
    if (this.failPrivate) throw new Error('network error private token=secret')
    return this.sendMessage('private:' + userId, content)
  }
  async getUser(id: string) { return { id, name: id } }
  dispose(): Promise<void> { return this.ctx.bots ? super.dispose() : this.stop() }
  async say(userId: string, content: string, isDirect = false, guildId = 'group') {
    const channelId = isDirect ? 'private:' + userId : guildId
    const session = this.session({ user: { id: userId, name: userId },
      channel: { id: channelId, type: isDirect ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
      ...(isDirect ? {} : { guild: { id: guildId } }), timestamp: Date.now() })
    session.type = 'message'; session.messageId = 'input-' + ++this.counter; session.content = content
    this.dispatch(session)
    const sessions = (this.ctx.$processor as any)._sessions
    const deadline = performance.now() + 5000
    while (sessions[session.id] && performance.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(Boolean(sessions[session.id]), false, 'command timed out: ' + content)
  }
}
const apps: App[] = []
async function fixture(failRefresh = false, withSystem = true) {
  const app = new App({ autoAssign: true, autoAuthorize: 1 })
  app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(registerModels); app.plugin(registerAccountModels)
  const bot = new TestBot(app)
  await app.start(); apps.push(app); bot.online()
  const writes = new SubjectWriteCoordinator(), lifecycle = new AccountLifecycleStore(app.database, writes)
  await lifecycle.bootstrap()
  const now = new Date()
  if (withSystem) await app.database.create('xp_score_system', { key: 'event', name: '活动', unit: '分', scope: 'global',
    active: true, createdBy: 'fixture', createdAt: now, updatedAt: now })
  for (const [userId, authority] of [['admin', 2], ['own', 1], ['other', 1]] as const) await app.database.createUser('onebot', userId, { authority })
  const own = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'own', suggestedNickname: 'PrivateName' })
  const other = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'other', suggestedNickname: 'OtherName' })
  const ops = new AccountOperations(app.database, writes), queries = new AccountQueryStore(app.database, writes)
  let refreshes = 0, passed = 0
  app.plugin((ctx: Context) => registerAccountCommands(ctx, { operations: ops, queries, refresh: async () => {
    refreshes++
    if (failRefresh) throw new Error('cache unavailable')
  } }))
  app.middleware(async () => { passed++ })
  await new Promise<void>(resolve => setImmediate(resolve))
  return { app, bot, own, other, ops, lifecycle, ledger: new SubjectLedgerStore(app.database, writes), refreshes: () => refreshes, passed: () => passed }
}
afterEach(async () => { while (apps.length) await apps.pop()!.stop() })
const latestToken = (bot: TestBot) => bot.outputs.flatMap(row => row.content.match(/XPACCOUNT-[A-Za-z0-9_-]{32}/g) ?? []).at(-1)!

it('maintains global relationships and a future default with zero score systems', async () => {
  const { app, bot, own, ops } = await fixture(false, false)
  await bot.say('admin', '关联大小号 @other @own --mode 独立')
  await bot.say('admin', latestToken(bot))
  assert.equal((await app.database.get('xp_identity', { profileId: own.profile.id })).length, 2)
  const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'group', isDirect: false }
  await ops.rename(actor, own.profile.id, '统一示例昵称')
  await bot.say('own', '我的账号')
  assert.match(bot.outputs.at(-1)!.content, /统一管理昵称：统一示例昵称.*默认计分方式：账号分别计分/s)
  await bot.say('own', '账号模式 共享')
  assert.match(bot.outputs.at(-1)!.content, /目前没有积分系统，仅保存未来默认方式/)
  await bot.say('own', latestToken(bot))
  assert.equal((await app.database.get('xp_person_preference', { profileId: own.profile.id }))[0].defaultScoreMode, 'shared')
  assert.equal((await app.database.get('xp_score_system', {})).length, 0)
  assert.equal((await app.database.get('xp_subject_balance', {})).length, 0)
})

it('confirms one all-system mode, keeps single-system changes local, and inherits the receiving person default on association', async () => {
  const { app, bot, own, other, lifecycle, ledger } = await fixture()
  await bot.say('own', '账号模式 独立 -r @own')
  assert.match(bot.outputs.at(-1)!.content, /全系统计分方式预览/)
  const token = latestToken(bot)
  await bot.say('other', token)
  assert.match(bot.outputs.at(-1)!.content, /原操作者/)
  await bot.say('own', token)
  assert.equal((await app.database.get('xp_person_preference', { profileId: own.profile.id }))[0].defaultScoreMode, 'independent')
  await bot.say('own', '账号模式 event 共享')
  await bot.say('own', latestToken(bot))
  assert.equal((await app.database.get('xp_person_preference', { profileId: own.profile.id }))[0].defaultScoreMode, 'independent')
  await ledger.add('event', { accountId: own.account.id }, 8, { source: 'test', reason: 'reward' })
  await ledger.add('event', { accountId: other.account.id }, 3, { source: 'test', reason: 'reward' })
  await bot.say('admin', '关联大小号 @other @own')
  assert.match(bot.outputs.at(-1)!.content, /默认计分方式：账号分别计分/)
  await bot.say('admin', latestToken(bot))
  assert.equal((await app.database.get('xp_identity', { userId: 'other' }))[0].profileId, own.profile.id)
  assert.equal(await ledger.get('event', { accountId: own.account.id }, {}), 8)
  assert.equal(await ledger.get('event', { accountId: other.account.id }, {}), 3)
  await bot.say('admin', '账号模式 共享 -u @own')
  await bot.say('admin', latestToken(bot))
  assert.equal(await ledger.get('event', { accountId: other.account.id }, {}), 8)
  const now = new Date()
  await app.database.create('xp_score_system', { key: 'later', name: 'later', unit: '', scope: 'global', active: true, createdBy: 'test', createdAt: now, updatedAt: now })
  await lifecycle.initializeSystem('later')
  assert.equal((await app.database.get('xp_account_policy', { systemKey: 'later', profileId: own.profile.id }))[0].mode, 'shared')
})

it('uses per-system association choices ahead of --mode without fragmenting global nickname relationships', async () => {
  const { app, bot, own, other } = await fixture()
  await bot.say('admin', '关联大小号 @other @own --mode 独立 --modes event:共享')
  assert.match(bot.outputs.at(-1)!.content, /默认计分方式：账号分别计分/)
  await bot.say('admin', latestToken(bot))
  assert.equal((await app.database.get('xp_account_policy', { profileId: own.profile.id }))[0].mode, 'shared')
  assert.equal((await app.database.get('xp_person_preference', { profileId: own.profile.id }))[0].defaultScoreMode, 'independent')
  assert.equal((await app.database.get('xp_identity', { userId: 'other' }))[0].profileId, own.profile.id)
  assert.equal((await app.database.get('xp_profile', { id: other.profile.id })).length, 0)
  await bot.say('own', '我的账号')
  assert.match(bot.outputs.at(-1)!.content, /统一管理昵称：PrivateName.*默认计分方式：账号分别计分.*主小号关系（所有系统共用）.*各系统实际计分方式：.*活动（event）：共享积分/s)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /异常|例外|待整理/)
  await bot.say('admin', '大小号管理', true)
  assert.match(bot.outputs.at(-1)!.content, /默认：账号分别计分/)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /【.*待整理|模式异常|模式例外/)
})

it('limits private worklists to the current platform unless explicitly overridden', async () => {
  const { app, bot, lifecycle, ops } = await fixture()
  const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'group', isDirect: false }
  for (const platform of ['sandbox:a', 'sandbox:b']) {
    const a = await lifecycle.ensureIdentity({ platform, userId: 'a', suggestedNickname: platform + '-A' })
    const b = await lifecycle.ensureIdentity({ platform, userId: 'b', suggestedNickname: platform + '-B' })
    const p = await ops.previewAssociation(actor, { kind: 'merge-persons', sourceProfileId: b.profile.id,
      targetProfileId: a.profile.id, systems: [{ systemKey: 'event', mode: 'shared', strategy: 'maximum' }] })
    await ops.confirm(actor, p.token)
  }
  const before = await app.database.get('xp_account_operation', {})
  await bot.say('admin', '大小号管理', true)
  assert.match(bot.outputs.at(-1)!.content, /平台大小号 · onebot.*本次筛选 0 人/s)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /sandbox:/)
  await bot.say('admin', '大小号管理 -p sandbox:a', true)
  assert.match(bot.outputs.at(-1)!.content, /sandbox:a.*本次筛选 1 人/s)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /sandbox:b/)
  await bot.say('admin', '大小号管理 --all-platforms', true)
  assert.match(bot.outputs.at(-1)!.content, /全平台大小号.*本次筛选 2 人/s)
  for (const command of ['大小号管理 --all-platforms -p onebot', '大小号管理 --all-platforms -g group']) {
    await bot.say('admin', command, true)
    assert.ok(bot.outputs.at(-1)!.content.includes('不能与 -p/-g 同用'))
  }
  await bot.say('admin', '大小号管理 --all-platforms')
  assert.match(bot.outputs.at(-1)!.content, /仅私聊可用/)
  assert.deepEqual(await app.database.get('xp_account_operation', {}), before)
})

it('associates two single accounts independently in one confirmation with their original names, balances and explicit main', async () => {
  const { app, bot, own, other, ledger } = await fixture()
  const context = { source: 'fixture', reason: 'reward' }
  await ledger.add('event', { accountId: own.account.id }, 10.5, context)
  await ledger.add('event', { accountId: other.account.id }, 3, context)
  await bot.say('admin', '关联大小号 @other @own --modes event:独立')
  assert.match(bot.outputs.at(-1)!.content, /主号：未指定 → PrivateName.*第二个参数/s)
  const token = latestToken(bot); assert.ok(token)
  assert.equal((await app.database.get('xp_identity', { userId: 'other' }))[0].profileId, other.profile.id)
  await bot.say('admin', token)
  assert.equal((await app.database.get('xp_person_preference', { profileId: own.profile.id }))[0].primaryAccountId, own.account.id)
  assert.equal(await ledger.get('event', { accountId: own.account.id }, {}), 10.5)
  assert.equal(await ledger.get('event', { accountId: other.account.id }, {}), 3)
  assert.equal((await app.database.get('xp_account', { id: other.account.id }))[0].nickname, 'OtherName')
  await bot.say('admin', '大小号情况 @own')
  assert.match(bot.outputs.at(-1)!.content, /OtherName[\s\S]*账号分别计分/)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /待整理|待补/)
  await bot.say('admin', '大小号管理 --pending', true)
  assert.match(bot.outputs.at(-1)!.content, /本次筛选 0 人/)
  const audit = await app.database.get('xp_account_operation', {})
  await bot.say('admin', token)
  assert.deepEqual(await app.database.get('xp_account_operation', {}), audit)
})

it('gives usage for bare and malformed commands without writing or consuming unrelated gameplay text', async () => {
  const { app, bot, passed } = await fixture()
  const before = await app.database.get('xp_account_operation', {})
  for (const content of ['账号模式', '账号模式 event invalid', '设置主号', '设置账号标签', '设置账号昵称', '关联大小号', '积分.全部增加', '积分.全部设置']) {
    await bot.say('admin', content, true)
    assert.match(bot.outputs.at(-1)!.content, /用法/)
  }
  const count = passed()
  await bot.say('own', '3'); await bot.say('own', 'ordinary chat')
  assert.equal(passed(), count + 2)
  assert.deepEqual(await app.database.get('xp_account_operation', {}), before)
})

it('replies in the initiating conversation without disclosing another persons accounts to an unauthorized requester', async () => {
  const { bot } = await fixture()
  await bot.say('own', '我的账号')
  assert.equal(bot.outputs.length, 1)
  assert.equal(bot.outputs[0].destination, 'group')
  assert.match(bot.outputs[0].content, /PrivateName/)
  bot.outputs = []
  await bot.say('own', '大小号情况 @onebot:other')
  assert.doesNotMatch(bot.outputs.map(row => row.content).join(''), /OtherName|onebot:other/)
  assert.match(bot.outputs.at(-1)!.content, /本人/)
  bot.failPrivate = true
  await bot.say('own', '我的账号')
  assert.match(bot.outputs.at(-1)!.content, /PrivateName/)
  assert.equal(bot.outputs.at(-1)!.destination, 'group')
  bot.outputs = []
  await bot.say('own', '我的账号', true)
  assert.equal(bot.outputs.length, 1)
  assert.equal(bot.outputs[0].destination, 'private:own')
})

it('binds group confirmations to the same actor and conversation without granting administrator sums', async () => {
  const { app, bot, own, refreshes } = await fixture()
  await bot.say('own', '账号模式 event 独立 -r @onebot:own')
  assert.equal(bot.outputs.at(-1)!.destination, 'group')
  assert.match(bot.outputs.at(-1)!.content, /全部积分池.*不仅当前群/)
  const token = latestToken(bot); assert.ok(token)
  assert.equal((await app.database.get('xp_account_policy', { profileId: own.profile.id }))[0].mode, 'shared')
  await bot.say('other', token)
  assert.match(bot.outputs.at(-1)!.content, /原操作者/)
  await bot.say('own', token, true)
  assert.match(bot.outputs.at(-1)!.content, /原操作者/)
  await bot.say('own', token, false, 'another-group')
  assert.match(bot.outputs.at(-1)!.content, /原操作者/)
  await bot.say('own', token)
  assert.match(bot.outputs.at(-1)!.content, /操作完成/)
  assert.equal((await app.database.get('xp_account_policy', { profileId: own.profile.id }))[0].mode, 'independent')
  assert.equal(refreshes(), 1)
  await bot.say('own', '账号模式 event 共享 --strategy sum', true)
  assert.match(bot.outputs.at(-1)!.content, /本人合并/)
})

it('checks authority for account names, allows self labels, escapes markup and refreshes only successful writes', async () => {
  const { app, bot, own, refreshes } = await fixture()
  await bot.say('own', '设置账号昵称 @onebot:own Hacked', true)
  assert.equal((await app.database.get('xp_account', { id: own.account.id }))[0].nickname, 'PrivateName')
  await bot.say('own', '设置账号标签 @onebot:own MainLabel')
  assert.equal((await app.database.get('xp_account', { id: own.account.id }))[0].label, 'MainLabel')
  await bot.say('admin', '设置账号昵称 @onebot:own OwnName')
  assert.equal((await app.database.get('xp_account', { id: own.account.id }))[0].nickname, 'OwnName')
  assert.equal(refreshes(), 2)
  await app.database.set('xp_account', { id: own.account.id }, { nickname: '<at id="other"/>' })
  bot.outputs = []
  await bot.say('own', '我的账号', true)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /<at /)
  assert.match(bot.outputs.at(-1)!.content, /&lt;at/)
})

it('previews association without changing ownership, then preserves both account names after exact confirmation', async () => {
  const { app, bot, own, other, ledger } = await fixture()
  await ledger.add('event', { accountId: own.account.id }, 12, { source: 'fixture', reason: 'award' })
  await ledger.add('event', { accountId: other.account.id }, 7, { source: 'fixture', reason: 'award' })
  await bot.say('admin', '关联大小号 @own @other', true)
  assert.match(bot.outputs.at(-1)!.content, /合并两个真人/)
  assert.match(bot.outputs.at(-1)!.content, /12/)
  const token = latestToken(bot); assert.ok(token)
  assert.equal((await app.database.get('xp_identity', { platform: 'onebot', userId: 'own' }))[0].profileId, own.profile.id)
  await bot.say('admin', token, true)
  assert.equal((await app.database.get('xp_identity', { platform: 'onebot', userId: 'own' }))[0].profileId, other.profile.id)
  assert.equal(await ledger.get('event', { accountId: own.account.id }, {}), 12)
  assert.deepEqual((await app.database.get('xp_account', {})).map(row => row.nickname).sort(), ['OtherName', 'PrivateName'])
})

it('batch command applies once to a shared group and requires a fresh private preview after data changes', async () => {
  const { bot, own, ledger } = await fixture()
  await bot.say('admin', '积分.全部增加 event 3 @own', true)
  const stale = latestToken(bot); assert.ok(stale)
  await ledger.add('event', { accountId: own.account.id }, 1, { source: 'fixture', reason: 'award' })
  await bot.say('admin', stale, true)
  assert.match(bot.outputs.at(-1)!.content, /重新预览/)
  await bot.say('admin', '积分.全部增加 event 3 @own', true)
  assert.match(bot.outputs.at(-1)!.content, /1 个计分主体/)
  const token = latestToken(bot)
  await bot.say('admin', token, true)
  assert.equal(await ledger.get('event', { accountId: own.account.id }, {}), 4)
  await bot.say('admin', token, true)
  assert.equal(await ledger.get('event', { accountId: own.account.id }, {}), 4)
})

it('reports a committed write truthfully when subsequent nickname-cache refresh fails', async () => {
  const { app, bot, own } = await fixture(true)
  await bot.say('admin', '设置账号昵称 @own SavedName', true)
  assert.match(bot.outputs.at(-1)!.content, /已保存.*缓存刷新失败/)
  assert.equal((await app.database.get('xp_account', { id: own.account.id }))[0].nickname, 'SavedName')
})

it('uses compact current-group worklists and optional private guild filters', async () => {
  const { app, bot, own, other, ops } = await fixture()
  const admin = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private:admin', isDirect: true }
  const proposal = await ops.previewAssociation(admin, { kind: 'merge-persons', sourceProfileId: other.profile.id,
    targetProfileId: own.profile.id, systems: [{ systemKey: 'event', mode: 'shared', strategy: 'maximum' }] })
  await ops.confirm(admin, proposal.token)
  const now = new Date()
  await app.database.create('xp_guild_presence', { platform: 'onebot', guildId: 'group', userId: 'own',
    state: 'active', reason: 'test', firstConfirmedAt: now, lastConfirmedAt: now, inactiveAt: null })
  await bot.say('admin', '本群大小号')
  const privateText = bot.outputs.find(row => row.destination === 'group')!.content
  assert.match(privateText, /已关联多账号 1 人/)
  assert.match(privateText, /PrivateName.*2 个账号/)
  assert.match(privateText, /待整理 0 人/)
  assert.doesNotMatch(privateText, /未指定主号|昵称待补/)
  assert.match(privateText, /详情：大小号情况 @onebot:/)
  assert.doesNotMatch(privateText, /历史合并|暂无.*余额|共享余额|不按积分/)
  assert.equal(bot.outputs.length, 1)
  assert.equal(bot.outputs[0].destination, 'group')
  await bot.say('admin', '本群大小号 -g group -k OtherName --pending', true)
  assert.match(bot.outputs.at(-1)!.content, /本次筛选 0 人/)
  await app.database.set('xp_account', { id: other.account.id }, { nicknameStatus: 'unknown' })
  await bot.say('own', '我的账号')
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /待整理|待补|未指定主号/)
  const change = await ops.previewMode(admin, { systemKey: 'event', profileId: own.profile.id,
    nextMode: 'independent', retainedAccountId: own.account.id, strategy: 'maximum' })
  await ops.confirm(admin, change.token)
  await bot.say('own', '我的账号')
  assert.match(bot.outputs.at(-1)!.content, /独立计分待整理：未指定主号/)
  assert.match(bot.outputs.at(-1)!.content, /独立计分昵称待整理/)
  await ops.setNickname(admin, own.profile.id, other.account.id, 'OtherName')
  await ops.setPrimary(admin, own.profile.id, own.account.id)
  await bot.say('admin', '本群大小号 -g group --pending', true)
  assert.match(bot.outputs.at(-1)!.content, /没有符合条件/)
  await bot.say('admin', '本群大小号 -g group -k not-found', true)
  assert.match(bot.outputs.at(-1)!.content, /没有符合条件/)
  await bot.say('own', '本群大小号 -g group', true)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /OtherName/)
})

it('single-account detail avoids main/alt boilerplate and rejects unknown system filters', async () => {
  const { bot } = await fixture()
  await bot.say('own', '我的账号', true)
  assert.match(bot.outputs.at(-1)!.content, /仅一个账号/)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /主号待指定|历史合并/)
  assert.match(bot.outputs.at(-1)!.content, /暂无积分记录/)
  await bot.say('own', '我的账号 --system missing', true)
  assert.match(bot.outputs.at(-1)!.content, /积分系统不存在/)
  await bot.say('own', '我的账号 --page 0', true)
  assert.match(bot.outputs.at(-1)!.content, /页码须为正整数/)
})

it('paginates large personal pool details one message at a time without losing balances', async () => {
  const { app, bot, own } = await fixture()
  const subject = (await app.database.get('xp_score_subject', { profileId: own.profile.id, active: true }))[0]
  // A large account overview is read-only; pagination must not become a failed
  // 12k response or send every page automatically.
  for (let i = 0; i < 120; i++) await app.database.create('xp_subject_balance', {
    subjectId: subject.id, platform: 'fixture', guildId: 'pool-' + String(i).padStart(3, '0'), value: i, updatedAt: new Date() })
  await bot.say('own', '我的账号 --system event', true)
  const first = bot.outputs.at(-1)!.content
  assert.ok(first.length < 3200)
  assert.match(first, /下一页：我的账号 --system event --page 2/)
  assert.equal(bot.outputs.length, 1)
  const pageCount = Number(first.match(/第 1\/(\d+) 页/)![1])
  let collected = first
  for (let page = 2; page <= pageCount; page++) {
    await bot.say('own', `我的账号 --system event --page ${page}`, true)
    collected += bot.outputs.at(-1)!.content
  }
  for (let i = 0; i < 120; i++) assert.ok(collected.includes('pool-' + String(i).padStart(3, '0')))
  assert.equal((await app.database.get('xp_subject_balance', {})).length, 120)
})

it('does not bury multi-account groups behind single-account pages and offers a working next-page command', async () => {
  const { app, bot, lifecycle, ops } = await fixture()
  const admin = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'private:admin', isDirect: true }
  const now = new Date()
  const seen = (userId: string) => app.database.create('xp_guild_presence', { platform: 'onebot', guildId: 'group', userId,
    state: 'active', reason: 'fixture', firstConfirmedAt: now, lastConfirmedAt: now, inactiveAt: null })
  for (let i = 0; i < 12; i++) {
    await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'solo' + i, suggestedNickname: 'Solo' + i })
    await seen('solo' + i)
  }
  for (let i = 0; i < 6; i++) {
    const main = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'main' + i, suggestedNickname: 'Group' + i })
    const alt = await lifecycle.ensureIdentity({ platform: 'onebot', userId: 'alt' + i, suggestedNickname: 'Alt' + i })
    const p = await ops.previewAssociation(admin, { kind: 'merge-persons', sourceProfileId: alt.profile.id,
      targetProfileId: main.profile.id, systems: [{ systemKey: 'event', mode: 'shared', strategy: 'maximum' }] })
    await ops.confirm(admin, p.token); await seen('main' + i)
  }
  await bot.say('admin', '本群大小号')
  const first = bot.outputs.find(row => row.destination === 'group')!.content
  assert.match(first, /第 1\/2 页/)
  assert.doesNotMatch(first, /Solo\d/)
  assert.equal((first.match(/仅基于本群/g) ?? []).length, 1)
  const next = h.parse(first).map(row => row.type === 'text' ? row.attrs.content : '').join('').match(/下一页：(.+)/)![1]
  await bot.say('admin', next)
  assert.equal(bot.outputs.at(-1)!.destination, 'group')
  assert.match(bot.outputs.at(-1)!.content, /第 2\/2 页/)
  assert.match(bot.outputs.at(-1)!.content, /Group5/)
  await bot.say('admin', '本群大小号 --all -k Solo0 -g group', true)
  assert.match(bot.outputs.at(-1)!.content, /本次筛选 1 人/)
  assert.match(bot.outputs.at(-1)!.content, /Solo0 · 1 个账号/)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /【未指定主号/)
  await bot.say('admin', '大小号管理', true)
  const globalFirst = bot.outputs.at(-1)!.content
  assert.match(globalFirst, /平台大小号 · onebot.*第 1\/2 页/)
  const globalNext = h.parse(globalFirst).map(row => row.type === 'text' ? row.attrs.content : '').join('').match(/下一页：(.+)/)![1]
  assert.match(globalNext, /-p "onebot"/)
  await bot.say('admin', globalNext, true)
  assert.match(bot.outputs.at(-1)!.content, /平台大小号 · onebot.*第 2\/2 页/)
})

it('private management includes relationships without guild activity while group lists stay source-scoped', async () => {
  const { app, bot, own, other, ops } = await fixture()
  await bot.say('admin', '关联大小号 @own @other')
  const token = latestToken(bot); assert.ok(token)
  assert.equal(bot.outputs.at(-1)!.destination, 'group')
  await bot.say('admin', token)
  assert.equal((await app.database.get('xp_identity', { userId: 'own' }))[0].profileId, other.profile.id)
  await bot.say('admin', '本群大小号')
  assert.match(bot.outputs.at(-1)!.content, /本次筛选 0 人/)
  await bot.say('admin', '大小号管理', true)
  assert.match(bot.outputs.at(-1)!.content, /平台大小号 · onebot.*本次筛选 1 人/s)
  assert.match(bot.outputs.at(-1)!.content, /PrivateName/)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /本群未确认/)
  await bot.say('admin', '本群大小号 -g another-group')
  assert.match(bot.outputs.at(-1)!.content, /仅查看当前群/)
  await bot.say('admin', '本群大小号 -p other-platform')
  assert.match(bot.outputs.at(-1)!.content, /仅查看当前群/)
  await bot.say('admin', '本群大小号 -p onebot', true)
  assert.match(bot.outputs.at(-1)!.content, /平台大小号 · onebot/)
  await bot.say('admin', '设置主号 @own')
  assert.equal((await app.database.get('xp_person_preference', { profileId: other.profile.id }))[0].primaryAccountId, own.account.id)
  await bot.say('own', '大小号管理', true)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /PrivateName|OtherName/)
})

it('group batch scores use the current source guild and confirm there, private guild operations require a pool', async () => {
  const { app, bot, own, ledger } = await fixture()
  await app.database.set('xp_score_system', { key: 'event' }, { scope: 'guild' })
  await app.database.create('xp_score_guild_alias', { systemKey: 'event', platform: 'onebot', sourceGuildId: 'group',
    targetGuildId: 'shared-pool', createdAt: new Date(), updatedAt: new Date() })
  await bot.say('admin', '积分.全部增加 event 3 @own')
  assert.match(bot.outputs.at(-1)!.content, /实际积分池：onebot\/shared-pool/)
  assert.match(bot.outputs.at(-1)!.content, /来源群 group 已挂靠/)
  const token = latestToken(bot); assert.ok(token)
  await bot.say('admin', token)
  assert.equal(await ledger.get('event', { accountId: own.account.id }, { platform: 'onebot', guildId: 'group' }), 3)
  assert.equal(await ledger.get('event', { accountId: own.account.id }, { platform: 'onebot', guildId: 'elsewhere' }), 0)
  const before = (await app.database.get('xp_subject_balance', {}))
  await bot.say('admin', '积分.全部增加 event 3 @own', true)
  assert.doesNotMatch(bot.outputs.at(-1)!.content, /XPACCOUNT-/)
  assert.deepEqual(await app.database.get('xp_subject_balance', {}), before)
})
