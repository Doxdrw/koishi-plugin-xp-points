import { h, type Context, type Session } from 'koishi'
import { XpPointsUserError, safeErrorSummary } from './errors'
import type { AccountOperations } from './account-operations'
import type { AccountQueryStore } from './account-queries'
import type { AccountInteractionActor } from './account-interactions'
import { normalizeAccountDefaults, type AccountDefaults } from './account-lifecycle'
import { associationHelp, associationExamples, accountModeHelp } from './command-catalog'

export interface AccountCommandServices {
  operations: AccountOperations
  queries: AccountQueryStore
  /** Invalidate/reload nickname caches only after a successfully committed change. */
  refresh: () => Promise<void>
  defaults?: AccountDefaults
  command?: Context['command']
}

export const accountCommandNames = [
  '我的账号', '大小号情况', '本群大小号', '大小号管理', '账号模式', '设置主号', '设置账号标签', '设置账号昵称', '取消账号操作',
  '关联大小号', '积分.全部增加', '积分.全部设置',
] as const

function actor(session: Session): AccountInteractionActor {
  return { platform: session.platform, userId: session.userId, selfId: session.selfId,
    channelId: session.channelId, isDirect: session.isDirect }
}

function target(session: Session, value?: string) {
  if (!value) return { platform: session.platform, userId: session.userId }
  const separator = value.lastIndexOf(':')
  if (separator <= 0 || separator === value.length - 1) throw new XpPointsUserError('请使用 @用户或@平台:账号指定目标。')
  return { platform: value.slice(0, separator), userId: value.slice(separator + 1) }
}

// Read-only detail pagination: one bounded message per query. Never use this
// for mutation previews, whose complete consequences must stay visible.
export function accountDetailPage(body: string, page: number, command: string | ((nextPage: number) => string)) {
  if (!Number.isSafeInteger(page) || page < 1) throw new XpPointsUserError('页码须为正整数，请使用 --page 1。')
  const pages: string[] = []; let current = ''
  for (const line of body.split('\n')) {
    const chunks = line.match(/[\s\S]{1,1200}/gu) ?? ['']
    for (const chunk of chunks) {
      if (current.length + chunk.length + 1 > 2800) { pages.push(current); current = '' }
      current += (current ? '\n' : '') + chunk
    }
  }
  if (current || !pages.length) pages.push(current)
  if (page > pages.length) throw new XpPointsUserError(`当前只有 ${pages.length} 页，请使用 --page 1 重新查询。`)
  return pages[page - 1] + (pages.length > 1 ? `\n第 ${page}/${pages.length} 页。`
    + (page < pages.length ? `下一页：${typeof command === 'function' ? command(page + 1) : command + ' --page ' + (page + 1)}` : '') : '')
}

