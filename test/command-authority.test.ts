import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import SQLiteDriver from "@koishijs/plugin-database-sqlite"
import * as help from '@koishijs/plugin-help'
import { App, Bot, Context, h, Universal } from "koishi"
import * as xpPoints from "../src/plugin"
import { associationHelp, accountModeHelp, assertXpCommandNamesAvailable } from '../src/command-catalog'
import { readFileSync } from 'node:fs'

class AuthorityBot extends Bot<Context, { platform: string, selfId: string }> {
  hidden = true
  readonly output: string[] = []
  readonly deliveries: Array<{ channelId: string, content: string }> = []
  readonly nativeNames = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, { platform: "onebot", selfId: "koishi" }, "authority-test")
    this.platform = "onebot"
    this.selfId = "koishi"
  }

  async sendMessage(_channelId: string, content: h.Fragment): Promise<string[]> {
    this.output.push(h.normalize(content).map(element => element.toString()).join(""))
    this.deliveries.push({ channelId: _channelId, content: this.output.at(-1)! })
    return [String(this.output.length)]
  }

  async sendPrivateMessage(userId: string, content: h.Fragment): Promise<string[]> {
    return this.sendMessage(`private:${userId}`, content)
  }

  dispose(): Promise<void> {
    if (!this.ctx.bots) return this.stop()
    return super.dispose()
  }

  async getGuildMemberList() {
    return { data: [] }
  }

  async getUser(userId: string) {
    return { id: userId, name: this.nativeNames.get(userId) ?? userId }
  }

  async dispatchMessage(userId: string, authority: number, content: string, direct = false): Promise<void> {
    if (!(await this.ctx.database.getUser(this.platform, userId))) {
      await this.ctx.database.createUser(this.platform, userId, { authority })
    }
    const session = this.session({
      user: { id: userId, name: userId },
      channel: { id: direct ? `private:${userId}` : "guild", type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
      ...(direct ? {} : { guild: { id: "guild" } }),
      timestamp: Date.now(),
    })
    session.type = "message"
    session.messageId = "message-" + userId + "-" + this.output.length
    session.content = content
    this.dispatch(session)
    const sessions = (this.ctx.$processor as unknown as { _sessions: Record<string, unknown> })._sessions
    const deadline = performance.now() + 10_000
    while (sessions[session.id] && performance.now() < deadline) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (sessions[session.id]) throw new Error("指令测试超时：" + content)
  }
}

const apps: App[] = []
afterEach(async () => {
  while (apps.length) await apps.pop()!.stop()
})

const scoreSystems = [{
  key: "primary",
  name: "活动积分",
  unit: "分",
  scope: "guild" as const,
}]

const primaryBindings = [{
  systemKey: "primary",
  query: [],
  leaderboard: ["活动榜"],
  setSelf: ["活动分"],
  addSelf: ["自己加活动分"],
  setTarget: ["设置活动分"],
  addTarget: ["增加活动分"],
}]

function pluginConfig(options: { systems?: any[]; bindings?: any[]; leaderboardPageSize?: number } = {}) {
  return {
    scoreSystems: options.systems ?? scoreSystems,
    scoreCommandBindings: options.bindings ?? primaryBindings,
    scoreGuildAliases: {},
    leaderboardInactivePolicy: "hide" as const,
    requiredDeletionConsumers: [],
    leaderboardPageSize: options.leaderboardPageSize ?? 50,
    nicknameConsumers: {
      chatluna: { enabled: false, guilds: [], includePrivate: false },
      chatlunaCharacter: { enabled: false, guilds: [], includePrivate: false },
    },
  }
}

