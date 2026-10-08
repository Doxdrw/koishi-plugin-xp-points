import { XpPointsUserError } from './errors'
import type { Context } from 'koishi'
import { requireAccountAuthority, type AccountActor } from './account-maintenance'
import { accountScoreName } from './account-display'
import { resolveDefaultScoreMode, type AccountScoreMode } from './account-policy'
import { subjectLeaderboardIn } from './subject-ledger'
import type { SubjectWriteCoordinator } from './mutation-coordinator'
import { ACCOUNT_SCHEMA_VERSION, ACCOUNT_SCHEMA_KEY } from './account-storage'
import { periodDateIn } from './period-ledger'

type Database = Context['database']
type Pool = { platform?: string, guildId?: string }
type OverviewOptions = { includeSingles?: boolean, pendingOnly?: boolean, keyword?: string }
export interface AccountLeaderboardEntry {
  profileId: number
  subjectId: string
  accountId: string | null
  nickname: string
  value: number
  inactive?: true
}
const key = (platform: string, userId: string) => JSON.stringify([platform, userId])
function paginate<T>(entries: T[], page: number, pageSize: number) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new XpPointsUserError('页码和每页条数无效。')
  }
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize))
  if (page > totalPages) throw new XpPointsUserError(`当前只有 ${totalPages} 页。`)
  return { entries: entries.slice((page - 1) * pageSize, page * pageSize), total: entries.length, page, pageSize, totalPages }
}

/** Subject-aware read boundary; caller controls the authorized reply conversation. */
export class AccountQueryStore {
  constructor(private readonly database: Database, private readonly writes: SubjectWriteCoordinator,
    private readonly defaultMode: AccountScoreMode = 'shared') {}

