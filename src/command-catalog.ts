import { Command, h, type Context, type Session, type Computed } from 'koishi'
import type { NormalizedScoreCommandBinding } from './score-command-bindings'

/** Shared command documentation: raw text, escaped only at the message boundary. */
export const associationHelp = `用法：关联大小号 <@小号> <@主号>
第一个是要加入的小号，第二个是接收方主号；第二个账号会成为主号。
默认只移动第一个账号；若它原来只有一个账号，则合并该单账号档案。
--merge-persons：把小号原属组的全部账号一起并入主号所在组；决定“移动谁”，不是积分累加。
--mode 共享|独立：统一指定本次全部系统及未来默认计分方式；省略时采用主号所属真人的默认方式。
--modes 系统:共享|独立：单独指定某系统，优先于 --mode；未写的系统沿用本次默认方式。多个系统用逗号分隔。
--strategies 系统:maximum|sum：共享合分取最高（maximum）或累加（sum），不决定移动哪些账号。
--period-strategies 系统:maximum|sum：周期成绩单独选择，默认逐周期取最高；累计累加不会自动累加周期。
--source-keep @原组承接人 / --target-keep @目标组承接人：多账号共享组转独立时指定谁承接原共享余额，其余零分；两个单账号无需填写。
先核对全部系统、全部积分池和负分影响，再在原会话粘贴令牌确认；不是只修改当前群。
用“积分”查看实际系统 key；示例中的 event 需换成该 key。
普通关联：关联大小号 @onebot:123456 @onebot:654321
独立关联：关联大小号 @onebot:123456 @onebot:654321 --mode 独立
整组合并：关联大小号 @onebot:123456 @onebot:654321 --merge-persons`

export const associationExamples = [
  '关联大小号 @onebot:123456 @onebot:654321',
  '关联大小号 @onebot:123456 @onebot:654321 --mode 独立',
  '关联大小号 @onebot:123456 @onebot:654321 --merge-persons',
]

export const accountModeHelp = `用法：账号模式 <共享|独立> [-u @账号] [-r @承接账号] [--strategy maximum|sum]
统一此人的全部现有系统（含停用）和未来默认；不改变统一昵称和大小号关系。
仅改一个系统：账号模式 <系统 key> <共享|独立> [-u @账号] [-r @承接账号]
各系统方式不同是正常设置，不需要统一；单系统操作不改变未来默认。
共享转独立：指定同一个承接账号接收原共享余额，其余零分；已经独立的系统不动。
独立转共享：默认取最高；管理员可选 sum 累加，本人只能 maximum 且不得利用负分转换。
--period-strategy maximum|sum：单独指定周期成绩合分，默认最高；本人不能累加周期成绩。
普通用户只能整理本人已关联账号；管理员可用 -u 指定他人。先预览，再在原会话粘贴令牌。
示例：账号模式 共享
示例：账号模式 独立 -r @onebot:123456
示例：账号模式 event 独立 -r @onebot:123456（event 替换为“积分”列出的实际 key）`

const groups = {
  昵称管理: { authority: 1, description: '统一管理昵称' },
  账号管理: { authority: 1, description: '大小号关系、账号详情与模式' },
  积分: { authority: 1, description: '积分查询、排行与变更' },
  积分系统: { authority: 5, description: '积分系统定义与审计' },
  档案维护: { authority: 5, description: '档案检查、成员扫描与删除' },
  业务快捷指令: { authority: 1, description: '配置绑定的积分快捷指令' },
} as const
type Group = keyof typeof groups
const entries: Array<[string, Group, string]> = [
  ['昵称', '昵称管理', '设置本人管理昵称'], ['设置昵称', '昵称管理', '设置指定用户管理昵称'],
  ['我的账号', '账号管理', '查看本人账号与积分'], ['大小号情况', '账号管理', '按账号或管理昵称查询详情'],
  ['本群大小号', '账号管理', '当前平台的大小号管理列表'], ['取消账号操作', '账号管理', '取消当前会话确认'],
  ['关联大小号', '账号管理', '小号在前、主号在后，预览后确认'], ['账号模式', '账号管理', '切换共享/独立积分模式'],
  ['设置主号', '账号管理', '选择主号'], ['设置账号标签', '账号管理', '修改账号标签'], ['设置账号昵称', '账号管理', '修改账号显示昵称'],
  ...['查询', '排行', '设置', '增加', '全部增加', '全部设置'].map(name => [`积分.${name}`, '积分', `${name}积分`] as [string, Group, string]),
  ...['创建', '重命名', '修改单位', '启用', '停用', '日志', '群挂靠重映射', '删除'].map(name => [`积分系统.${name}`, '积分系统', `${name}积分系统`] as [string, Group, string]),
  ...['查看', '扫描成员', '删除账号', '删除档案'].map(name => [`档案维护.${name}`, '档案维护', name] as [string, Group, string]),
]
export const xpReservedCommands = ['xp', ...Object.keys(groups), ...entries.map(row => row[0]), '大小号管理']