/** Register the current account-management command set once per plugin instance. */
export function registerAccountCommands(ctx: Context, services: AccountCommandServices) {
  const { operations, queries } = services
  const command = services.command ?? ctx.command.bind(ctx)
  const defaults = normalizeAccountDefaults(services.defaults)
  const run = async (task: () => Promise<string | void>, usage?: string) => {
    try { return await task() }
    catch (error) {
      ctx.logger.warn('账号指令未完成：%s', safeErrorSummary(error))
      return error instanceof XpPointsUserError
        ? h.text(error.message + (usage ? '\n' + usage : '')).toString()
        : '账号操作未完成，未报告成功；请联系管理员检查日志。'
    }
  }
  const replyHere = (body: string) => {
    if (body.length > 12_000) throw new XpPointsUserError('账号详情过长，无法安全完整发送，请缩小查询范围。')
    return h.text(body).toString()
  }
  const committed = async (message: string) => {
    try { await services.refresh(); return message }
    catch (error) {
      ctx.logger.warn('账号操作已提交，但缓存刷新失败：%s', safeErrorSummary(error))
      return '账号操作已保存，但昵称缓存刷新失败；请联系管理员检查，不要重复提交。'
    }
  }
  const account = async (session: Session, raw?: string) => {
    const id = target(session, raw)
    return queries.account(id.platform, id.userId)
  }
  const personText = (view: Awaited<ReturnType<AccountQueryStore['person']>>, systemKey?: string) => {
    if (systemKey && !view.systems.some(row => row.key === systemKey)) throw new XpPointsUserError('该积分系统不存在，请检查 --system 参数。')
    const systems = view.systems.filter(system => !systemKey || system.key === systemKey)
    const independent = view.accounts.length > 1 && systems.some(system => system.mode === 'independent')
    return [
    `统一管理昵称：${view.profile.nickname}`,
    `默认计分方式：${view.defaultScoreMode === 'shared' ? '共享积分' : '账号分别计分'}（未来新增系统沿用）。`,
    '主小号关系（所有系统共用）：',
    view.accounts.length === 1 ? '仅一个账号，无大小号关联。'
      : independent && !view.primaryAccountId ? '独立计分待整理：未指定主号。' : '',
    ...view.accounts.map(row => `${row.primary ? '主号' : '账号'}：${row.nickname}〔${row.label}〕`
      + (independent && row.nicknameStatus === 'unknown' ? '（独立计分昵称待整理）' : '') + `  ${row.platform}:${row.userId}`),
    '各系统实际计分方式：',
    ...systems.flatMap(system => [
      `${system.name}（${system.key}）：${system.mode === 'shared' ? '共享积分' : '账号分别计分'}${system.active ? '' : '，已停用'}`,
      ...(system.pools.length ? system.pools.flatMap(pool => [`${pool.platform || '全局'}/${pool.guildId || '全域'}：`,
        ...pool.entries.map(entry => `  ${entry.accountId ? view.accounts.find(row => row.id === entry.accountId)!.nickname
          + '〔' + view.accounts.find(row => row.id === entry.accountId)!.label + '〕' : '共享余额'} ${entry.value}${system.unit}`),
        ...(system.mode === 'independent' ? [`  最高 ${pool.highest}${system.unit}`] : [])]) : ['暂无积分记录。']),
    ]),
    ].filter(Boolean).join('\n')
  }
  const mapChoices = (raw: string | undefined, keys: string[], allowed: string[]) => {
    const result = new Map<string, string>()
    if (raw === undefined) return result
    for (const item of raw.split(',')) {
      const [key, value, extra] = item.split(':')
      if (!keys.includes(key) || !allowed.includes(value) || extra !== undefined || result.has(key)) {
        throw new XpPointsUserError('逐系统选项无效，请使用 系统key:选项,系统key:选项，不能重复或写未知系统。')
      }
      result.set(key, value)
    }
    return result
  }

  command('我的账号', '在当前会话查看本人已关联的账号', { authority: 1 })
    .option('system', '-s <system:string> 只查看指定积分系统')
    .option('page', '--page <page:number> 详情页码')
    .action(({ session, options }) => run(async () => replyHere(accountDetailPage(
      personText(await queries.person(actor(session)), options.system), options.page ?? 1,
      `我的账号${options.system ? ' --system ' + options.system : ''}`))))
  command('大小号情况 [target:user]', '在当前会话查看账号关系', { authority: 1 })
    .usage(h.text('用法：大小号情况 [@账号] 或 大小号情况 -n "管理昵称" [-s 系统] [--page 页码]\n管理员可查他人，普通用户仅查本人；不支持用账号昵称模糊猜人。').toString())
    .example('大小号情况 -n "示例玩家"')
    .option('nickname', '-n <nickname:string> 按完整管理昵称查询')
    .option('system', '-s <system:string> 只查看指定积分系统')
    .option('page', '--page <page:number> 详情页码')
    .action(({ session, options }, raw) => run(async () => {
      if (options.nickname !== undefined) {
        if (raw) return '请只提供 @账号或 -n 管理昵称中的一种。'
        const view = await queries.personByNickname(actor(session), options.nickname)
        return replyHere(accountDetailPage(personText(view, options.system), options.page ?? 1,
          `大小号情况 -n ${JSON.stringify(view.profile.nickname)}${options.system ? ' --system ' + options.system : ''}`))
      }
      const member = await account(session, raw)
      return replyHere(accountDetailPage(personText(await queries.person(actor(session), member.profileId), options.system),
        options.page ?? 1, `大小号情况 @${member.platform}:${member.userId}${options.system ? ' --system ' + options.system : ''}`))
    }))
  command('本群大小号 [page:number]', '当前平台大小号：群聊限本群，私聊不限群', { authority: 2 })
    .alias('大小号管理')
    .option('all', '-a 显示全部已知档案（含单账号）')
    .option('pending', '--pending 仅显示独立计分需要主号或账号昵称的组')
    .option('keyword', '-k <keyword:string> 搜索昵称、标签或账号')
    .option('guild', '-g <guild:string> 私聊查询的来源群号')
    .option('platform', '-p <platform:string> 指定来源平台，默认当前平台')
    .option('allPlatforms', '--all-platforms 私聊显式查看全部平台（不能同时使用 -p/-g）')
    .action(({ session, options }, page = 1) => run(async () => {
      const guild = session.isDirect ? options.guild : session.guildId, platform = options.platform ?? session.platform
      if (!Number.isSafeInteger(page) || page < 1) return h.text('用法：本群大小号 [页码] [--pending] [-k 关键词] [--all]；私聊默认当前平台，可用 -p 平台、-g 群号或 --all-platforms。').toString()
      if (options.allPlatforms && (!session.isDirect || options.platform !== undefined || options.guild !== undefined)) {
        return '--all-platforms 仅私聊可用，且不能与 -p/-g 同用；示例：大小号管理 --all-platforms。'
      }
      if (!session.isDirect && (!guild || (options.guild && options.guild !== guild) || platform !== session.platform)) {
        return '群聊管理列表仅查看当前群；跨群查询请在私聊使用 -g 群号 [-p 平台]。'
      }
      const filters = { includeSingles: options.all, pendingOnly: options.pending, keyword: options.keyword }
      const result = guild ? await queries.guild(actor(session), platform, guild, page, 5, filters)
        : options.allPlatforms ? await queries.all(actor(session), page, 5, filters)
          : await queries.platform(actor(session), platform, page, 5, filters)
      const command = `本群大小号${options.all ? ' --all' : ''}${options.pending ? ' --pending' : ''}`
        + (options.keyword ? ' -k ' + JSON.stringify(options.keyword) : '')
        + (session.isDirect ? options.allPlatforms ? ' --all-platforms'
          : ` -p ${JSON.stringify(platform)}${guild ? ' -g ' + JSON.stringify(guild) : ''}` : '')
      const lines = [`${guild ? `本群大小号 · ${platform}/${guild}` : options.allPlatforms ? '全平台大小号' : `平台大小号 · ${platform}`} · 第 ${result.page}/${result.totalPages} 页`,
        `已关联多账号 ${result.multiPeople} 人，待整理 ${result.pendingPeople} 人；本次筛选 ${result.total} 人。`]
      const brief = (text: string, max = 48) => Array.from(text).length > max ? Array.from(text).slice(0, max).join('') + '…' : text
      for (const view of result.entries) {
        lines.push(`\n${brief(view.profile.nickname)} · ${view.accounts.length} 个账号`
          + (view.needsReview ? `【独立计分：${[view.missingPrimary ? '未指定主号' : '', view.unknownNames ? `${view.unknownNames} 个昵称待补` : ''].filter(Boolean).join('；')}】` : ''))
        for (const row of view.accounts.slice(0, 6)) lines.push(`  ${row.primary ? '主号' : '账号'} ${brief(row.nickname)}`
          + (row.label && row.label !== row.nickname ? `〔${brief(row.label, 20)}〕` : '') + ` @${row.platform}:${row.userId}`
          + (view.unknownNames && row.nicknameStatus === 'unknown' ? '〔昵称待补〕' : '')
          + (guild ? row.guildState === 'inactive' ? '（本群停用）' : row.guildState === 'unknown' ? '（本群未确认）' : '' : ''))
        if (view.accounts.length > 6) lines.push(`  另有 ${view.accounts.length - 6} 个账号，请查看详情。`)
        if (view.primaryOutsidePlatform) lines.push('  主号在其他平台。')
        lines.push(`  默认：${view.defaultScoreMode === 'shared' ? '共享积分' : '账号分别计分'}`)
        lines.push(view.systems.length ? '  ' + view.systems.slice(0, 4).map(system => `${brief(system.name, 20)}：${system.mode === 'shared' ? '共享积分' : '账号分别计分'}`).join('；')
          + (view.systems.length > 4 ? `；另 ${view.systems.length - 4} 套见详情` : '') : '  未配置积分系统。')
        const entry = view.accounts.find(row => row.primary) ?? view.accounts[0]
        if (entry) lines.push(`  详情：大小号情况 @${entry.platform}:${entry.userId}`)
      }
      if (!result.total) lines.push('没有符合条件的档案。未关联的单账号默认不列出；需要排查时可用 --all -k 昵称。')
      lines.push(`\n${result.notice}`, '筛选：--pending 待整理｜-k 关键词｜--all 含单账号。')
      if (page < result.totalPages) lines.push(`下一页：${command.replace('本群大小号', '本群大小号 ' + (page + 1))}`)
      return replyHere(lines.join('\n'))
    }))
  command('取消账号操作', '取消本会话尚未执行的账号确认', { authority: 1 })
    .action(({ session }) => run(async () => `已取消 ${operations.cancel(actor(session))} 项待确认账号操作。`))

  const associationPreview = (session: Session, options: {
    mergePersons?: boolean, mode?: string, modes?: string, strategies?: string, periodStrategies?: string, sourceKeep?: string, targetKeep?: string,
  }, source: string, main: string, selectMain = true) => run(async () => {
      if (!source || !main) return h.text(associationHelp).toString()
      const from = await account(session, source), to = await account(session, main)
      if (from.profileId === to.profileId) return '这两个账号已属于同一真人，无需再次关联。'
      const sourcePerson = await queries.person(actor(session), from.profileId)
      const targetPerson = await queries.person(actor(session), to.profileId)
      if (options.mode && !['共享', '独立'].includes(options.mode)) throw new XpPointsUserError('--mode 请使用共享或独立。')
      const defaultMode = options.mode ? options.mode === '共享' ? 'shared' : 'independent' : targetPerson.defaultScoreMode
      const kind = options.mergePersons || sourcePerson.accounts.length === 1 ? 'merge-persons' : 'move-account'
      const keys = targetPerson.systems.map(system => system.key)
      const modes = mapChoices(options.modes, keys, ['共享', '独立'])
      const strategies = mapChoices(options.strategies, keys, ['maximum', 'sum'])
      const periodStrategies = mapChoices(options.periodStrategies, keys, ['maximum', 'sum'])
      const sourceKeep = options.sourceKeep ? await account(session, options.sourceKeep) : undefined
      const targetKeep = options.targetKeep ? await account(session, options.targetKeep) : undefined
      const systems = keys.map(systemKey => ({ systemKey,
        mode: (modes.get(systemKey) ? modes.get(systemKey) === '共享' ? 'shared' : 'independent' : defaultMode) as 'shared' | 'independent',
        strategy: (strategies.get(systemKey) ?? defaults.combineStrategy) as 'maximum' | 'sum',
        periodStrategy: (periodStrategies.get(systemKey) ?? 'maximum') as 'maximum' | 'sum',
        sourceRetainedAccountId: sourceKeep?.id, targetRetainedAccountId: targetKeep?.id,
      }))
      const proposal = await operations.previewAssociation(actor(session), { kind,
        ...(kind === 'move-account' ? { movedAccountId: from.id } : {}),
        sourceProfileId: from.profileId, targetProfileId: to.profileId, systems, defaultScoreMode: defaultMode,
        ...(selectMain ? { primaryAccountId: to.id } : {}) })
      const preview = proposal.preview
      const names = new Map([...preview.source.accounts, ...preview.target.accounts].map(row => [row.id, `${row.nickname}〔${row.label}〕`]))
      const lines = [kind === 'move-account' ? `仅移动账号 ${from.nickname}；原组其他账号不移动，共享余额留原组。`
        : `合并两个真人档案的全部账号：${sourcePerson.profile.nickname} → ${targetPerson.profile.nickname}。`,
      '各账号原昵称保留。',
      `关联后默认计分方式：${defaultMode === 'shared' ? '共享积分' : '账号分别计分'}，以后新增系统沿用；下方各系统可单独设置。`,
      selectMain ? `主号：${preview.primaryChange.before ? names.get(preview.primaryChange.before) : '未指定'} → ${names.get(to.id)}（第二个参数）。`
        : '本次由改名冲突产生，不推断或改变主号。',
      '影响范围：相关真人的全部积分系统和积分池，不仅当前群。',
      ...preview.labelChanges.filter(row => row.before !== row.after).map(row => `标签消歧：${names.get(row.accountId)} → ${row.after}`)]
      for (const item of preview.systemPlans) {
        lines.push(`周期成绩策略：${item.choice.periodStrategy === 'sum' ? '累加（管理员显式选择）' : '逐周期取最高'}，不随累计合分策略自动改变。`)
        for (const pool of item.periodPlan.pools) {
          const [id, platform] = JSON.parse(pool.platform)
          const period = [...item.from.periodDefinitions, ...item.to.periodDefinitions].find(p => p.id === id)
          lines.push(`${period?.kind ?? '周期'} ${period?.label ?? id} ${platform || '全局'}/${pool.guildId || '全域'}：`
            + pool.sources.map(s => `${names.get(s.accountId) ?? '共享'} ${s.value}`).join('，') + ' → '
            + pool.destinations.map(d => `${names.get(d.accountId) ?? '共享'} ${d.value}`).join('，')
            + (pool.discardedNegativeSources.length ? '【将舍弃负分】' : ''))
        }
        lines.push(`${item.system.name}（${item.system.key}）：`
          + (item.choice.mode === 'shared' ? `共享，${item.choice.strategy === 'sum' ? '累加' : '取最高'}` : '独立，各账号分别保留；原共享余额仅由指定账号承接')
          + `；涉及 ${item.plan.pools.length} 个积分池。`)
        for (const pool of item.plan.pools) {
          const before = pool.sources.map(row => `${row.accountId ? names.get(row.accountId) :
            (row.profileId === from.profileId ? sourcePerson.profile.nickname : targetPerson.profile.nickname) + '（共享）'} ${row.value}`).join('，')
          const after = pool.destinations.map(row => `${row.accountId ? names.get(row.accountId) : '新共享积分'} ${row.value}`).join('，')
          lines.push(`${pool.platform || '全局'}/${pool.guildId || '全域'}：${before} → ${after}`
            + (pool.discardedNegativeSources.length ? '【取最高将舍弃负分，请特别核对】' : ''))
        }
      }
      const body = lines.join('\n')
      if (body.length > 12_000) throw new XpPointsUserError('涉及积分池过多，预览无法安全完整展示，请联系维护者分批处理。')
      return h.text(body + `\n五分钟内由本人在本会话直接粘贴令牌确认：\n${proposal.token}\n可发送“取消账号操作”。`).toString()
    }, associationHelp)

  command('关联大小号 [source:user] [main:user]', '预览将一个账号关联到指定真人', { authority: 2 })
    .option('mode', '--mode <mode:string> 所有系统及未来默认：共享或独立；--modes 逐系统优先')
    .usage(h.text(associationHelp).toString())
    .example(associationExamples[0])
    .example(associationExamples[1])
    .example(associationExamples[2])
    .option('mergePersons', '--merge-persons 明确合并两组全部账号')
    .option('modes', '--modes <modes:string> 逐系统选择，如 event:独立,primary:共享')
    .option('strategies', '--strategies <strategies:string> 逐系统选择 maximum 或 sum')
    .option('periodStrategies', '--period-strategies <periodStrategies:string> 单独选择周期成绩合分，默认maximum')
    .option('sourceKeep', '--source-keep <sourceKeep:user> 原组共享分数的承接账号')
    .option('targetKeep', '--target-keep <targetKeep:user> 目标组共享分数的承接账号')
    .action(({ session, options }, source, main) => associationPreview(session, options, source, main))

  for (const [name, operation] of [['积分.全部增加', 'add'], ['积分.全部设置', 'set']] as const) {
    command(`${name} [system:string] [amount:number] [target:user]`, '按计分主体去重的批量积分预览', { authority: 2 })
      .option('guild', '-g <guild:string> 群作用域的实际来源群号')
      .option('platform', '-p <platform:string> 积分池平台，默认当前平台')
      .option('date', '--date <date:string> 成绩归属日期')
      .option('noCompetitive', '--no-competitive 仅调整累计余额')
      .action(({ session, options }, system, amount, raw) => run(async () => {
        const usage = `${name} <系统> <数值> <@账号> [-g 来源群号] [-p 平台]`
        if (!system || !raw || !Number.isFinite(amount)) return h.text('用法：' + usage).toString()
        const member = await account(session, raw)
        const proposal = await operations.previewBatch(actor(session), { systemKey: system, profileId: member.profileId,
          operation, operand: amount, context: { platform: options.platform ?? session.platform, guildId: options.guild ?? (session.isDirect ? undefined : session.guildId),
            competitive: !options.noCompetitive, ...(options.date ? { effectiveAt: await queries.scoreDate(system, options.date) } : {}) },
          reason: 'administrator confirmed all-account ' + operation })
        const lines = proposal.preview.entries.map((entry, index) => `${entry.accountNickname ?? entry.nickname}`
          + `${entry.label ? '〔' + entry.label + '〕' : '（共享，仅计算一次）'}：`
          + `${proposal.preview.changes[index].before} → ${proposal.preview.changes[index].after}`)
        const pool = proposal.preview.pool
        const body = `批量积分预览：${lines.length} 个计分主体，总变化 ${proposal.preview.totalDelta}。\n`
          + (options.noCompetitive ? '本次不计竞技成绩。\n' : `计入竞技成绩，归属${options.date ?? '实际确认时间'}。\n`)
          + `系统 ${system}，实际积分池：${pool.platform || '全局'}/${pool.guildId || '全域'}。\n`
          + (pool.system.scope === 'guild' && pool.originGuildId !== pool.guildId ? `来源群 ${pool.originGuildId} 已挂靠至此池。\n` : '')
          + (operation === 'add' ? '每个独立主体各增加指定值，不是均分；共享主体只加一次。\n' : '') + lines.join('\n')
        if (body.length > 12_000) throw new XpPointsUserError('账号数量过多，预览无法安全完整展示，请联系维护者分批处理。')
        return h.text(body + `\n五分钟内由本人在本会话直接粘贴令牌确认：\n${proposal.token}\n可发送“取消账号操作”。`).toString()
      }))
  }

  command('账号模式 [system:string] [mode:string]', '预览共享或独立积分模式', { authority: 1 })
    .usage(h.text(accountModeHelp).toString())
    .example('账号模式 共享')
    .example('账号模式 独立 -r @onebot:123456')
    .option('target', '-u <target:user> 指定账号')
    .option('retained', '-r <retained:user> 独立模式承接原共享分数的账号')
    .option('strategy', '--strategy <strategy:string> maximum 或 sum')
    .option('periodStrategy', '--period-strategy <periodStrategy:string> 周期成绩独立策略，默认maximum；本人不能sum')
    .action(({ session, options }, system, mode) => run(async () => {
      if (options.periodStrategy && !['maximum', 'sum'].includes(options.periodStrategy)) return '周期合分策略请使用 maximum 或 sum。'
      if (['共享', '独立'].includes(system) && mode === undefined) {
        if (options.strategy && !['maximum', 'sum'].includes(options.strategy)) return h.text(accountModeHelp).toString()
        const member = await account(session, options.target)
        const retained = options.retained ? await account(session, options.retained) : undefined
        const proposal = await operations.previewAllModes(actor(session), { profileId: member.profileId,
          nextMode: system === '共享' ? 'shared' : 'independent', retainedAccountId: retained?.id,
          strategy: options.strategy === 'sum' ? 'sum' : 'maximum', periodStrategy: options.periodStrategy === 'sum' ? 'sum' : 'maximum' })
        const { state, changes } = proposal.preview
        const accountName = (id: string | null) => state.accounts.find(a => a.id === id)?.nickname ?? '原共享积分'
        const lines = [`全系统计分方式预览：${member.nickname} → ${system === '共享' ? '共享积分' : '账号分别计分'}。`,
          '影响此人的全部现有系统（含停用系统）及未来新增系统，不仅当前群；原昵称和大小号关系不变。',
          `合分策略：${options.strategy === 'sum' ? '累加' : '取最高'}；已符合目标方式的系统不重复合分。`,
          retained ? `所有需拆分的共享余额由 ${retained.nickname} 承接，其他账号从零开始。` : '',
          ...state.systems.map(s => `${s.name}（${s.key}${s.active ? '' : '，停用保持'}）：${changes.some(c => c.state.system.key === s.key) ? '转换' : '已是该方式，余额不变'}`)]
        for (const change of changes) for (const pool of change.plan.pools) lines.push(
          `${change.state.system.key} ${pool.platform || '全局'}/${pool.guildId || '全域'}：`
          + pool.sources.map(s => `${accountName(change.state.subjects.find(row => row.id === s.subjectId)?.accountId ?? null)} ${s.value}`).join('，')
          + ` → ${pool.value}` + (pool.sources.some(s => s.value < 0) ? '【包含负分，请核对】' : ''))
        lines.push(`周期成绩：${options.periodStrategy === 'sum' ? '明确累加' : '逐周期取最高'}。`)
        for (const change of changes) for (const pool of change.periodPlan.pools) {
          const [id, platform] = JSON.parse(pool.platform), period = change.state.periodDefinitions.find(p => p.id === id)
          lines.push(`${change.state.system.key} ${period?.kind} ${period?.label} ${platform || '全局'}/${pool.guildId || '全域'}：`
            + pool.sources.map(s => s.value).join('，') + ` → ${pool.value}` + (pool.sources.some(s => s.value < 0) ? '【包含负分】' : ''))
        }
        if (!state.systems.length) lines.push('目前没有积分系统，仅保存未来默认方式。')
        const body = lines.filter(Boolean).join('\n')
        if (body.length > 12_000) throw new XpPointsUserError('涉及积分池过多，预览无法安全完整展示，请联系维护者分批处理。')
        return h.text(body + `\n五分钟内在本会话直接粘贴令牌确认：\n${proposal.token}\n可发送“取消账号操作”。`).toString()
      }
      if (!system || !['共享', '独立'].includes(mode) || (options.strategy && !['maximum', 'sum'].includes(options.strategy))) return h.text(accountModeHelp).toString()
      const member = await account(session, options.target)
      const retained = options.retained ? await account(session, options.retained) : undefined
      const proposal = await operations.previewMode(actor(session), { systemKey: system, profileId: member.profileId,
        nextMode: mode === '共享' ? 'shared' : 'independent', retainedAccountId: retained?.id, strategy: options.strategy === 'sum' ? 'sum' : 'maximum',
        periodStrategy: options.periodStrategy === 'sum' ? 'sum' : 'maximum' })
      const state = proposal.preview.state
      const sourceName = (subjectId: string) => {
        const subject = state.subjects.find(row => row.id === subjectId)
        const account = state.accounts.find(row => row.id === subject?.accountId)
        return account ? `${account.nickname}〔${account.label}〕` : `${state.profile.nickname}（共享）`
      }
      const changes = proposal.preview.plan.pools.map(pool =>
        `${pool.platform || '全局'}/${pool.guildId || '全域'}：`
        + pool.sources.map(source => `${sourceName(source.subjectId)} ${source.value}`).join('，')
        + ` → ${pool.value}` + (pool.sources.some(source => source.value < 0) ? '【包含负分，请核对被舍弃数值】' : ''))
      changes.push(`周期成绩：${options.periodStrategy === 'sum' ? '明确累加' : '逐周期取最高'}。`)
      for (const pool of proposal.preview.periodPlan.pools) {
        const [id, platform] = JSON.parse(pool.platform), period = state.periodDefinitions.find(p => p.id === id)
        changes.push(`${period?.kind} ${period?.label} ${platform || '全局'}/${pool.guildId || '全域'}：`
          + pool.sources.map(s => `${sourceName(s.subjectId)} ${s.value}`).join('，') + ` → ${pool.value}` + (pool.sources.some(s => s.value < 0) ? '【包含负分】' : ''))
      }
      const body = `账号模式变更预览：${member.nickname}，系统 ${system}，改为${mode}。\n`
        + '影响范围：该真人在此系统的全部积分池，不仅当前群。\n'
        + (retained ? `所有积分池由 ${retained.nickname}〔${retained.label}〕承接，其余账号从零开始。\n` : '')
        + (mode === '共享' ? `合分策略：${options.strategy === 'sum' ? '累加' : '取最高'}。\n` : '')
        + (changes.join('\n') || '当前没有非零积分池，其他账号关系保持不变。')
      if (body.length > 12_000) throw new XpPointsUserError('涉及积分池过多，预览无法安全完整展示，请联系维护者分批处理。')
      return h.text(body
        + `\n仅当确认所有积分池的变化后，五分钟内由本人在本会话直接粘贴令牌：\n${proposal.token}\n可发送“取消账号操作”。`).toString()
    }, accountModeHelp))

  for (const [name, method] of [['设置账号标签', 'setLabel'], ['设置账号昵称', 'setNickname']] as const) {
    command(`${name} [target:user] [value:text]`, name, { authority: method === 'setNickname' ? 2 : 1 })
      .usage(h.text(`用法：${name} <@用户或@平台:账号> <${method === 'setNickname' ? '昵称' : '标签'}>\n在当前会话修改指定账号；昵称由管理员维护，标签可由本人维护。`).toString())
      .example(`${name} @onebot:123456 示例${method === 'setNickname' ? '玩家' : '小号'}`)
      .action(({ session }, raw, value) => run(async () => {
        if (!raw || !value?.trim()) return h.text(`用法：${name} <@账号或@平台:账号> <${method === 'setNickname' ? '昵称' : '标签'}>\n示例：${name} @onebot:123456 示例${method === 'setNickname' ? '玩家' : '小号'}`).toString()
        const member = await account(session, raw)
        await operations[method](actor(session), member.profileId, member.id, value)
        return committed(h.text(`${name}完成：${member.nickname}（@${member.platform}:${member.userId}）→ ${value.trim()}。`).toString())
      }))
  }
  command('设置主号 [target:user]', '选择本人已关联账号作为主号', { authority: 1 })
    .usage(h.text('用法：设置主号 <@账号或@平台:账号>\n只修改主号标记，不改变余额。').toString())
    .example('设置主号 @onebot:123456')
    .action(({ session }, raw) => run(async () => {
      if (!raw) return h.text('用法：设置主号 <@账号或@平台:账号>').toString()
      const member = await account(session, raw)
      await operations.setPrimary(actor(session), member.profileId, member.id)
      return committed(h.text(`已设置主号：${member.nickname}（@${member.platform}:${member.userId}）。`).toString())
    }))

  ctx.middleware(async (session, next) => {
    if (!operations.matchesConfirmation(session.content)) return next()
    return run(async () => {
      const result = await operations.confirm(actor(session), session.content)
      return committed(`账号操作完成（${result.kind === 'batch' ? '批量积分' : result.kind === 'mode' || result.kind === 'all-mode' ? '积分模式' : '大小号关联'}）。`)
    })
  }, true)
  return { previewNicknameAssociation: (session: Session, source: string, main: string) => associationPreview(session, {}, source, main, false) }
}
