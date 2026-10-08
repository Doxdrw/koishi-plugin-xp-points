import { Command, Context, Schema, Session, h } from 'koishi'
import { safeErrorSummary } from './errors'
import { registerAccountModels } from './account-model'
import { accountDetailPage, registerAccountCommands } from './account-commands'
import { assertXpCommandNamesAvailable, createXpCommandTree, xpReservedCommands } from './command-catalog'
import {
  chooseChatLunaMessageName,
  consumerApplies,
  NicknameConsumerConfig,
  rewriteCharacterMessageNames,
} from './core'
import { registerModels } from './model'
import { normalizeScoreCommandBindings } from './score-command-bindings'
import type { ScoreCommandBindingConfig, ScoreSystemDefinition } from './score-ledger'
import { XpPointsRuntimeConfig, XpPointsService, XpPointsUserError } from './service'
import type { GuildAliasCombineStrategy } from './guild-alias-policy'

export const name = 'xp-points'

export const inject = {
  required: ['database'],
  optional: ['chatluna', 'chatluna_character'],
}

export interface Config extends XpPointsRuntimeConfig {
  nicknameConsumers: {
    chatluna: NicknameConsumerConfig
    chatlunaCharacter: NicknameConsumerConfig
  }
}

function createConsumerSchema(title: string): Schema<NicknameConsumerConfig> {
  return Schema.object({
    enabled: Schema.boolean().default(false).description('使用统一管理昵称适配该插件的用户名称。'),
    guilds: Schema.array(Schema.string()).default([]).description('群号白名单；空为全部群聊。'),
    includePrivate: Schema.boolean().default(false).description('同时适配私聊中的用户名称。'),
  }).description(title).default({ enabled: false, guilds: [], includePrivate: false })
}

const ScoreSystemSchema: Schema<ScoreSystemDefinition> = Schema.object({
  key: Schema.string().description('系统标识 key；改为其他 key 会声明另一个系统，已有系统保留。'),
  name: Schema.string().description('首次创建时的显示名称；已有系统通过积分系统指令重命名。'),
  unit: Schema.string().default('分').description('首次创建时的积分单位；已有系统通过积分系统指令修改。'),
  scope: Schema.union([
    Schema.const('global').description('全局积分池'),
    Schema.const('platform').description('按平台划分'),
    Schema.const('guild').description('按群积分池划分'),
  ]).description('首次创建时的积分作用域，创建后保持固定。'),
})

const ScoreCommandBindingSchema: Schema<ScoreCommandBindingConfig> = Schema.object({
  systemKey: Schema.string().description('这些快捷指令使用的积分系统 key。'),
  query: Schema.array(Schema.string()).default([]).description('查询本人或指定用户积分的命令名。'),
  leaderboard: Schema.array(Schema.string()).default([]).description('排行榜命令名。'),
  setSelf: Schema.array(Schema.string()).default([]).description('管理员设置本人积分的命令名。'),
  addSelf: Schema.array(Schema.string()).default([]).description('管理员增加本人积分的命令名。'),
  setTarget: Schema.array(Schema.string()).default([]).description('管理员设置指定用户积分的命令名。'),
  addTarget: Schema.array(Schema.string()).default([]).description('管理员增加指定用户积分的命令名。'),
}).collapse()

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    scoreSystems: Schema.array(ScoreSystemSchema).default([]).collapse()
      .description('首次创建的系统声明；已有系统的名称、单位和启停通过“积分系统”指令管理。空为仅使用管理员或消费插件创建的系统。'),
  }).description('预置积分系统'),
  Schema.object({
    accountDefaults: Schema.object({
      mode: Schema.union([
        Schema.const('shared').required().description('共享积分'),
        Schema.const('independent').required().description('账号分别计分'),
      ]).default('shared').description('新真人的初始默认计分方式；新系统继承真人保存的默认，可用“账号模式”调整。'),
      combineStrategy: Schema.union([
        Schema.const('maximum').required().description('取最高'),
        Schema.const('sum').required().description('累加（管理员）'),
      ]).default('maximum').description('关联时共享合分的默认策略；累加需管理员确认，已有余额保持现状。'),
    }).default({ mode: 'shared', combineStrategy: 'maximum' }),
  }).description('账号默认与合分'),
  Schema.object({
    leaderboardInactivePolicy: Schema.union([
      Schema.const('hide').description('隐藏'),
      Schema.const('show').description('保留并标注'),
    ]).default('hide').description('已确认停用档案的榜单显示方式；隐藏仅影响展示，积分保留。'),
    leaderboardPageSize: Schema.number().min(10).max(200).step(1).default(50)
      .description('积分榜与审计日志每页的条数上限。'),
    leaderboardEntriesPerLine: Schema.number().min(1).max(5).step(1).default(3)
      .description('文本积分榜每行显示的人数。'),
  }).description('排行榜显示'),
  Schema.object({
    scorePeriods: Schema.dict(Schema.object({
      timeZone: Schema.string().default('Asia/Shanghai').description('周期边界使用的 IANA 时区，默认北京时间。'),
      season: Schema.object({
        unit: Schema.union([
          Schema.const('month').required().description('自然月'),
          Schema.const('day').required().description('天'),
        ]).default('month').description('赛季长度的日历单位。'),
        length: Schema.natural().min(1).max(3660).default(1).description('赛季长度 N：每 N 天或 N 个自然月。'),
        start: Schema.string().default('1970-01-01').description('赛季起点（YYYY-MM-DD）；默认每月1日换季。'),
      }).description('赛季规则'),
    })).default({}).collapse()
      .description('以系统 key 为键；空为北京时间自然月赛季。已开始赛季保持边界，赛季变更从下赛季生效。'),
  }).description('周期与赛季'),
  Schema.object({
    scoreCommandBindings: Schema.array(ScoreCommandBindingSchema).default([]).collapse()
      .description('为各系统的查询、排行和管理员改分绑定短命令；名称不能与现有指令冲突。'),
  }).description('业务快捷指令'),
  Schema.object({
    nicknameConsumers: Schema.object({
      chatluna: createConsumerSchema('ChatLuna'),
      chatlunaCharacter: createConsumerSchema('ChatLuna Character'),
    }).default({
      chatluna: { enabled: false, guilds: [], includePrivate: false },
      chatlunaCharacter: { enabled: false, guilds: [], includePrivate: false },
    }),
  }).description('昵称适配'),
  Schema.object({
    scoreGuildAliasDefaults: Schema.object({
      balance: Schema.union([
        Schema.const('maximum').required().description('取最高'),
        Schema.const('sum').required().description('累加（管理员确认）'),
      ]).default('maximum').description('新群挂靠默认的累计积分合并策略。'),
      period: Schema.union([
        Schema.const('maximum').required().description('取最高'),
        Schema.const('sum').required().description('累加（管理员确认）'),
      ]).default('maximum').description('新群挂靠默认的周期成绩合并策略。'),
    }).default({ balance: 'maximum', period: 'maximum' }),
  }).description('群挂靠默认策略'),
  Schema.object({
    scoreGuildAliases: Schema.dict(Schema.dict(Schema.dict(Schema.string()))).default({}).collapse()
      .description('映射顺序：系统 key → 平台 → 来源群号 → 积分归属群号。配置变更通过“群挂靠重映射”预览确认；默认策略只影响之后确认的变更。'),
  }).description('群积分池挂靠（高级）'),
  Schema.object({
    memberScanPreviewLimit: Schema.number().min(10).max(1000).step(1).default(100)
      .description('成员扫描预览最多展开的变化条数；实际扫描和执行不受此限制。'),
    requiredDeletionConsumers: Schema.array(Schema.string()).default([])
      .description('整档硬删除前必须加载的身份消费插件注册名，用于联动清理。'),
  }).description('维护与删除安全'),
])