/** Check *before* registering anything. Koishi otherwise patches an existing
 * command silently; aliases normalize case and underscores as well. */
export function assertXpCommandNamesAvailable(ctx: Context, bindings: NormalizedScoreCommandBinding[]) {
  const names = [...xpReservedCommands, ...bindings.map(row => row.command),
    ...(!bindings.some(row => Command.normalize(row.command) === Command.normalize('积分榜')) ? ['积分榜'] : [])]
  const owned = new Set<string>()
  for (const raw of names) {
    const name = Command.normalize(raw)
    if (owned.has(name)) throw new Error(`XP 指令名称重复：${raw}`)
    owned.add(name)
    if (ctx.$commander.get(name)) throw new Error(`XP 指令“${raw}”与已注册指令冲突，请调整别名后重新加载。`)
  }
}

export function createXpCommandTree(ctx: Context, bindings: NormalizedScoreCommandBinding[]) {
  assertXpCommandNamesAvailable(ctx, bindings)
  const metadata = new Map(entries.map(([name, group, description]) => [name, { group, description }]))
  const actions = { query: '查分', leaderboard: '排行榜', setSelf: '设置本人积分', addSelf: '增加本人积分', setTarget: '设置指定账号积分', addTarget: '增加指定账号积分' }
  for (const row of bindings) metadata.set(Command.normalize(row.command), {
    group: '业务快捷指令', description: `${row.systemKey} · ${actions[row.action]}`,
  })
  const registered = new Map<string, Command>()
  const root = ctx.command('xp', '统一昵称、账号与多积分账本', { authority: 1 })
  registered.set('xp', root)
  for (const [name, settings] of Object.entries(groups)) {
    registered.set(name, root.subcommand(name === '业务快捷指令' ? `${name} [page:posint]` : name, settings.description, { authority: settings.authority }))
  }
  const navigation = async (name: string, session: Session, page = 1) => {
    const parent = registered.get(name)!
    const visible: string[] = []
    for (const child of parent.children) {
      if (!child.match(session) || !await ctx.permissions.test(`command:${child.name}`, session)) continue
      if (session.resolve((child.config as { hidden?: Computed<boolean> }).hidden)) continue
      const description = metadata.get(child.name)?.description ?? groups[child.name as Group]?.description ?? ''
      visible.push(`${child.displayName}：${description}`)
    }
    // Business bindings are unbounded; every page is accessible without help.
    const pages = Math.max(1, Math.ceil(visible.length / 18))
    if (!Number.isSafeInteger(page) || page < 1 || page > pages) return `当前只有 ${pages} 页，请使用“${name} 1”。`
    const shown = visible.slice((page - 1) * 18, page * 18)
    if (pages > 1) shown.push(`第 ${page}/${pages} 页` + (page < pages ? `；下一页：${name} ${page + 1}` : ''))
    return `${name} 指令导航\n${shown.join('\n') || '当前没有可用子指令。'}\n可直接使用原短命令；输入命令查看用法。`
      + (name === '档案维护' ? '\n删除先预览，再在原会话直接粘贴确认令牌。' : '')
  }
  for (const name of ['xp', '昵称管理', '账号管理', '业务快捷指令']) {
    registered.get(name)!.userFields(['authority']).action(async ({ session }, page) => h.text(await navigation(name, session, page)))
  }
  const register = ((declaration: string, ...args: any[]) => {
    const name = Command.normalize(declaration.split(' ')[0])
    const info = metadata.get(name)
    const description = typeof args[0] === 'string' ? args.shift() : info?.description ?? ''
    const config = args[0] ?? {}
    if (!info && !(name in groups)) throw new Error(`未登记的 XP 指令：${name}`)
    const path = name in groups ? `xp/${declaration}`
      : name.includes('.') ? declaration : `${info!.group}/${declaration}`
    const command = ctx.command(path, description, config)
    registered.set(name, command)
    const labels: Record<string, string> = { system: '系统 key', key: '系统 key', points: '数值', target: '用户', page: '页码', periodOrPage: '周期或页码', nick: '管理昵称', nickname: '管理昵称', displayName: '名称', scope: 'global|platform|guild', unit: '单位', mode: '模式' }
    const usage = name === '关联大小号' ? associationHelp : `用法：${declaration.replace(/([<\[])(\w+):[a-z]+(?=[>\]])/g, (_, open, key) => open + (labels[key] ?? key))}`
    command.usage(h.text(usage).toString())
    return command
  }) as Context['command']
  return { command: register, navigation }
}