  private run<T>(callback: (db: Database) => Promise<T>) {
    return this.writes.run(() => this.database.transact(async db => {
      const schema = (await db.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
      if (schema?.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构尚未初始化。')
      return callback(db)
    }))
  }

  account(platform: string, userId: string) {
    return this.run(async db => {
      const identity = (await db.get('xp_identity', { platform, userId }))[0]
      const account = (await db.get('xp_account', { platform, userId }))[0]
      if (!identity || !account) throw new XpPointsUserError('该账号尚未登记，请先使用昵称或积分功能建档。')
      return { ...account, profileId: identity.profileId }
    })
  }
  scoreDate(systemKey: string, raw: string) { return this.run(db => periodDateIn(db, systemKey, raw)) }

  leaderboard(systemKey: string, context: Pool, options: { inactivePolicy?: 'hide' | 'show', page?: number, pageSize?: number } = {}) {
    const settings = { ...options }
    return this.leaderboardEntries(systemKey, context, settings)
      .then(entries => paginate(entries, settings.page ?? 1, settings.pageSize ?? 50))
  }

  leaderboardEntries(systemKey: string, context: Pool, options: { inactivePolicy?: 'hide' | 'show'; periodId?: string } = {}): Promise<AccountLeaderboardEntry[]> {
    const pool = { ...context }, settings = { ...options }
    return this.run(async db => {
      if (settings.inactivePolicy && !['hide', 'show'].includes(settings.inactivePolicy)) throw new XpPointsUserError('榜单停用策略无效。')
      const rows = await subjectLeaderboardIn(db, systemKey, pool)
      const system = (await db.get('xp_score_system', { key: systemKey }))[0]
      if (!system.active) throw new XpPointsUserError('积分系统已停用。')
      const platform = pool.platform?.trim() ?? '', originGuild = pool.guildId?.trim() ?? ''
      const alias = system.scope === 'guild' ? (await db.get('xp_score_guild_alias', {
        systemKey, platform, sourceGuildId: originGuild,
      }))[0] : undefined
      const balancePool = { platform: system.scope === 'global' ? '' : platform,
        guildId: system.scope === 'guild' ? alias?.targetGuildId ?? originGuild : '' }
      // Preserve the existing public board contract: no synthetic zero-score
      // entries for accounts that have never had a balance in the queried pool.
      if (settings.periodId && !(await db.get('xp_period_definition', { id: settings.periodId, systemKey })).length) throw new XpPointsUserError('周期不属于指定积分系统。')
      const balances = settings.periodId ? await db.get('xp_period_score', { ...balancePool, periodId: settings.periodId }) : await db.get('xp_subject_balance', balancePool)
      if (balances.some(row => !Number.isFinite(row.value))) throw new XpPointsUserError('排行榜成绩包含非法数值，无法显示。')
      const scored = new Set(balances.map(row => row.subjectId))
      if (settings.periodId) {
        const values = new Map<string, number>(balances.map(row => [row.subjectId, row.value] as const))
        for (const row of rows) row.value = values.get(row.subjectId) ?? 0
      }
      const identities = [...new Map(rows.flatMap(row => row.identities)
        .map(identity => [key(identity.platform, identity.userId), identity])).values()]
      const authorities = new Map<string, number>()
      for (const platform of new Set(identities.map(identity => identity.platform))) {
        const ids = identities.filter(identity => identity.platform === platform).map(identity => identity.userId)
        const bindings = await db.get('binding', { platform, pid: ids })
        const users = bindings.length ? await db.get('user', { id: [...new Set(bindings.map(row => row.aid))] }) : []
        const values = new Map(users.map(row => [row.id, row.authority]))
        for (const binding of bindings) {
          const authority = values.get(binding.aid)
          if (authority !== undefined) authorities.set(key(platform, binding.pid), authority)
        }
      }
      const presences = platform && originGuild ? await db.get('xp_guild_presence', { platform, guildId: originGuild }) : []
      const presence = new Map(presences.map(row => [key(row.platform, row.userId), row.state]))
      const entries = rows.filter(row => scored.has(row.subjectId)).map(row => {
        const inPlatform = row.identities.filter(identity => !platform || identity.platform === platform)
        // A cross-platform-only account has unknown membership here, but a known
        // authority-0 login is still disabled. Never ask a remote member API.
        const relevant = inPlatform.length ? inPlatform : row.identities
        const inactive = relevant.length > 0 && relevant.every(identity =>
          authorities.get(key(identity.platform, identity.userId)) === 0
          || presence.get(key(identity.platform, identity.userId)) === 'inactive')
        return { profileId: row.profileId, subjectId: row.subjectId, accountId: row.accountId,
          nickname: accountScoreName(row), value: row.value, ...(inactive ? { inactive: true as const } : {}) }
      }).filter(row => settings.inactivePolicy === 'show' || !row.inactive)
      // Independent accounts stay globally score-sorted, never grouped by person.
      entries.sort((a, b) => b.value - a.value || a.subjectId.localeCompare(b.subjectId))
      return entries
    })
  }

  private async personIn(db: Database, profileId: number) {
    const profile = (await db.get('xp_profile', { id: profileId }))[0]
    const preference = (await db.get('xp_person_preference', { profileId }))[0]
    if (!profile || !preference) throw new XpPointsUserError('真人档案不存在或不完整。')
    const accounts = []
    for (const identity of await db.get('xp_identity', { profileId })) {
      const account = (await db.get('xp_account', { platform: identity.platform, userId: identity.userId }))[0]
      if (!account) throw new XpPointsUserError('账号档案不完整。')
      accounts.push({ ...account, primary: preference.primaryAccountId === account.id })
    }
    if (!accounts.length || (preference.primaryAccountId && !accounts.some(account => account.primary))) throw new XpPointsUserError('真人账号或主号归属不完整。')
    const policies = await db.get('xp_account_policy', { profileId })
    const systems = await db.get('xp_score_system', {})
    if (policies.length !== systems.length || systems.some(system => !policies.some(policy => policy.systemKey === system.key))) {
      throw new XpPointsUserError('真人积分系统策略不完整。')
    }
    const subjects = await db.get('xp_score_subject', { profileId, active: true })
    const balances = subjects.length ? await db.get('xp_subject_balance', { subjectId: subjects.map(row => row.id) }) : []
    const summaries = systems.map(system => {
      const mode = policies.find(policy => policy.systemKey === system.key)!.mode
      const ownSubjects = subjects.filter(row => row.systemKey === system.key)
      if (mode === 'shared' ? ownSubjects.length !== 1 || ownSubjects[0].accountId !== null
        : ownSubjects.length !== accounts.length || accounts.some(account => !ownSubjects.some(row => row.accountId === account.id))) {
        throw new XpPointsUserError('真人计分主体不完整。')
      }
      const ownIds = new Set(ownSubjects.map(row => row.id))
      const pools = [...new Map(balances.filter(row => ownIds.has(row.subjectId))
        .map(row => [key(row.platform, row.guildId), { platform: row.platform, guildId: row.guildId }])).values()]
        .sort((a, b) => key(a.platform, a.guildId).localeCompare(key(b.platform, b.guildId)))
        .map(pool => {
          const entries = ownSubjects.map(subject => ({ accountId: subject.accountId,
            value: balances.find(row => row.subjectId === subject.id && row.platform === pool.platform && row.guildId === pool.guildId)?.value ?? 0 }))
          return { ...pool, entries, highest: Math.max(...entries.map(row => row.value)) }
        })
      return { key: system.key, name: system.name, unit: system.unit, active: system.active, mode, pools }
    })
    return { profile, primaryAccountId: preference.primaryAccountId, accounts: accounts.sort((a, b) => a.id.localeCompare(b.id)),
      defaultScoreMode: resolveDefaultScoreMode(preference.defaultScoreMode, policies.map(row => row.mode), this.defaultMode),
      systems: summaries,
      historicalBalanceNotice: '历史合并时已舍弃的低余额无法自动恢复。' }
  }

  person(actor: AccountActor, profileId?: number) {
    const operator = { ...actor }
    return this.run(async db => {
      const authority = await requireAccountAuthority(db, operator)
      const identity = (await db.get('xp_identity', { platform: operator.platform, userId: operator.userId }))[0]
      const target = profileId ?? identity?.profileId
      if (!target) throw new XpPointsUserError('本人尚未建档。')
      if (authority < 2 && identity?.profileId !== target) throw new XpPointsUserError('只能查询本人已关联账号。')
      return this.personIn(db, target)
    })
  }

  personByNickname(actor: AccountActor, nickname: string) {
    const operator = { ...actor }, name = nickname.trim()
    return this.run(async db => {
      const authority = await requireAccountAuthority(db, operator)
      if (!name) throw new XpPointsUserError('请提供完整管理昵称。')
      const profile = (await db.get('xp_profile', { nickname: name }))[0]
      const identity = (await db.get('xp_identity', { platform: operator.platform, userId: operator.userId }))[0]
      if (authority < 2 && (!profile || identity?.profileId !== profile.id)) throw new XpPointsUserError('只能查询本人已关联账号。')
      if (!profile) throw new XpPointsUserError('未找到该管理昵称，请使用完整管理昵称或 @账号查询。')
      return this.personIn(db, profile.id)
    })
  }

  guild(actor: AccountActor, platform: string, guildId: string, page = 1, pageSize = 10,
    options: OverviewOptions = {}) {
    if (!platform?.trim() || !guildId?.trim()) return Promise.reject(new Error('查询本群大小号需要来源平台和群号。'))
    return this.overview(actor, { platform, guildId }, page, pageSize, options)
  }

  all(actor: AccountActor, page = 1, pageSize = 10, options: OverviewOptions = {}) {
    return this.overview(actor, undefined, page, pageSize, options)
  }

  platform(actor: AccountActor, platform: string, page = 1, pageSize = 10, options: OverviewOptions = {}) {
    if (!platform?.trim()) return Promise.reject(new Error('请指定有效平台。'))
    return this.overview(actor, { platform }, page, pageSize, options)
  }

  private overview(actor: AccountActor, scope: { platform: string, guildId?: string } | undefined,
    page: number, pageSize: number, options: OverviewOptions) {
    const operator = { ...actor }, settings = { ...options }
    return this.run(async db => {
      if (await requireAccountAuthority(db, operator) < 2) throw new XpPointsUserError('查询大小号管理列表需要管理员权限。')
      const presences = scope?.guildId ? await db.get('xp_guild_presence', { platform: scope.platform, guildId: scope.guildId }) : []
      const ids = [...new Set(presences.map(row => row.userId))]
      const identities = !scope ? await db.get('xp_identity', {})
        : !scope.guildId ? await db.get('xp_identity', { platform: scope.platform })
        : ids.length ? await db.get('xp_identity', { platform: scope.platform, userId: ids }) : []
      const people = [...new Set(identities.map(row => row.profileId))]
      // Expand linked accounts on the selected platform, not unrelated sandboxes.
      // This overview deliberately does not fetch any score pools or journals.
      const linked = people.length ? await db.get('xp_identity', { profileId: people, ...(scope ? { platform: scope.platform } : {}) }) : []
      const accounts = []
      for (const provider of new Set(linked.map(row => row.platform))) {
        accounts.push(...await db.get('xp_account', { platform: provider,
          userId: linked.filter(row => row.platform === provider).map(row => row.userId) }))
      }
      const accountByLogin = new Map(accounts.map(row => [key(row.platform, row.userId), row]))
      const profiles = people.length ? await db.get('xp_profile', { id: people }) : []
      const preferences = people.length ? await db.get('xp_person_preference', { profileId: people }) : []
      const policies = people.length ? await db.get('xp_account_policy', { profileId: people }) : []
      const systems = await db.get('xp_score_system', {})
      const presenceByLogin = new Map(presences.map(row => [key(row.platform, row.userId), row.state]))
      const keyword = settings.keyword?.trim().toLocaleLowerCase() ?? ''
      if (keyword.length > 100) throw new XpPointsUserError('搜索关键词最多 100 个字符。')
      const summaries = profiles.map(profile => {
        const preference = preferences.find(row => row.profileId === profile.id)
        if (!preference) throw new XpPointsUserError('真人档案不完整。')
        const members = linked.filter(row => row.profileId === profile.id).map(identity => {
          const account = accountByLogin.get(key(identity.platform, identity.userId))
          if (!account) throw new XpPointsUserError('账号档案不完整。')
          return { ...account, primary: account.id === preference.primaryAccountId,
            guildState: presenceByLogin.get(key(account.platform, account.userId)) ?? 'unknown' }
        }).sort((a, b) => Number(b.primary) - Number(a.primary) || a.id.localeCompare(b.id))
        const accountSystems = policies.filter(row => row.profileId === profile.id).map(policy => {
          const system = systems.find(row => row.key === policy.systemKey)
          return { key: policy.systemKey, name: system?.name ?? policy.systemKey, mode: policy.mode }
        })
        const independentSystems = accountSystems.filter(row => row.mode === 'independent')
        const needsIndividualMetadata = members.length > 1 && independentSystems.length > 0
        const missingPrimary = needsIndividualMetadata && !preference.primaryAccountId
        const unknownNames = needsIndividualMetadata ? members.filter(row => row.nicknameStatus === 'unknown').length : 0
        return { profile, primaryAccountId: preference.primaryAccountId, accounts: members,
          defaultScoreMode: resolveDefaultScoreMode(preference.defaultScoreMode, accountSystems.map(row => row.mode), this.defaultMode),
          primaryOutsidePlatform: !!scope && !!preference.primaryAccountId && !members.some(row => row.primary),
          missingPrimary, unknownNames, needsReview: missingPrimary || unknownNames > 0,
          independentSystems, systems: accountSystems }
      })
      const multi = summaries.filter(row => row.accounts.length > 1)
      const filtered = summaries.filter(row => (settings.includeSingles || row.accounts.length > 1)
        && (!settings.pendingOnly || row.needsReview)
        && (!keyword || [row.profile.nickname, ...row.accounts.flatMap(account =>
          [account.nickname, account.label, account.userId, `${account.platform}:${account.userId}`])]
          .some(value => value.toLocaleLowerCase().includes(keyword))))
        .sort((a, b) => Number(b.needsReview) - Number(a.needsReview) || a.profile.id - b.profile.id)
      return { ...paginate(filtered, page, pageSize), knownAccounts: identities.length,
        knownPeople: people.length, multiPeople: multi.length, pendingPeople: multi.filter(row => row.needsReview).length,
        completeness: 'local-only' as const,
        notice: scope?.guildId ? '仅基于本群本地活动记录；未确认的关联账号不等于已在群。'
          : scope ? `范围：${scope.platform} 全部已登记账号（含无群活动记录）；不是远程成员扫描。`
          : '范围：本实例全部已登记账号，包含无群活动记录的账号；不是远程成员扫描。' }
    })
  }
}