declare module 'koishi' {
  interface Context {
    xpPoints: XpPointsService
  }
}

function requireGuild(session: Session): string {
  if (!session.guildId) throw new XpPointsUserError('积分操作仅支持群聊。')
  return session.guildId
}

function nativeSenderName(session: any): string {
  return [
    session?.author?.name,
    session?.event?.user?.name,
    session?.event?.member?.user?.name,
    session?.username,
    session?.author?.nick,
    session?.event?.member?.nick,
    session?.userId,
  ].find(value => typeof value === 'string' && value.trim().length > 0)?.trim() ?? ''
}

function parseTarget(target: string | undefined): { platform: string, userId: string } | null {
  if (!target) return null
  const separator = target.lastIndexOf(':')
  if (separator <= 0 || separator >= target.length - 1) return null
  return { platform: target.slice(0, separator), userId: target.slice(separator + 1) }
}

async function targetNativeName(session: Session, target: string): Promise<string | undefined> {
  const parsed = parseTarget(target)
  if (!parsed || parsed.platform !== session.platform) return undefined
  try {
    const user = await session.bot.getUser(parsed.userId)
    if (user?.name?.trim()) return user.name.trim()
  } catch {}
  if (session.guildId) {
    try {
      const member = await session.bot.getGuildMember(session.guildId, parsed.userId)
      const platformName = member?.user?.name?.trim()
      if (platformName) return platformName
      if (member?.nick?.trim()) return member.nick.trim()
    } catch {}
  }
  return undefined
}

async function runCommand<T>(ctx: Context, label: string, callback: () => Promise<T>): Promise<T | string> {
  try {
    return await callback()
  } catch (error) {
    if (error instanceof XpPointsUserError) return error.message
    ctx.logger.warn('%s失败：%s', label, safeErrorSummary(error))
    return `${label}失败，详细原因已记录。`
  }
}

function deletionActor(session: Session) {
  return {
    platform: session.platform,
    userId: session.userId,
    selfId: session.selfId ?? session.bot.selfId,
    channelId: session.channelId,
  }
}

function scoreContext(session: Session) {
  return { platform: session.platform, guildId: session.guildId }
}

const periodKinds = { 日: 'day', 周: 'week', 月: 'month', 年: 'year', 赛季: 'season', day: 'day', week: 'week', month: 'month', year: 'year', season: 'season' } as const
const periodNames = { day: '日', week: '周', month: '月', year: '年', season: '赛季' } as const
type LeaderboardOptions = { period?: string; date?: string; season?: string }

function parseLeaderboardPosition(periodOrPage: string | undefined, page: number | undefined, options: LeaderboardOptions = {}) {
  const parsed: LeaderboardOptions = { ...options }
  let parsedPage = page ?? 1
  if (periodOrPage !== undefined) {
    if (/^\d+$/.test(periodOrPage)) {
      if (page !== undefined) throw new XpPointsUserError('页码只能指定一次。')
      parsedPage = Number(periodOrPage)
    } else {
      if (page === undefined) parsedPage = 1
      if (parsed.period && parsed.period !== periodOrPage) throw new XpPointsUserError('位置参数与 --period 不能同时指定不同周期。')
      parsed.period = periodOrPage
    }
  }
  if (!Number.isSafeInteger(parsedPage) || parsedPage < 1) throw new XpPointsUserError('页码必须是正整数。')
  if (parsed.period && parsed.period !== '累计' && parsed.period !== 'total' && !periodKinds[parsed.period as keyof typeof periodKinds]) {
    throw new XpPointsUserError('周期请用日、周、月、年、赛季或累计。')
  }
  return { page: parsedPage, options: parsed }
}