describe("xp-points command authority", () => {
  it('keeps an explicitly configured normalized leaderboard alias instead of replacing it with the generic alias', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' })
    app.plugin(xpPoints, pluginConfig({ bindings: [{ systemKey: 'primary', query: [], leaderboard: ['积分榜'], setSelf: [], addSelf: [], setTarget: [], addTarget: [] }] }))
    const bot = new AuthorityBot(app); await app.start(); apps.push(app); bot.online()
    assert.equal(app.$commander.get('积分榜')!.name, '积分榜')
    await bot.dispatchMessage('reader', 1, '积分榜')
    assert.match(bot.output.at(-1)!, /活动积分榜为空/)
    assert.doesNotMatch(bot.output.at(-1)!, /用法：积分.排行/)
  })
  it('supports historical competitive corrections and opt-out through native and configured score commands', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app); await app.start(); apps.push(app); bot.online()
    await bot.dispatchMessage('admin', 2, '积分.增加 primary 2 @victim --date 2026-02-03')
    assert.match(bot.output.at(-1)!, /现为 2分/)
    await bot.dispatchMessage('admin', 2, '积分.增加 primary 8 @victim --no-competitive')
    assert.match(bot.output.at(-1)!, /现为 10分/)
    await bot.dispatchMessage('reader', 1, '积分.排行 primary --period 日 --date 2026-02-03')
    assert.match(bot.output.at(-1)!, /victim 2分/)
    assert.doesNotMatch(bot.output.at(-1)!, /victim 10分/)
    await bot.dispatchMessage('admin', 2, '设置活动分 7 @victim --date 2026-02-03')
    await bot.dispatchMessage('reader', 1, '活动榜 --period 月 --date 2026-02-03')
    assert.match(bot.output.at(-1)!, /victim -1分/)
    await bot.dispatchMessage('admin', 2, '自己加活动分 3 --date 2026-02-03')
    await bot.dispatchMessage('reader', 1, '活动榜 --period 月 --date 2026-02-03')
    assert.match(bot.output.at(-1)!, /admin 3分/)
    await bot.dispatchMessage('admin', 2, '增加活动分 3 @second --date 2026-02-03')
    const tied = await app.xpPoints.getPeriodLeaderboard('primary', { platform: 'onebot', guildId: 'guild' }, { kind: 'month', at: Date.parse('2026-02-03T12:00:00+08:00') })
    assert.deepEqual(tied.entries.map(e => e.rank), [1, 1, 3])
    await bot.dispatchMessage('reader', 1, '活动榜')
    assert.match(bot.output.at(-1)!, /victim 7分/)
    await bot.dispatchMessage('reader', 1, '积分.增加 primary 100 @victim --date 2026-02-03')
    const rows = await app.database.get('xp_period_score', {})
    assert.ok(rows.every(r => r.value < 100))
  })
  it('accepts positional periods for business and canonical leaderboards while keeping player output concise', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' })
    app.plugin(xpPoints, pluginConfig({
      bindings: [{ ...primaryBindings[0], leaderboard: ['积分榜'] }],
    }))
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()

    for (let index = 1; index <= 4; index++) {
      const userId = `period-player-${index}`
      bot.nativeNames.set(userId, `Period Player ${index}`)
      await bot.dispatchMessage('admin', 2, `增加活动分 ${index} @${userId} --date 2026-10-02`)
    }

    await bot.dispatchMessage('reader', 1, '积分榜 月')
    const business = bot.output.at(-1) ?? ''
    assert.match(business, /活动积分月榜（第 1\/1 页，共 4 条）/)
    assert.equal(business.split('\n').length, 3)
    assert.match(business, /1\. Period Player 4 4分  2\. Period Player 3 3分  3\. Period Player 2 2分/)
    assert.match(business, /4\. Period Player 1 1分/)
    assert.doesNotMatch(business, /2026-|T\d|时区|最后修订/)

    await bot.dispatchMessage('reader', 1, '积分.排行 primary 月')
    assert.match(bot.output.at(-1) ?? '', /活动积分月榜（第 1\/1 页，共 4 条）/)
    await bot.dispatchMessage('reader', 1, '积分榜 --period 月 --date 2026-10-02')
    assert.match(bot.output.at(-1) ?? '', /活动积分月榜（第 1\/1 页，共 4 条）/)

    await bot.dispatchMessage('owner', 5, '积分系统.日志 primary --period 月 --date 2026-10-02')
    const detail = bot.output.at(-1) ?? ''
    assert.match(detail, /积分周期详情 primary：月 2026-10/)
    assert.match(detail, /起止：2026-10-01 00:00 至 2026-11-01 00:00（北京时间，UTC\+8）/)
    assert.doesNotMatch(detail, /T00:00:00|16:00|最后修订：.*Z/)
  })
  it('groups canonical commands while preserving aliases, permissions and native help', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(help); app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    const cmd = (name: string) => app.$commander.get(name)!
    assert.deepEqual(cmd('xp').children.map(row => row.name), ['昵称管理', '账号管理', '积分', '积分系统', '档案维护', '业务快捷指令'])
    assert.equal(cmd('设置昵称').parent, cmd('昵称管理'))
    assert.equal(cmd('关联大小号').parent, cmd('账号管理'))
    assert.equal(cmd('大小号管理'), cmd('本群大小号'))
    assert.equal(cmd('积分.全部增加').parent, cmd('积分'))
    assert.equal(cmd('活动榜').parent, cmd('业务快捷指令'))
    assert.equal(cmd('增加活动分').parent, cmd('业务快捷指令'))
    const request = async (user: string, authority: number, input: string) => {
      const before = bot.output.length
      await bot.dispatchMessage(user, authority, input)
      assert.equal(bot.output.length, before + 1, input)
      return h.select(bot.output.at(-1)!, 'text').map(row => row.attrs.content).join('')
    }
    for (const authority of [1, 2, 5]) {
      const user = 'level' + authority
      const root = await request(user, authority, 'xp')
      assert.match(root, /账号管理/)
      assert.equal(root.includes('档案维护'), authority === 5)
      assert.equal(root.includes('积分系统'), authority === 5)
      const accounts = await request(user, authority, '账号管理')
      assert.match(accounts, /我的账号/)
      assert.equal(accounts.includes('关联大小号'), authority >= 2)
      const scores = await request(user, authority, '积分')
      assert.match(scores, /积分.查询/)
      assert.equal(scores.includes('积分.增加'), authority >= 2)
      const bindings = await request(user, authority, '业务快捷指令')
      assert.match(bindings, /活动榜/)
      assert.equal(bindings.includes('增加活动分'), authority >= 2)
    }
    const globalHelp = await request('level5', 5, 'help')
    assert.match(globalHelp, /xp/)
    assert.doesNotMatch(globalHelp, /设置账号昵称|增加活动分/)
    assert.match(await request('level2', 2, 'help 设置昵称'), /设置昵称/)
    assert.match(await request('level1', 1, '活动榜'), /榜为空/)
    const before = await app.database.get('xp_score_system', {})
    await request('level2', 2, '积分系统.创建 blocked global 不得创建')
    assert.deepEqual(await app.database.get('xp_score_system', {}), before)
    assert.equal((await app.database.get('xp_profile', {})).length, 0)
  })

  it('rejects external-name and normalized alias conflicts before any registration', () => {
    for (const name of ['xp', '账号管理', '大小号管理', '活动榜']) {
      const app = new App()
      const existing = app.command(name).action(() => 'unchanged')
      const bindings = [{ systemKey: 'primary', action: 'leaderboard' as const, command: '活动榜' }]
      assert.throws(() => assertXpCommandNamesAvailable(app, bindings), /冲突/)
      assert.equal(app.$commander.get(name), existing)
      assert.equal(existing.parent, null)
    }
    for (const names of [['XP'], ['Case', 'case'], ['same_name', 'same-name']]) {
      const app = new App()
      assert.throws(() => assertXpCommandNamesAvailable(app, names.map(command => ({ systemKey: 'primary', action: 'query', command }))), /重复/)
      assert.equal(app.$commander.get('xp'), undefined)
    }
  })

  it('pages many business shortcuts without help and retains mixed-case command metadata', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' })
    app.plugin(xpPoints, pluginConfig({ bindings: [{ systemKey: 'primary', query: Array.from({ length: 21 }, (_, i) => `Score${i}`) }] }))
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    await bot.dispatchMessage('reader', 1, '业务快捷指令')
    assert.match(bot.output.at(-1)!, /第 1\/2 页；下一页：业务快捷指令 2/)
    assert.doesNotMatch(bot.output.at(-1)!, /Score20/i)
    await bot.dispatchMessage('reader', 1, '业务快捷指令 2')
    assert.match(bot.output.at(-1)!, /Score20：primary · 查分/i)
    assert.doesNotMatch(bot.output.at(-1)!, /Score0：/i)
    await bot.dispatchMessage('reader', 1, '业务快捷指令 3')
    assert.match(bot.output.at(-1)!, /当前只有 2 页/)
  })

  it('disposes the entire command tree and reloads without duplicate actions', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' })
    const external = app.command('external').action(() => 'external')
    const fork = app.plugin(xpPoints, pluginConfig())!
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    const old = app.$commander.get('关联大小号')
    await fork.dispose()
    for (const name of ['xp', '昵称管理', '设置昵称', '大小号管理', '关联大小号', '积分.增加', '活动榜']) {
      assert.equal(app.$commander.get(name), undefined, name)
    }
    assert.equal(app.$commander.get('external'), external)
    app.plugin(xpPoints, pluginConfig())
    const deadline = Date.now() + 5000
    while (!app.$commander.get('关联大小号') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.notEqual(app.$commander.get('关联大小号'), old)
    await bot.dispatchMessage('admin', 2, '关联大小号')
    assert.equal(bot.output.length, 1)
    assert.equal(h.select(bot.output[0], 'text').map(row => row.attrs.content).join(''), associationHelp)
  })

  it('uses the same complete association guide for bare commands, help and README', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(help); app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    const visible = () => h.select(bot.output.at(-1) ?? '', 'text').map(row => row.attrs.content).join('')
    for (const input of ['关联大小号', '关联大小号 @first']) {
      await bot.dispatchMessage('admin', 2, input)
      assert.equal(visible(), associationHelp)
    }
    await bot.dispatchMessage('admin', 2, 'help 关联大小号')
    assert.ok(visible().includes(associationHelp), visible())
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    assert.ok(readme.includes('```text\n' + associationHelp + '\n```'))
    assert.equal((await app.database.get('xp_profile', {})).length, 0)
  })

  it('explains all-system and single-system modes identically in bare and native help', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(help); app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    const visible = () => h.select(bot.output.at(-1) ?? '', 'text').map(row => row.attrs.content).join('')
    for (const input of ['账号模式', '账号模式 primary']) {
      await bot.dispatchMessage('admin', 2, input)
      assert.equal(visible(), accountModeHelp)
    }
    await bot.dispatchMessage('admin', 2, 'help 账号模式')
    assert.ok(visible().includes(accountModeHelp), visible())
    assert.equal((await app.database.get('xp_profile', {})).length, 0)
  })
  it('looks up exact managed nicknames with permissions, filters and no account creation', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    await app.xpPoints.ensureManagedIdentity('onebot', 'member', '示例 玩家')
    await app.xpPoints.ensureManagedIdentity('onebot', 'other', '其他玩家')
    const before = await app.database.get('xp_profile', {})
    await bot.dispatchMessage('admin', 2, '大小号情况 -n "示例 玩家" -s primary --page 1')
    assert.match(bot.output.at(-1)!, /示例 玩家[\s\S]*活动积分/)
    assert.equal(bot.deliveries.at(-1)!.channelId, 'guild')
    await bot.dispatchMessage('member', 1, '大小号情况 -n "示例 玩家"', true)
    assert.match(bot.output.at(-1)!, /示例 玩家/)
    await bot.dispatchMessage('other', 1, '大小号情况 -n "示例 玩家"')
    assert.match(bot.output.at(-1)!, /只能查询本人/)
    await bot.dispatchMessage('admin', 2, '大小号情况 -n "不存在"')
    assert.match(bot.output.at(-1)!, /未找到该管理昵称/)
    await bot.dispatchMessage('admin', 2, '大小号情况 @member -n "示例 玩家"')
    assert.match(bot.output.at(-1)!, /只提供/)
    await bot.dispatchMessage('admin', 2, '大小号情况 -n "示例 玩家" -s absent')
    assert.match(bot.output.at(-1)!, /积分系统不存在/)
    await bot.dispatchMessage('admin', 2, '大小号情况 -n "示例 玩家" --page 999')
    assert.match(bot.output.at(-1)!, /当前只有/)
    assert.deepEqual(await app.database.get('xp_profile', {}), before)
  })
  it('renders usage placeholders as visible text rather than message elements, including native help', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(help)
    app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    for (const [command, expected] of [
      ['设置账号标签', '<标签>'], ['设置账号昵称', '<昵称>'], ['设置主号', '<@账号或@平台:账号>'],
      ['关联大小号', '<@主号>'], ['账号模式', '<共享|独立>'], ['积分.全部增加', '<数值>'],
      ['积分.设置', '<系统 key>'], ['积分系统.创建', '<global|platform|guild>'],
      ['昵称', '<管理昵称>'], ['档案维护.删除档案', '<管理昵称>'], ['设置活动分', '<用户>'],
      ['积分', '积分.查询'], ['积分系统', '积分系统.创建'], ['档案维护', '档案维护.查看'],
    ]) {
      await bot.dispatchMessage('owner', 5, command)
      const output = bot.output.at(-1) ?? ''
      assert.ok(h.select(output, 'text').map(row => row.attrs.content).join('').includes(expected), command + ': ' + output)
      assert.ok(h.parse(output).every(row => row.type === 'text'), command)
    }
    for (const command of ['设置账号标签', '设置账号昵称', '设置主号']) {
      await bot.dispatchMessage('owner', 5, 'help ' + command)
      const visible = h.select(bot.output.at(-1) ?? '', 'text').map(row => row.attrs.content).join('')
      assert.ok(visible.includes(command) && visible.includes('123456'), visible)
    }
    assert.equal((await app.database.get('xp_profile', {})).length, 0)
  })
  it("turns a colliding nickname into a same-conversation bound preview instead of silently merging", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    const first = await app.xpPoints.ensureManagedIdentity("onebot", "first", "First")
    const second = await app.xpPoints.ensureManagedIdentity("onebot", "second", "Second")
    await bot.dispatchMessage("admin", 2, "设置昵称 First @second")
    assert.equal((await app.xpPoints.getManagedIdentity("onebot", "second"))!.profileId, second.profileId)
    const preview = bot.output.at(-1) ?? ""
    assert.match(preview, /大小号关联预览.*合并两个真人档案/s)
    assert.match(preview, /不推断或改变主号/)
    const token = preview.match(/XPACCOUNT-[A-Za-z0-9_-]{32}/)?.[0]
    assert.ok(token, preview)
    assert.equal((await app.xpPoints.getManagedIdentity("onebot", "second"))!.profileId, second.profileId)
    await bot.dispatchMessage("admin", 2, token, true)
    assert.match(bot.output.at(-1) ?? '', /原操作者/)
    assert.equal((await app.xpPoints.getManagedIdentity("onebot", "second"))!.profileId, second.profileId)
    await bot.dispatchMessage("admin", 2, token)
    assert.equal((await app.xpPoints.getManagedIdentity("onebot", "second"))!.profileId, first.profileId)
    assert.equal((await app.database.get('xp_account', { id: second.accountId }))[0].nickname, 'Second')
  })
  it("rejects authority 1 mutations, permits authority 2, and keeps reads public", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start()
    apps.push(app)
    bot.online()

    await bot.dispatchMessage("ordinary", 1, "昵称 Ordinary")
    assert.equal(await app.xpPoints.getManagedIdentity("onebot", "ordinary"), null)
    assert.match(bot.output.join("\n"), /权限不足|权限过低|权限/)

    await bot.dispatchMessage("admin", 2, "昵称 AdminName")
    assert.equal((await app.xpPoints.getManagedIdentity("onebot", "admin"))?.nickname, "AdminName")
    assert.match(bot.output.join("\n"), /管理昵称设置为“AdminName”/)

    await bot.dispatchMessage("ordinary", 1, "活动榜")
    assert.match(bot.output.at(-1) ?? "", /活动积分榜为空/)
  })

  it("requires authority 5 for member scans", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start()
    apps.push(app)
    bot.online()

    await bot.dispatchMessage("operator", 4, "档案维护.扫描成员")
    assert.match(bot.output.at(-1) ?? "", /权限不足|权限过低|权限/)
    await bot.dispatchMessage("owner", 5, "档案维护.扫描成员")
    assert.match(bot.output.at(-1) ?? "", /成员状态扫描仅预览/)
  })

  it("requires authority 5 for token-bound profile deletion", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start()
    apps.push(app)
    bot.online()
    await app.xpPoints.ensureManagedIdentity("onebot", "victim", "Victim")

    await bot.dispatchMessage("operator", 4, "档案维护.删除账号 @victim")
    assert.match(bot.output.at(-1) ?? "", /权限不足|权限过低|权限/)
    assert.ok(await app.xpPoints.getManagedIdentity("onebot", "victim"))

    await bot.dispatchMessage("owner", 5, "档案维护.删除账号 @victim")
    const preview = bot.output.at(-1) ?? ""
    assert.match(preview, /档案删除预览/)
    const token = preview.match(/确认令牌：([^（\s]+)/)?.[1]
    assert.ok(token)
    await bot.dispatchMessage("operator", 4, token)
    assert.match(bot.output.at(-1) ?? "", /权限不足|权限过低|权限/)
    assert.ok(await app.xpPoints.getManagedIdentity("onebot", "victim"))
    await bot.dispatchMessage("owner", 5, token)
    assert.match(bot.output.at(-1) ?? "", /档案删除完成/)
    assert.equal(await app.xpPoints.getManagedIdentity("onebot", "victim"), null)
  })

  it("uses the target platform nickname for first-time administrator score operations", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    bot.nativeNames.set("victim", "Platform Victim")
    await app.start()
    apps.push(app)
    bot.online()

    await bot.dispatchMessage("admin", 2, "增加活动分 2 @victim")
    assert.equal((await app.xpPoints.getManagedIdentity("onebot", "victim"))?.nickname, "Platform Victim")
    assert.match(bot.output.at(-1) ?? "", /Platform Victim.*现为 2/)
  })

  it("shows usage for incomplete commands without writing profiles", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start()
    apps.push(app)
    bot.online()

    for (const command of [
      "昵称",
      "设置昵称",
      "活动分",
      "自己加活动分",
      "设置活动分",
      "增加活动分",
      "积分.查询",
      "积分.排行",
      "积分.设置",
      "积分.增加",
      "档案维护.删除账号",
      "档案维护.删除档案",
      "档案维护.查看",
      "积分系统.日志",
    ]) {
      await bot.dispatchMessage("owner", 5, command)
      assert.match(bot.output.at(-1) ?? "", /用法/)
    }
    await bot.dispatchMessage("owner", 5, "档案维护")
    assert.match(bot.output.at(-1) ?? "", /直接粘贴确认令牌/)
    assert.equal((await app.database.get("xp_profile", {})).length, 0)
  })

  it("enforces generic ledger authority and confirms system deletion by pasted token", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    bot.nativeNames.set("victim", "Platform Victim")
    await app.start()
    apps.push(app)
    bot.online()

    await bot.dispatchMessage("operator", 4, "积分系统.创建 event global 临时积分 星")
    assert.match(bot.output.at(-1) ?? "", /权限不足|权限过低|权限/)
    await bot.dispatchMessage("owner", 5, "积分系统.创建 event global 临时积分 星")
    assert.match(bot.output.at(-1) ?? "", /已创建积分系统 event/)

    await bot.dispatchMessage("ordinary", 1, "积分.增加 event 2 @victim")
    assert.match(bot.output.at(-1) ?? "", /权限不足|权限过低|权限/)
    await bot.dispatchMessage("admin", 2, "积分.增加 event 2 @victim")
    assert.match(bot.output.at(-1) ?? "", /现为 2星/)
    await bot.dispatchMessage("ordinary", 1, "积分.查询 event @victim")
    assert.match(bot.output.at(-1) ?? "", /临时积分为 2星/)

    await bot.dispatchMessage("owner", 5, "积分系统.删除 event")
    const preview = bot.output.at(-1) ?? ""
    assert.match(preview, /积分系统删除预览/)
    const token = preview.match(/确认令牌：([^（\s]+)/)?.[1]
    assert.ok(token)
    await bot.dispatchMessage("owner", 5, token)
    assert.match(bot.output.at(-1) ?? "", /积分系统 event 删除完成/)
    assert.equal((await app.database.get("xp_score_system", { key: "event" })).length, 0)
  })

  it("does not create a game-specific system when used standalone", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig({ systems: [], bindings: [] }))
    const bot = new AuthorityBot(app)
    await app.start()
    apps.push(app)
    bot.online()

    assert.deepEqual(await app.xpPoints.listScoreSystems(), [])
    await bot.dispatchMessage("ordinary", 1, "积分")
    assert.match(bot.output.at(-1) ?? "", /暂无积分系统/)
  })

  it("keeps independently configured business commands in separate ledgers", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig({
      systems: [
        ...scoreSystems,
        { key: "season", name: "赛季积分", unit: "点", scope: "guild" },
      ],
      bindings: [
        ...primaryBindings,
        {
          systemKey: "season",
          query: [],
          leaderboard: ["赛季榜"],
          setSelf: ["赛季分"],
          addSelf: ["自己加赛季分"],
          setTarget: ["设置赛季分"],
          addTarget: ["增加赛季分"],
        },
      ],
    }))
    const bot = new AuthorityBot(app)
    await app.start()
    apps.push(app)
    bot.online()

    await bot.dispatchMessage("admin", 2, "活动分 4")
    await bot.dispatchMessage("admin", 2, "赛季分 9")
    await bot.dispatchMessage("admin", 2, "积分.查询 primary")
    assert.match(bot.output.at(-1) ?? "", /活动积分为 4分/)
    await bot.dispatchMessage("admin", 2, "积分.查询 season")
    assert.match(bot.output.at(-1) ?? "", /赛季积分为 9点/)
    await bot.dispatchMessage("ordinary", 1, "赛季榜")
    assert.match(bot.output.at(-1) ?? "", /赛季积分榜.*admin 9点/s)
  })

  it("offers paged business leaderboards and administrator audit views", async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ":memory:" })
    app.plugin(xpPoints, pluginConfig({ leaderboardPageSize: 10 }))
    const bot = new AuthorityBot(app)
    await app.start()
    apps.push(app)
    bot.online()

    for (let index = 1; index <= 11; index++) {
      const userId = `player-${index}`
      bot.nativeNames.set(userId, `Player ${index}`)
      await bot.dispatchMessage("admin", 2, `增加活动分 ${index} @${userId}`)
    }
    await bot.dispatchMessage("ordinary", 1, "活动榜 2")
    assert.match(bot.output.at(-1) ?? "", /第 2\/2 页，共 11 个条目/)

    await bot.dispatchMessage("owner", 5, "档案维护.查看 Player 11")
    assert.match(bot.deliveries.filter(row => row.channelId === 'guild').at(-1)?.content ?? '',
      /档案 #\d+：Player 11.*积分余额：.*primary 共享 11分/s)
    assert.ok(!bot.deliveries.some(row => row.channelId === 'private:owner'))
    await bot.dispatchMessage("owner", 5, '档案维护.查看 --page 999 Player 11', true)
    assert.match(bot.output.at(-1) ?? '', /当前只有 1 页/)
    await bot.dispatchMessage("owner", 5, "积分系统.日志 primary")
    assert.match(bot.output.at(-1) ?? "", /积分日志 primary（第 1\/2 页，共 11 条）/)
  })

  it('paginates profile inspection without dumping every presence into the group', async () => {
    const app = new App({ autoAssign: true, autoAuthorize: 1 })
    app.plugin(SQLiteDriver, { path: ':memory:' }); app.plugin(xpPoints, pluginConfig())
    const bot = new AuthorityBot(app)
    await app.start(); apps.push(app); bot.online()
    await app.xpPoints.ensureManagedIdentity('onebot', 'many', 'Many Pools')
    for (let i = 0; i < 120; i++) await app.database.create('xp_guild_presence', {
      platform: 'onebot', userId: 'many', guildId: 'known-guild-' + i, state: 'active', reason: 'historical membership',
      firstConfirmedAt: new Date(), lastConfirmedAt: new Date(), inactiveAt: null })
    await bot.dispatchMessage('owner', 5, '档案维护.查看 Many Pools')
    const text = bot.deliveries.filter(row => row.channelId === 'guild').at(-1)!.content
    assert.ok(text.length < 3300)
    assert.match(text, /下一页/)
    assert.ok(!bot.deliveries.some(row => row.channelId === 'private:owner'))
    const next = h.parse(text).map(row => row.type === 'text' ? row.attrs.content : '').join('').match(/下一页：(.+)/)![1]
    await bot.dispatchMessage('owner', 5, next)
    assert.match(bot.output.at(-1) ?? '', /第 2\//)
  })
})