function formatPeriodInstant(value: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

async function ensureSessionIdentity(ctx: Context, session: Session) {
  if (session.guildId) {
    return ctx.xpPoints.ensureManagedGuildIdentity(
      session.platform,
      session.userId,
      session.guildId,
      nativeSenderName(session),
    )
  }
  return ctx.xpPoints.ensureManagedIdentity(session.platform, session.userId, nativeSenderName(session))
}

async function confirmExistingSessionPresence(ctx: Context, session: Session): Promise<void> {
  if (!session.guildId) return
  if (!await ctx.xpPoints.getManagedIdentity(session.platform, session.userId)) return
  await ctx.xpPoints.markGuildPresence(
    session.platform,
    session.guildId,
    session.userId,
    'active',
    'guild-activity',
  )
}

function installChatLunaConsumer(ctx: Context, config: Config): void {
  if (!config.nicknameConsumers.chatluna.enabled) return
  let status: 'waiting' | 'connected' | 'incompatible' = 'waiting'
  ;(ctx as any).inject(['xpPoints', 'chatluna'], (child: Context) => {
    child.on('dispose', () => { status = 'waiting' })
    const chatluna = (child as any).chatluna
    const issues = chatLunaCompatibilityIssues(chatluna)
    status = issues.length ? 'incompatible' : 'connected'
    for (const issue of issues) child.logger.warn('ChatLuna 昵称适配未完整启用：%s', issue)
    const renderer = chatluna?.promptRenderer
    if (typeof renderer?.registerFunctionProvider === 'function') {
      try {
        const dispose = renderer.registerFunctionProvider(
          'sender_name',
          (_args: string[], _variables: Record<string, unknown>, configurable: any) => {
            const session = configurable?.session
            const fallback = nativeSenderName(session)
            if (!session || !consumerApplies(config.nicknameConsumers.chatluna, session)) {
              return fallback
            }
            return child.xpPoints.resolveNickname(
              session.platform,
              session.userId,
              fallback,
            ) ?? fallback
          },
        )
        if (typeof dispose === 'function') child.on('dispose', dispose)
        else {
          status = 'incompatible'
          child.logger.warn('ChatLuna sender_name 注册器没有返回可释放函数；第三方接口可能已经变化。')
        }
      } catch (error) {
        status = 'incompatible'
        child.logger.warn('ChatLuna sender_name 注册失败：%s', safeErrorSummary(error))
      }
    }

    const chain = chatluna?.chatChain
    if (typeof chain?.middleware === 'function') {
      try {
        const registration = chain.middleware('xp_points_managed_name', async (session: Session, context: any) => {
          if (!consumerApplies(config.nicknameConsumers.chatluna, session)) return 2
          context.options ??= {}
          const nickname = child.xpPoints.resolveNickname(session.platform, session.userId)
          const messageName = chooseChatLunaMessageName(
            context.options.messageName,
            context.options.invocation?.source?.kind,
            nickname,
          )
          if (messageName != null) context.options.messageName = messageName
          return 2
        }, child)
        if (typeof registration?.after !== 'function' || typeof registration?.before !== 'function') {
          status = 'incompatible'
          child.logger.warn('ChatLuna 消息链注册器缺少 after/before；管理昵称不会注入普通对话。')
        } else {
          registration.after('lifecycle-prepare').before('request_conversation')
        }
      } catch (error) {
        status = 'incompatible'
        child.logger.warn('ChatLuna 消息名称中间件注册失败：%s', safeErrorSummary(error))
      }
    }
  })
  ctx.on('ready', () => {
    if (status === 'waiting') ctx.logger.debug('ChatLuna 昵称适配等待 chatluna 服务加载，加载后自动接入。')
  })
}

function installCharacterConsumer(ctx: Context, config: Config): void {
  if (!config.nicknameConsumers.chatlunaCharacter.enabled) return
  let status: 'waiting' | 'connected' | 'incompatible' = 'waiting'
  ;(ctx as any).inject(['xpPoints', 'chatluna_character'], (child: Context) => {
    child.on('dispose', () => { status = 'waiting' })
    const character = (child as any).chatluna_character
    const issues = characterCompatibilityIssues(character)
    status = issues.length ? 'incompatible' : 'connected'
    for (const issue of issues) {
      child.logger.warn('ChatLuna Character 昵称适配可能不兼容：%s', issue)
    }
    child.on('chatluna_character/message_collect' as any, (session: Session, messages: any[]) => {
      if (!consumerApplies(config.nicknameConsumers.chatlunaCharacter, session)) return
      rewriteCharacterMessageNames(
        messages,
        session.platform,
        (platform, userId) => child.xpPoints.resolveNickname(platform, userId),
        new Set([session.selfId, session.bot.selfId].filter((id): id is string => Boolean(id))),
      )
    })
  })
  ctx.on('ready', () => {
    if (status === 'waiting') ctx.logger.debug('ChatLuna Character 昵称适配等待 chatluna_character 服务加载，加载后自动接入。')
  })
}

export function chatLunaCompatibilityIssues(chatluna: any): string[] {
  const issues: string[] = []
  if (typeof chatluna?.promptRenderer?.registerFunctionProvider !== 'function') {
    issues.push('缺少 promptRenderer.registerFunctionProvider，{sender_name} 不会生效。')
  }
  if (typeof chatluna?.chatChain?.middleware !== 'function') {
    issues.push('缺少 chatChain.middleware，普通对话 messageName 不会生效。')
  }
  return issues
}

export function characterCompatibilityIssues(character: any): string[] {
  return typeof character?.collect === 'function'
    ? []
    : ['缺少 MessageCollector.collect，message_collect 事件契约可能已经变化。']
}

export function apply(ctx: Context, config: Config): void {
  const scoreCommandBindings = normalizeScoreCommandBindings(config.scoreCommandBindings, xpReservedCommands)
  assertXpCommandNamesAvailable(ctx, scoreCommandBindings)
  registerModels(ctx)
  registerAccountModels(ctx)
  ctx.plugin(XpPointsService, config)

  ;(ctx as any).inject(['xpPoints'], (commands: Context) => {
  const tree = createXpCommandTree(commands, scoreCommandBindings)
  const registerCommand = tree.command
  const accountCommands = registerAccountCommands(commands, { operations: commands.xpPoints.accountOperations, queries: commands.xpPoints.accountQueries,
    command: registerCommand, defaults: config.accountDefaults, refresh: () => commands.xpPoints.reload() })
  const updatePresenceFromEvent = (
    state: 'active' | 'inactive',
    reason: 'member-added' | 'member-removed',
  ) => (session: Session) => {
    if (!session.guildId || !session.userId || session.userId === session.selfId) return
    void commands.xpPoints.markGuildPresence(
      session.platform,
      session.guildId,
      session.userId,
      state,
      reason,
    ).catch(error => commands.logger.warn('更新群成员状态失败：%s', safeErrorSummary(error)))
  }
  commands.on('guild-member-added', updatePresenceFromEvent('active', 'member-added'))
  commands.on('guild-member-removed', updatePresenceFromEvent('inactive', 'member-removed'))

  const renameOrPreview = async (session: Session, rawTarget: string, nickname: string) => {
    const identity = await commands.xpPoints.ensureManagedIdentityTarget(rawTarget, await targetNativeName(session, rawTarget))
    const collision = (await commands.database.get('xp_profile', { nickname: nickname.trim() }))[0]
    if (collision && collision.id !== identity.profileId) {
      const target = (await commands.database.get('xp_identity', { profileId: collision.id }))[0]
      if (!target) return '目标档案没有账号，无法安全关联，请联系管理员检查。'
      const preview = await accountCommands.previewNicknameAssociation(session, rawTarget, `${target.platform}:${target.userId}`)
      return '该昵称已属于其他真人；以下是大小号关联预览，不会直接改名或合分。\n' + (preview ?? '')
    }
    const result = await commands.xpPoints.setManagedNicknameTarget(rawTarget, nickname,
      { platform: session.platform, userId: session.userId })
    return h.text(`已将账号 ${result.platform}:${result.userId} 的管理昵称设置为“${result.nickname}”；账号关系和余额不变。`).toString()
  }

  registerCommand('昵称 <nick:text>', { authority: 2 })
    .action(async ({ session }, nick) => {
      if (!nick?.trim()) return h.text('用法：昵称 <管理昵称>\n示例：昵称 示例玩家').toString()
      return runCommand(commands, '设置昵称', async () => {
        const result = await renameOrPreview(session, `${session.platform}:${session.userId}`, nick)
        await confirmExistingSessionPresence(commands, session)
        return result
      })
    })

  registerCommand('设置昵称 <nick:string> <target:user>', { authority: 2 })
    .action(async ({ session }, nick, target) => {
      if (!nick || !target) return h.text('用法：设置昵称 <管理昵称> <用户>\n示例：设置昵称 示例玩家 @用户').toString()
      return runCommand(commands, '设置目标昵称', async () => {
        return renameOrPreview(session, target, nick)
      })
    })

  const resolveScoreIdentity = async (session: Session, target?: string) => target
    ? commands.xpPoints.ensureManagedIdentityTarget(target, await targetNativeName(session, target))
    : ensureSessionIdentity(commands, session)

  const queryScore = async (session: Session, systemKey: string, target?: string) => {
    const identity = await resolveScoreIdentity(session, target)
    const definition = await commands.xpPoints.requireScoreSystem(systemKey)
    const value = await commands.xpPoints.getAccountScore(systemKey, { accountId: identity.accountId }, scoreContext(session))
    return `${identity.nickname} 的${definition.name}为 ${value}${definition.unit}。`
  }

  const renderLeaderboard = async (session: Session, systemKey: string, page = 1, options: LeaderboardOptions = {}) => {
    await confirmExistingSessionPresence(commands, session)
    const definition = await commands.xpPoints.requireScoreSystem(systemKey)
    if (options.period && !['累计', 'total'].includes(options.period)) {
      const kind = periodKinds[options.period as keyof typeof periodKinds]
      if (!kind) throw new XpPointsUserError('周期请用日、周、月、年、赛季或累计。')
      const result = await commands.xpPoints.getPeriodLeaderboard(systemKey, scoreContext(session), {
        kind, page, ...(options.date ? { at: await commands.xpPoints.parseScoreDate(systemKey, options.date) } : {}), season: options.season })
      if (!result.period) return `${definition.name}没有对应周期，启用前的成绩不会自动补建。`
      const lines = result.entries.map(e => `${e.rank}. ${e.nickname} ${e.value}${definition.unit}${e.inactive ? '（已停用）' : ''}`)
      const rows: string[] = [], count = config.leaderboardEntriesPerLine ?? 3
      for (let i = 0; i < lines.length; i += count) rows.push(lines.slice(i, i + count).join('  '))
      const periodName = periodNames[kind]
      return h.text(`${definition.name}${periodName}榜（第 ${page}/${result.totalPages} 页，共 ${result.total} 条）`
        + (result.period.incomplete ? '（首个周期不完整）' : '')
        + `\n${rows.join('\n') || '暂无竞技成绩。'}`).toString()
    }
    if (options.date || options.season) throw new XpPointsUserError('历史日期或赛季编号须同时指定 --period。')
    const result = await commands.xpPoints.getScoreLeaderboardPage(systemKey, scoreContext(session), { page })
    if (!result.entries.length) return `${definition.name}榜为空。`
    const lines = result.entries.map(entry => entry.nickname + ' ' + entry.value + definition.unit
      + (entry.inactive ? '（已停用）' : ''))
    const rows: string[] = []
    const perLine = config.leaderboardEntriesPerLine ?? 3
    for (let index = 0; index < lines.length; index += perLine) rows.push(lines.slice(index, index + perLine).join('  '))
    return h.text(`${definition.name}榜（第 ${result.page}/${result.totalPages} 页，共 ${result.total} 个条目）：\n` + rows.join('\n')).toString()
  }

  const scoreMutationContext = async (session: Session, command: string, operation: string, systemKey: string) => {
    const options = session.argv?.options as { date?: string; noCompetitive?: boolean } | undefined
    return { ...scoreContext(session), source: 'xp-points-command', reason: `${operation} via ${command}`,
      actor: { platform: session.platform, userId: session.userId }, competitive: !options?.noCompetitive,
      ...(options?.date ? { effectiveAt: await commands.xpPoints.parseScoreDate(systemKey, options.date) } : {}) }
  }

  const listScoreSystems = async () => {
    const systems = await commands.xpPoints.listScoreSystems()
    const rows = systems.map(system =>
      `${system.key}：${system.name}（${system.scope}，${system.unit}，${system.active ? '启用' : '停用'}）`)
    return rows.length ? rows : ['暂无积分系统。']
  }

  registerCommand('积分')
    .userFields(['authority'])
    .action(async ({ session }) => runCommand(commands, '查询积分系统', async () =>
      h.text([await tree.navigation('积分', session), '', '当前系统（key）：', ...await listScoreSystems()].join('\n')).toString()))

  registerCommand('积分.查询 <system:string> [target:user]')
    .action(async ({ session }, system, target) => {
      if (!system?.trim()) return h.text('用法：积分.查询 <系统 key> [用户]\n示例：积分.查询 event @用户').toString()
      return runCommand(commands, '查询积分', () => queryScore(session, system, target))
    })

  const rankingCommand = registerCommand('积分.排行 <system:string> [periodOrPage:string] [page:posint]')
    .option('period', '--period <period:string> 累计/日/周/月/年/赛季')
    .option('date', '--date <date:string> 查询历史日期')
    .option('season', '--season <season:string> 查询已记录赛季编号')
    .action(async ({ session, options }, system, periodOrPage, page) => {
      if (!system?.trim()) return h.text('用法：积分.排行 <系统 key> [周期|页码] [页码] [--period 日|周|月|年|赛季]\n示例：积分.排行 event 月；积分.排行 event 月 2；积分.排行 event --period 月').toString()
      return runCommand(commands, '查询积分榜', async () => {
        const parsed = parseLeaderboardPosition(periodOrPage, page, options)
        return renderLeaderboard(session, system, parsed.page, parsed.options)
      })
    })
  if (!scoreCommandBindings.some(binding => Command.normalize(binding.command) === Command.normalize('积分榜'))) rankingCommand.alias('积分榜')

  registerCommand('积分.设置 <system:string> <points:number> <target:user>', { authority: 2 })
    .option('date', '--date <date:string> 成绩归属日期；默认现在')
    .option('noCompetitive', '--no-competitive 仅调整累计余额，不计竞技成绩')
    .action(async ({ session }, system, points, target) => {
      if (!system || !Number.isFinite(points) || !target) {
        return h.text('用法：积分.设置 <系统 key> <数值> <用户>\n示例：积分.设置 event 10 @用户').toString()
      }
      return runCommand(commands, '设置指定积分', async () => {
        const identity = await commands.xpPoints.ensureManagedIdentityTarget(target, await targetNativeName(session, target))
        const definition = await commands.xpPoints.requireScoreSystem(system)
        const result = await commands.xpPoints.setAccountScore(
          system,
          { accountId: identity.accountId },
          points,
          await scoreMutationContext(session, '积分.设置', 'administrator set', system),
        )
        return `${identity.nickname} 的${definition.name}已设置为 ${result.after}${definition.unit}。`
      })
    })

  registerCommand('积分.增加 <system:string> <points:number> <target:user>', { authority: 2 })
    .option('date', '--date <date:string> 成绩归属日期；默认现在')
    .option('noCompetitive', '--no-competitive 仅调整累计余额，不计竞技成绩')
    .action(async ({ session }, system, points, target) => {
      if (!system || !Number.isFinite(points) || !target) {
        return h.text('用法：积分.增加 <系统 key> <数值> <用户>\n示例：积分.增加 event 2 @用户').toString()
      }
      return runCommand(commands, '增加指定积分', async () => {
        const identity = await commands.xpPoints.ensureManagedIdentityTarget(target, await targetNativeName(session, target))
        const definition = await commands.xpPoints.requireScoreSystem(system)
        const result = await commands.xpPoints.addAccountScore(
          system,
          { accountId: identity.accountId },
          points,
          await scoreMutationContext(session, '积分.增加', 'administrator add', system),
        )
        return `${identity.nickname} 的${definition.name}增加 ${points}${definition.unit}，现为 ${result.after}${definition.unit}。`
      })
    })

  for (const binding of scoreCommandBindings) {
    const { command, systemKey } = binding
    if (binding.action === 'query') {
      registerCommand(`${command} [target:user]`)
        .action(async ({ session }, target) => runCommand(commands, `执行${command}`,
          () => queryScore(session, systemKey, target)))
    } else if (binding.action === 'leaderboard') {
      registerCommand(`${command} [periodOrPage:string] [page:posint]`)
        .option('period', '--period <period:string> 累计/日/周/月/年/赛季')
        .option('date', '--date <date:string> 查询历史日期')
        .option('season', '--season <season:string> 查询已记录赛季编号')
        .action(async ({ session, options }, periodOrPage, page) => runCommand(commands, `执行${command}`, async () => {
          const parsed = parseLeaderboardPosition(periodOrPage, page, options)
          return renderLeaderboard(session, systemKey, parsed.page, parsed.options)
        }))
    } else if (binding.action === 'setSelf') {
      registerCommand(`${command} <points:number>`, { authority: 2 })
        .option('date', '--date <date:string> 成绩归属日期')
        .option('noCompetitive', '--no-competitive 仅调整累计余额')
        .action(async ({ session }, points) => {
          if (!Number.isFinite(points)) return h.text(`用法：${command} <数值>\n示例：${command} 10`).toString()
          return runCommand(commands, `执行${command}`, async () => {
            const identity = await ensureSessionIdentity(commands, session)
            const definition = await commands.xpPoints.requireScoreSystem(systemKey)
            const result = await commands.xpPoints.setAccountScore(systemKey, { accountId: identity.accountId }, points,
              await scoreMutationContext(session, command, 'administrator set self', systemKey))
            return `${identity.nickname} 的${definition.name}已设置为 ${result.after}${definition.unit}。`
          })
        })
    } else if (binding.action === 'addSelf') {
      registerCommand(`${command} <points:number>`, { authority: 2 })
        .option('date', '--date <date:string> 成绩归属日期')
        .option('noCompetitive', '--no-competitive 仅调整累计余额')
        .action(async ({ session }, points) => {
          if (!Number.isFinite(points)) return h.text(`用法：${command} <数值>\n示例：${command} 2`).toString()
          return runCommand(commands, `执行${command}`, async () => {
            const identity = await ensureSessionIdentity(commands, session)
            const definition = await commands.xpPoints.requireScoreSystem(systemKey)
            const result = await commands.xpPoints.addAccountScore(systemKey, { accountId: identity.accountId }, points,
              await scoreMutationContext(session, command, 'administrator add self', systemKey))
            return `${identity.nickname} 的${definition.name}增加 ${points}${definition.unit}，现为 ${result.after}${definition.unit}。`
          })
        })
    } else if (binding.action === 'setTarget') {
      registerCommand(`${command} <points:number> <target:user>`, { authority: 2 })
        .option('date', '--date <date:string> 成绩归属日期')
        .option('noCompetitive', '--no-competitive 仅调整累计余额')
        .action(async ({ session }, points, target) => {
          if (!Number.isFinite(points) || !target) return h.text(`用法：${command} <数值> <用户>\n示例：${command} 10 @用户`).toString()
          return runCommand(commands, `执行${command}`, async () => {
            const identity = await resolveScoreIdentity(session, target)
            const definition = await commands.xpPoints.requireScoreSystem(systemKey)
            const result = await commands.xpPoints.setAccountScore(systemKey, { accountId: identity.accountId }, points,
              await scoreMutationContext(session, command, 'administrator set target', systemKey))
            return `${identity.nickname} 的${definition.name}已设置为 ${result.after}${definition.unit}。`
          })
        })
    } else {
      registerCommand(`${command} <points:number> <target:user>`, { authority: 2 })
        .option('date', '--date <date:string> 成绩归属日期')
        .option('noCompetitive', '--no-competitive 仅调整累计余额')
        .action(async ({ session }, points, target) => {
          if (!Number.isFinite(points) || !target) return h.text(`用法：${command} <数值> <用户>\n示例：${command} 2 @用户`).toString()
          return runCommand(commands, `执行${command}`, async () => {
            const identity = await resolveScoreIdentity(session, target)
            const definition = await commands.xpPoints.requireScoreSystem(systemKey)
            const result = await commands.xpPoints.addAccountScore(systemKey, { accountId: identity.accountId }, points,
              await scoreMutationContext(session, command, 'administrator add target', systemKey))
            return `${identity.nickname} 的${definition.name}增加 ${points}${definition.unit}，现为 ${result.after}${definition.unit}。`
          })
        })
    }
  }

  const renderPeriodAudit = async (systemKey: string, options: LeaderboardOptions) => {
    const periodName = options.period?.trim()
    if (!periodName) throw new XpPointsUserError('管理员周期详情需要 --period 日|周|月|年|赛季|累计。')
    if (['累计', 'total'].includes(periodName)) {
      if (options.date || options.season) throw new XpPointsUserError('累计余额没有历史日期或赛季编号。')
      const definition = await commands.xpPoints.requireScoreSystem(systemKey, true)
      return `积分周期详情 ${systemKey}：累计\n${definition.name}累计余额没有固定周期边界。`
    }
    const kind = periodKinds[periodName as keyof typeof periodKinds]
    if (!kind) throw new XpPointsUserError('周期请用日、周、月、年、赛季或累计。')
    const at = options.date ? await commands.xpPoints.parseScoreDate(systemKey, options.date) : undefined
    const period = await commands.xpPoints.getPeriodDefinition(systemKey, { kind, at, season: options.season })
    if (!period) return `积分系统 ${systemKey} 没有对应周期；启用前的成绩不会自动补建。`
    return [
      `积分周期详情 ${systemKey}：${periodNames[kind]} ${period.label}`,
      `起止：${formatPeriodInstant(period.start, period.timeZone)} 至 ${formatPeriodInstant(period.end, period.timeZone)}（${period.timeZone}）`,
      `状态：${period.incomplete ? '首个或配置变更的不完整周期' : '完整周期'}`,
      `最后修订：${period.revisedAt ? formatPeriodInstant(period.revisedAt, period.timeZone) : '尚无成绩'}`,
    ].join('\n')
  }

  registerCommand('积分系统', { authority: 5 })
    .userFields(['authority'])
    .action(async ({ session }) => runCommand(commands, '查询积分系统', async () => {
      const systems = await commands.xpPoints.listScoreSystems()
      const rows = systems.map(system =>
        `${system.key}：${system.name}（${system.scope}，${system.unit}，${system.active ? '启用' : '停用'}）`)
      return h.text([await tree.navigation('积分系统', session), '', '当前系统（key）：', ...(rows.length ? rows : ['暂无积分系统。'])].join('\n')).toString()
    }))
  registerCommand('积分系统.创建 <key:string> <scope:string> <displayName:string> [unit:string]', { authority: 5 })
    .action(async ({ session }, key, scope, displayName, unit) => {
      if (!key || !scope || !displayName) {
        return h.text('用法：积分系统.创建 <key> <global|platform|guild> <名称> [单位]\n示例：积分系统.创建 event global 活动积分 星').toString()
      }
      return runCommand(commands, '创建积分系统', async () => {
        const system = await commands.xpPoints.createScoreSystem({
          key,
          scope: scope as any,
          name: displayName,
          unit,
        }, `${session.platform}:${session.userId}`)
        return `已创建积分系统 ${system.key}：${system.name}（${system.scope}，单位 ${system.unit}）。`
      })
    })
  registerCommand('积分系统.重命名 <key:string> <displayName:text>', { authority: 5 })
    .action(async (_argv, key, displayName) => {
      if (!key || !displayName?.trim()) return h.text('用法：积分系统.重命名 <key> <名称>').toString()
      return runCommand(commands, '重命名积分系统', async () => {
        const system = await commands.xpPoints.renameScoreSystem(key, displayName)
        return `积分系统 ${system.key} 已重命名为“${system.name}”。`
      })
    })
  registerCommand('积分系统.修改单位 <key:string> <unit:string>', { authority: 5 })
    .action(async (_argv, key, unit) => {
      if (!key || !unit) return h.text('用法：积分系统.修改单位 <key> <单位>').toString()
      return runCommand(commands, '修改积分单位', async () => {
        const system = await commands.xpPoints.setScoreSystemUnit(key, unit)
        return `积分系统 ${system.key} 的单位已改为“${system.unit}”。`
      })
    })
  registerCommand('积分系统.启用 <key:string>', { authority: 5 })
    .action(async (_argv, key) => {
      if (!key) return h.text('用法：积分系统.启用 <key>').toString()
      return runCommand(commands, '启用积分系统', async () => {
        const system = await commands.xpPoints.setScoreSystemActive(key, true)
        return `积分系统 ${system.key} 已启用。`
      })
    })
  registerCommand('积分系统.停用 <key:string>', { authority: 5 })
    .action(async (_argv, key) => {
      if (!key) return h.text('用法：积分系统.停用 <key>').toString()
      return runCommand(commands, '停用积分系统', async () => {
        const system = await commands.xpPoints.setScoreSystemActive(key, false)
        return `积分系统 ${system.key} 已停用。`
      })
    })
  registerCommand('积分系统.日志 <key:string> [page:posint]', { authority: 5 })
    .option('period', '--period <period:string> 周期详情：累计/日/周/月/年/赛季')
    .option('date', '--date <date:string> 周期详情查询日期')
    .option('season', '--season <season:string> 周期详情查询赛季编号')
    .action(async ({ options }, key, page) => {
      if (!key) return h.text('用法：积分系统.日志 <系统 key> [页码]\n周期详情：积分系统.日志 <系统 key> --period 日|周|月|年|赛季|累计 [--date YYYY-MM-DD] [--season 编号]').toString()
      return runCommand(commands, '查询积分日志', async () => {
        if (options.period || options.date || options.season) {
          if (page !== undefined) throw new XpPointsUserError('周期详情不需要日志页码。')
          return renderPeriodAudit(key, options)
        }
        const result = await commands.xpPoints.getScoreJournalPage(key, { page })
        const lines = result.entries.map(row =>
          `#${row.id} 档案#${row.profileId} ${row.before} → ${row.after}（${row.source}：${row.reason}）`)
        return [
          `积分日志 ${key}（第 ${result.page}/${result.totalPages} 页，共 ${result.total} 条）：`,
          ...(lines.length ? lines : ['暂无积分日志。']),
        ].join('\n')
      })
    })
  registerCommand('积分系统.群挂靠重映射 [balanceStrategy:string] [periodStrategy:string]', { authority: 5 })
    .option('balance', '--balance <strategy:string> 累计积分策略：maximum 或 sum')
    .option('period', '--period <strategy:string> 周期成绩策略：maximum 或 sum')
    .action(async ({ session, options }, balanceStrategy, periodStrategy) => {
      if (balanceStrategy && !['maximum', 'sum'].includes(balanceStrategy)
        || periodStrategy && !['maximum', 'sum'].includes(periodStrategy)
        || options.balance && !['maximum', 'sum'].includes(options.balance)
        || options.period && !['maximum', 'sum'].includes(options.period)) {
        return h.text('用法：积分系统.群挂靠重映射 [maximum|sum] [maximum|sum]\n也可用 --balance maximum|sum --period maximum|sum；省略时使用配置默认策略。').toString()
      }
      if (balanceStrategy && options.balance || periodStrategy && options.period) {
        return h.text('同一策略不能同时使用位置参数和选项指定。').toString()
      }
      return runCommand(commands, '预览群挂靠重映射', async () => {
        const preview = await commands.xpPoints.previewGuildAliasRemap(deletionActor(session), {
          balanceStrategy: (balanceStrategy ?? options.balance) as any,
          periodStrategy: (periodStrategy ?? options.period) as any,
        })
        return [
          '群挂靠重映射预览：',
          ...preview.summary,
          `确认令牌：${preview.token}（5 分钟内有效）`,
          '确认执行：请直接复制并发送上面的完整令牌。',
        ].join('\n')
      })
    })
  registerCommand('积分系统.删除 <key:string>', { authority: 5 })
    .action(async ({ session }, key) => {
      if (!key) return h.text('用法：积分系统.删除 <key>').toString()
      return runCommand(commands, '预览积分系统删除', async () => {
        const preview = await commands.xpPoints.previewDeleteScoreSystem(key, deletionActor(session))
        return [
          '积分系统删除预览：',
          ...preview.summary,
          `确认令牌：${preview.token}（5 分钟内有效）`,
          '确认执行：请直接复制并发送上面的完整令牌。',
        ].join('\n')
      })
    })

  registerCommand('档案维护', { authority: 5 })
    .userFields(['authority'])
    .action(async ({ session }) => h.text(await tree.navigation('档案维护', session)).toString())
  registerCommand('档案维护.查看 <nickname:text>', { authority: 5 })
    .option('page', '--page <page:number> 详情页码')
    .action(async ({ session, options }, nickname) => {
      if (!nickname?.trim()) return h.text('用法：档案维护.查看 <管理昵称>\n示例：档案维护.查看 示例玩家').toString()
      return runCommand(commands, '查看管理档案', async () => {
        const result = await commands.xpPoints.inspectManagedProfile(nickname)
        const systems = new Map((await commands.xpPoints.listScoreSystems()).map(system => [system.key, system]))
        const identityLines = result.identities.map(identity => `${identity.platform}:${identity.userId}`)
        const presenceLines = result.presences.map(row =>
          `${row.platform}/${row.guildId}/${row.userId}：${row.state}（${row.reason}）`)
        const balanceLines = result.balances.map(row => {
          const system = systems.get(row.systemKey)
          const scope = [row.platform, row.guildId].filter(Boolean).join('/') || '全局'
          return `${row.systemKey} ${row.accountNickname ?? '共享'} ${row.value}${system?.unit ?? ''}（${scope}）`
        })
        const detail = [
          `档案 #${result.profile.id}：${result.profile.nickname}${result.profile.automatic ? '（自动）' : '（管理员维护）'}`,
          '账号：', ...(identityLines.length ? identityLines : ['无']),
          '群状态：', ...(presenceLines.length ? presenceLines : ['无记录']),
          '积分余额：', ...(balanceLines.length ? balanceLines : ['无记录']),
        ].join('\n')
        let page: string
        try { page = accountDetailPage(detail, options.page ?? 1, next => `档案维护.查看 --page ${next} ${nickname}`) }
        catch (error) { throw new XpPointsUserError((error as Error).message) }
        return h.text(page)
      })
    })
  registerCommand('档案维护.扫描成员 [mode:string]', { authority: 5 })
    .action(async ({ session }, mode) => {
      if (mode && mode !== '执行') return h.text('用法：档案维护.扫描成员 [执行]\n省略“执行”仅预览。').toString()
      return runCommand(commands, '扫描成员状态', async () => {
        const guildId = requireGuild(session)
        const execute = mode === '执行'
        const result = await commands.xpPoints.scanGuildMembers(
          session.bot,
          session.platform,
          guildId,
          execute,
        )
        const action = execute ? '已执行' : '仅预览'
        const previewLimit = config.memberScanPreviewLimit ?? 100
        const lines = result.changes.slice(0, previewLimit).map(change =>
          `${change.userId}: ${change.previous} → ${change.next}`)
        return [
          `成员状态扫描${action}：成员 ${result.memberCount}，候选账号 ${result.candidates}，变化 ${result.changes.length}。`,
          ...(lines.length ? lines : ['没有需要变更的状态。']),
          ...(result.changes.length > lines.length
            ? [`另有 ${result.changes.length - lines.length} 条变化未展开显示。`] : []),
          ...(execute ? [] : ['确认无误后发送“档案维护.扫描成员 执行”重新完整扫描并提交。']),
        ].join('\n')
      })
    })
  registerCommand('档案维护.删除账号 <target:user>', { authority: 5 })
    .action(async ({ session }, target) => {
      if (!target) return h.text('用法：档案维护.删除账号 <用户>\n示例：档案维护.删除账号 @用户').toString()
      return runCommand(commands, '预览账号删除', async () => {
        const preview = await commands.xpPoints.previewDeleteIdentity(target, deletionActor(session))
        return [
          '档案删除预览：',
          ...preview.summary,
          `确认令牌：${preview.token}（5 分钟内有效）`,
          '确认执行：请直接复制并发送上面的完整令牌。',
        ].join('\n')
      })
    })
  registerCommand('档案维护.删除档案 <nickname:text>', { authority: 5 })
    .action(async ({ session }, nickname) => {
      if (!nickname?.trim()) return h.text('用法：档案维护.删除档案 <管理昵称>\n示例：档案维护.删除档案 示例玩家').toString()
      return runCommand(commands, '预览档案删除', async () => {
        const preview = await commands.xpPoints.previewDeleteProfile(nickname, deletionActor(session))
        return [
          '档案删除预览：',
          ...preview.summary,
          `确认令牌：${preview.token}（5 分钟内有效）`,
          '确认执行：请直接复制并发送上面的完整令牌。',
        ].join('\n')
      })
    })
  commands.middleware(async (session, next) => {
    const token = session.content.trim()
    if (!/^(?:XPDEL|XPSYSDEL|XPALIAS)-[A-Za-z0-9_-]{16}$/.test(token)) return next()
    const user = await commands.database.getUser(session.platform, session.userId, ['authority'])
    if ((user?.authority ?? 0) < 5) return '权限不足。'
    if (token.startsWith('XPSYSDEL-')) {
      return runCommand(commands, '确认积分系统删除', async () => {
        const result = await commands.xpPoints.confirmDeleteScoreSystem(token, deletionActor(session))
        return `积分系统 ${result.key} 删除完成：余额 ${result.balances}，日志 ${result.journals}，群挂靠 ${result.aliases}。`
      })
    }
    if (token.startsWith('XPALIAS-')) {
      return runCommand(commands, '确认群挂靠重映射', async () => {
        const result = await commands.xpPoints.confirmGuildAliasRemap(token, deletionActor(session))
        return ['群挂靠重映射完成。', ...result.summary].join('\n')
      })
    }
    return runCommand(commands, '确认档案删除', async () => {
      const result = await commands.xpPoints.confirmProfileDeletion(token, deletionActor(session))
      return `档案删除完成：账号 ${result.deletedIdentities}，档案 ${result.deletedProfiles}，消费方数据 ${result.consumerRows}。`
        + (result.warnings?.length ? '\n' + result.warnings.join('\n') : '')
    })
  }, true)
  })

  installChatLunaConsumer(ctx, config)
  installCharacterConsumer(ctx, config)
}

export { XpPointsService }
export type { GuildAliasCombineStrategy, GuildAliasPolicy } from './guild-alias-policy'
export type { ManagedIdentity } from './service'
export { ScoreLedgerHandle } from './score-ledger'
export type {
  ScoreCommandBindingConfig,
  ScoreConsumerRegistration,
  ScoreLeaderboardEntry,
  ScoreLeaderboardPage,
  ScoreJournalPage,
  ScoreMutationResult,
  ScoreOperationContext,
  ScoreScope,
  ScoreSystemDefinition,
} from './score-ledger'
export type { ManagedProfileInspection } from './service'
export type {
  ProfileDataConsumer,
  ProfileDataConsumerPreview,
  ProfileDeletionActor,
  ProfileDeletionPreview,
  ProfileDeletionResult,
  ProfileDeletionScope,
} from './deletion'
