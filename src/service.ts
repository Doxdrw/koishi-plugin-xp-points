import { createHash, randomBytes } from 'node:crypto'
import { XpPointsUserError, safeErrorSummary } from './errors'
export { XpPointsUserError } from './errors'
import { Bot, Context, Service, $ } from 'koishi'
import { SubjectWriteCoordinator } from './mutation-coordinator'
import { AccountLifecycleStore, type AccountDefaults } from './account-lifecycle'
import { AccountOperations } from './account-operations'
import { configurePeriodsIn, resolvePeriodIn, periodDateIn } from './period-ledger'
import type { ScorePeriodConfig, ScorePeriodKind } from './period-calendar'
import type { PeriodDefinition } from './period-model'
import { AccountQueryStore } from './account-queries'
import { SubjectLedgerStore, type ScoreAccountTarget } from './subject-ledger'
import { requireAccountAuthority, type AccountActor } from './account-maintenance'
import { readAccountDeletion, eraseAccountData, readSystemAccountDeletion, eraseSystemAccountData } from './account-deletion'
import {
  XpGuildPresence,
  XpGuildPresenceState,
  XpIdentity,
  XpProfile,
  XpProfileMerge,
  XpScoreGuildAlias,
  XpScoreJournal,
  XpScoreScope,
  XpScoreSystem,
} from './model'
import type { XpSubjectBalance } from './account-model'
import {
  InternalScoreMutationContext,
  ScoreConsumerRegistration,
  ScoreCommandBindingConfig,
  ScoreLeaderboardEntry,
  ScoreLeaderboardPage,
  ScoreJournalPage,
  ScoreLedgerHandle,
  ScoreMutationResult,
  ScoreOperationContext,
  ScoreSystemDefinition,
} from './score-ledger'
import {
  ProfileDataConsumer,
  ProfileDataConsumerPreview,
  ProfileDeletionActor,
  ProfileDeletionPreview,
  ProfileDeletionResult,
  ProfileDeletionScope,
} from './deletion'
import { normalizeGuildAliasPolicy, normalizeGuildAliasStrategy, type GuildAliasCombineStrategy } from './guild-alias-policy'
import { aggregateGuildComponents, getGuildAliasPolicyIn, BASELINE_SOURCE, TARGET_ADJUSTMENT_SOURCE } from './guild-alias-components'

export type LeaderboardInactivePolicy = 'hide' | 'show'

export type ScoreGuildAliases = Record<string, Record<string, Record<string, string>>>

export interface XpPointsRuntimeConfig {
  scorePeriods?: Record<string, ScorePeriodConfig>
  accountDefaults?: AccountDefaults
  scoreSystems: ScoreSystemDefinition[]
  scoreCommandBindings: ScoreCommandBindingConfig[]
  scoreGuildAliases: ScoreGuildAliases
  scoreGuildAliasDefaults?: { balance?: GuildAliasCombineStrategy, period?: GuildAliasCombineStrategy }
  leaderboardInactivePolicy: LeaderboardInactivePolicy
  requiredDeletionConsumers: string[]
  leaderboardPageSize?: number
  leaderboardEntriesPerLine?: number
  memberScanPreviewLimit?: number
}

export interface ManagedProfileInspection {
  profile: XpProfile
  profileIds: number[]
  identities: XpIdentity[]
  presences: XpGuildPresence[]
  balances: Array<XpSubjectBalance & { systemKey: string, profileId: number, accountNickname?: string }>
}

export interface ManagedIdentity {
  accountId: string
  profileId: number
  nickname: string
  platform: string
  userId: string
  automatic: boolean
}

export interface GuildMemberScanChange {
  userId: string
  previous: XpGuildPresenceState | 'unknown'
  next: XpGuildPresenceState
}

export interface GuildMemberScanResult {
  platform: string
  guildId: string
  memberCount: number
  candidates: number
  changes: GuildMemberScanChange[]
  executed: boolean
}

interface StoredDeletionToken {
  actorKey: string
  expiresAt: number
  request: { kind: 'identity', target: string } | { kind: 'profile', nickname: string }
  fingerprint: string
}

interface StoredSystemDeletionToken {
  actorKey: string
  expiresAt: number
  systemKey: string
  fingerprint: string
}

interface StoredGuildAliasToken {
  actorKey: string
  expiresAt: number
  fingerprint: string
  balanceStrategy: GuildAliasCombineStrategy
  periodStrategy: GuildAliasCombineStrategy
}

interface BuiltDeletionPreview {
  scope: ProfileDeletionScope
  fingerprint: string
  summary: string[]
  consumerRows: number
  profileRows: number
}

interface ResolvedScorePool {
  system: XpScoreSystem
  platform: string
  guildId: string
  originPlatform: string
  originGuildId: string
}

function identityKey(platform: string, userId: string): string {
  return platform + '\0' + userId
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unique|constraint|database is locked|database is busy/i.test(message)
}

function parseTarget(target: string): { platform: string, userId: string } {
  if (typeof target !== 'string') {
    throw new XpPointsUserError('无法解析目标用户，请使用 Koishi 用户参数。')
  }
  const separator = target.lastIndexOf(':')
  if (separator <= 0 || separator >= target.length - 1) {
    throw new XpPointsUserError('无法解析目标用户，请使用 Koishi 用户参数。')
  }
  return { platform: target.slice(0, separator), userId: target.slice(separator + 1) }
}

function requireFiniteScore(...values: number[]): void {
  if (values.some(value => !Number.isFinite(value))) {
    throw new XpPointsUserError('积分或变更量超出有限数值范围，操作已取消；请检查数值及原有余额。')
  }
}

export class XpPointsService extends Service {
  readonly usesDedicatedStorage = true
  private readonly identities = new Map<string, ManagedIdentity>()
  private readonly identityLocks = new Map<string, Promise<ManagedIdentity>>()
  private readonly writes = new SubjectWriteCoordinator()
  private readonly lifecycle: AccountLifecycleStore
  readonly accountOperations: AccountOperations
  readonly accountQueries: AccountQueryStore
  private readonly subjectLedger: SubjectLedgerStore
  private accountReady?: Promise<void>
  private loaded = false
  private loading?: Promise<void>
  private readonly deletionConsumers = new Map<string, ProfileDataConsumer>()
  private readonly deletionTokens = new Map<string, StoredDeletionToken>()
  private readonly systemDeletionTokens = new Map<string, StoredSystemDeletionToken>()
  private readonly guildAliasTokens = new Map<string, StoredGuildAliasToken>()
  private readonly scoreConsumers = new Map<string, ScoreLedgerHandle>()
  private readonly scoreDefinitions = new Map<string, ScoreSystemDefinition>()
  private readonly configuredScoreSystemKeys = new Set<string>()
  private readonly defaultScoreSystemOwners = new Map<string, Set<string>>()
  private readonly scoreAliases = new Map<string, string>()
  private scoreLoaded = false
  private scoreLoading?: Promise<void>

  constructor(ctx: Context, readonly config: XpPointsRuntimeConfig) {
    super(ctx, 'xpPoints', true)
    this.lifecycle = new AccountLifecycleStore(ctx.database, this.writes, config.accountDefaults)
    this.accountOperations = new AccountOperations(ctx.database, this.writes)
    this.accountQueries = new AccountQueryStore(ctx.database, this.writes, config.accountDefaults?.mode)
    this.subjectLedger = new SubjectLedgerStore(ctx.database, this.writes)
    ctx.on('dispose', () => this.accountOperations.dispose())
    const configuredNames = new Map<string, string>()
    for (const rawDefinition of config.scoreSystems ?? []) {
      const definition = normalizeSystemDefinition(rawDefinition)
      const previous = this.scoreDefinitions.get(definition.key)
      if (previous) {
        throw new XpPointsUserError(`积分系统 ${definition.key} 在 scoreSystems 中重复声明。`)
      }
      const nameOwner = configuredNames.get(definition.name)
      if (nameOwner) {
        throw new XpPointsUserError(`积分系统名称“${definition.name}”同时用于 ${nameOwner} 和 ${definition.key}。`)
      }
      configuredNames.set(definition.name, definition.key)
      this.scoreDefinitions.set(definition.key, definition)
      this.configuredScoreSystemKeys.add(definition.key)
    }
    ctx.on('ready', async () => {
      await this.reload()
      await this.ensureScoreLedgerLoaded()
    })
  }

  resolveNickname(platform: string, userId: string, fallback?: string): string | undefined {
    return this.identities.get(identityKey(platform, userId))?.nickname ?? fallback
  }

  async reload(): Promise<void> {
    await this.ensureAccountStorage()
    if (this.loading) return this.loading
    this.loading = this.loadCache().finally(() => { this.loading = undefined })
    return this.loading
  }

  private ensureAccountStorage(): Promise<void> {
    return this.accountReady ??= this.lifecycle.bootstrap()
  }

  registerAccountConsumer(consumer: string) {
    return this.accountOperations.registerConsumer(consumer)
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.reload()
  }

  registerScoreConsumer(registration: ScoreConsumerRegistration): ScoreLedgerHandle {
    const consumer = registration.consumer.trim()
    const systemKey = normalizeSystemKey(registration.systemKey)
    if (!consumer) throw new Error('积分消费方必须提供名称。')
    if (this.scoreConsumers.has(consumer)) throw new Error('积分消费方重复注册：' + consumer)
    if (registration.defaultSystem) {
      const definition = normalizeSystemDefinition(registration.defaultSystem)
      if (definition.key !== systemKey) {
        throw new Error(`消费方 ${consumer} 的默认系统 key 必须与绑定 key 一致。`)
      }
      const previous = this.scoreDefinitions.get(systemKey)
      if (previous && previous.scope !== definition.scope) {
        throw new Error(`积分系统 ${systemKey} 被配置或消费方声明为不同作用域。`)
      }
      if (!previous) this.scoreDefinitions.set(systemKey, definition)
      const owners = this.defaultScoreSystemOwners.get(systemKey) ?? new Set<string>()
      owners.add(consumer)
      this.defaultScoreSystemOwners.set(systemKey, owners)
      this.scoreLoaded = false
    }
    let handle!: ScoreLedgerHandle
    handle = new ScoreLedgerHandle(this, consumer, systemKey, () => {
      if (this.scoreConsumers.get(consumer) !== handle) return
      this.scoreConsumers.delete(consumer)
      const owners = this.defaultScoreSystemOwners.get(systemKey)
      owners?.delete(consumer)
      if (owners?.size === 0) {
        this.defaultScoreSystemOwners.delete(systemKey)
        if (!this.configuredScoreSystemKeys.has(systemKey)) this.scoreDefinitions.delete(systemKey)
      }
    })
    this.scoreConsumers.set(consumer, handle)
    return handle
  }

  listActiveScoreConsumers(): Array<{ consumer: string, systemKey: string }> {
    return [...this.scoreConsumers.entries()]
      .map(([consumer, handle]) => ({ consumer, systemKey: handle.systemKey }))
      .sort((left, right) => left.consumer.localeCompare(right.consumer))
  }

  async listScoreSystems(includeInactive = true): Promise<XpScoreSystem[]> {
    await this.ensureScoreLedgerLoaded()
    const rows = await this.ctx.database.get('xp_score_system', {})
    return rows
      .filter(row => includeInactive || row.active)
      .sort((left, right) => left.key.localeCompare(right.key))
  }

  async createScoreSystem(definition: ScoreSystemDefinition, createdBy: string): Promise<XpScoreSystem> {
    const normalized = normalizeSystemDefinition(definition)
    await this.ensureLoaded()
    await this.retryConflictingMutation(() => this.serializeMutation(() => this.ctx.database.transact(async database => {
      const existing = (await database.get('xp_score_system', { key: normalized.key }))[0]
      if (existing) {
        if (existing.scope !== normalized.scope) {
          throw new XpPointsUserError(`积分系统 ${normalized.key} 已存在，且作用域不可更改。`)
        }
        await this.lifecycle.initializeSystemIn(database, normalized.key)
        return
      }
      const sameName = (await database.get('xp_score_system', { name: normalized.name }))[0]
      if (sameName) throw new XpPointsUserError(`积分系统名称“${normalized.name}”已被 ${sameName.key} 使用。`)
      const now = new Date()
      await database.create('xp_score_system', {
        key: normalized.key,
        name: normalized.name,
        unit: normalized.unit ?? '分',
        scope: normalized.scope,
        active: true,
        createdBy: createdBy.trim() || 'unknown',
        createdAt: now,
        updatedAt: now,
      })
      await this.lifecycle.initializeSystemIn(database, normalized.key)
    })))
    this.scoreLoaded = false
    await this.ensureScoreLedgerLoaded()
    return this.requireScoreSystem(normalized.key, true)
  }

  async renameScoreSystem(key: string, name: string): Promise<XpScoreSystem> {
    const systemKey = normalizeSystemKey(key)
    const normalizedName = normalizeSystemName(name)
    await this.ensureScoreLedgerLoaded()
    await this.serializeMutation(() => this.ctx.database.transact(async database => {
      const system = (await database.get('xp_score_system', { key: systemKey }))[0]
      if (!system) throw new XpPointsUserError(`积分系统 ${systemKey} 不存在。`)
      const conflict = (await database.get('xp_score_system', { name: normalizedName }))[0]
      if (conflict && conflict.key !== systemKey) {
        throw new XpPointsUserError(`积分系统名称“${normalizedName}”已被 ${conflict.key} 使用。`)
      }
      await database.set('xp_score_system', { key: systemKey }, { name: normalizedName, updatedAt: new Date() })
    }))
    return this.requireScoreSystem(systemKey, true)
  }

  async setScoreSystemUnit(key: string, unit: string): Promise<XpScoreSystem> {
    const systemKey = normalizeSystemKey(key)
    const normalizedUnit = normalizeScoreUnit(unit)
    await this.ensureScoreLedgerLoaded()
    await this.serializeMutation(() => this.ctx.database.transact(async database => {
      if (!(await database.get('xp_score_system', { key: systemKey })).length) {
        throw new XpPointsUserError(`积分系统 ${systemKey} 不存在。`)
      }
      await database.set('xp_score_system', { key: systemKey }, { unit: normalizedUnit, updatedAt: new Date() })
    }))
    return this.requireScoreSystem(systemKey, true)
  }

  async setScoreSystemActive(key: string, active: boolean): Promise<XpScoreSystem> {
    const systemKey = normalizeSystemKey(key)
    await this.ensureScoreLedgerLoaded()
    await this.serializeMutation(() => this.ctx.database.transact(async database => {
      if (!(await database.get('xp_score_system', { key: systemKey })).length) {
        throw new XpPointsUserError(`积分系统 ${systemKey} 不存在。`)
      }
      await database.set('xp_score_system', { key: systemKey }, { active, updatedAt: new Date() })
    }))
    return this.requireScoreSystem(systemKey, true)
  }

  async previewDeleteScoreSystem(
    key: string,
    actor: ProfileDeletionActor,
  ): Promise<{ token: string, expiresAt: Date, summary: string[] }> {
    const systemKey = normalizeSystemKey(key)
    await this.ensureScoreLedgerLoaded()
    this.assertScoreSystemNotBound(systemKey)
    const snapshot = await this.serializeMutation(() => this.ctx.database.transact(async database => {
      await this.requireDeletionAuthority(database, actor)
      this.assertScoreSystemNotBound(systemKey)
      return this.buildScoreSystemDeletionSnapshot(database, systemKey)
    }))
    const token = 'XPSYSDEL-' + randomBytes(12).toString('base64url')
    const expiresAt = Date.now() + 5 * 60_000
    this.systemDeletionTokens.set(token, {
      actorKey: deletionActorKey(actor),
      expiresAt,
      systemKey,
      fingerprint: createHash('sha256').update(stableJson(snapshot)).digest('hex'),
    })
    return {
      token,
      expiresAt: new Date(expiresAt),
      summary: [
        `删除积分系统 ${snapshot.system.key}（${snapshot.system.name}，${snapshot.system.scope}）。`,
        `将删除 ${snapshot.balances.length} 条余额、${snapshot.journals.length} 条审计日志、${snapshot.aliases.length} 条群挂靠。`,
      ],
    }
  }

  async confirmDeleteScoreSystem(
    token: string,
    actor: ProfileDeletionActor,
  ): Promise<{ key: string, balances: number, journals: number, aliases: number }> {
    const stored = this.systemDeletionTokens.get(token)
    if (!stored) throw new XpPointsUserError('确认令牌不存在或已经使用，请重新预览。')
    if (stored.expiresAt <= Date.now()) {
      this.systemDeletionTokens.delete(token)
      throw new XpPointsUserError('确认令牌已过期，请重新预览。')
    }
    if (stored.actorKey !== deletionActorKey(actor)) {
      throw new XpPointsUserError('确认令牌不属于当前管理员、机器人或会话。')
    }
    this.assertScoreSystemNotBound(stored.systemKey)
    this.systemDeletionTokens.delete(token)
    let result!: { key: string, balances: number, journals: number, aliases: number }
    await this.serializeMutation(() => this.ctx.database.transact(async database => {
      await this.requireDeletionAuthority(database, actor)
      if (stored.expiresAt <= Date.now()) throw new XpPointsUserError('确认令牌已过期，请重新预览。')
      this.assertScoreSystemNotBound(stored.systemKey)
      const snapshot = await this.buildScoreSystemDeletionSnapshot(database, stored.systemKey)
      const fingerprint = createHash('sha256').update(stableJson(snapshot)).digest('hex')
      if (fingerprint !== stored.fingerprint) {
        throw new XpPointsUserError('积分系统数据已经变化，请重新预览后确认。')
      }
      await eraseSystemAccountData(database, stored.systemKey, snapshot)
      await database.remove('xp_score_guild_alias', { systemKey: stored.systemKey })
      await database.remove('xp_score_system', { key: stored.systemKey })
      result = {
        key: stored.systemKey,
        balances: snapshot.balances.length,
        journals: snapshot.journals.length,
        aliases: snapshot.aliases.length,
      }
    }))
    this.scoreLoaded = false
    return result
  }

  private assertScoreSystemNotBound(systemKey: string): void {
    const consumers = this.listActiveScoreConsumers()
      .filter(consumer => consumer.systemKey === systemKey)
      .map(consumer => consumer.consumer)
    if ((this.config.scoreCommandBindings ?? [])
      .some(binding => normalizeSystemKey(binding.systemKey) === systemKey)) {
      consumers.unshift('xp-points 配置化积分指令')
    }
    if (this.configuredScoreSystemKeys.has(systemKey)) {
      consumers.unshift('xp-points scoreSystems 配置')
    }
    if (consumers.length) {
      throw new XpPointsUserError(`积分系统 ${systemKey} 仍被以下消费方绑定：${consumers.join('、')}。`)
    }
  }

  private async buildScoreSystemDeletionSnapshot(database: Context['database'], systemKey: string) {
    const system = (await database.get('xp_score_system', { key: systemKey }))[0]
    if (!system) throw new XpPointsUserError(`积分系统 ${systemKey} 不存在。`)
    const snapshot = await readSystemAccountDeletion(database, systemKey)
    this.accountOperations.assertMutable({ profileIds: snapshot.subjects.map(row => row.profileId),
      accountIds: snapshot.subjects.flatMap(row => row.accountId ? [row.accountId] : []) })
    const aliases = await database.get('xp_score_guild_alias', { systemKey })
    return {
      system,
      ...snapshot,
      aliases: aliases.sort((left, right) => left.platform.localeCompare(right.platform)
        || left.sourceGuildId.localeCompare(right.sourceGuildId)),
    }
  }

  async requireScoreSystem(key: string, allowInactive = false): Promise<XpScoreSystem> {
    const systemKey = normalizeSystemKey(key)
    await this.ensureScoreLedgerLoaded()
    const system = (await this.ctx.database.get('xp_score_system', { key: systemKey }))[0]
    if (!system) throw new XpPointsUserError(`积分系统 ${systemKey} 不存在。`)
    if (!allowInactive && !system.active) throw new XpPointsUserError(`积分系统 ${systemKey} 已停用。`)
    return system
  }

  resolveScoreGuildSync(systemKey: string, platform: string, guildId: string): string {
    return this.scoreAliases.get(scoreAliasKey(systemKey, platform, guildId)) ?? guildId
  }

  async resolveScoreGuild(systemKey: string, platform: string, guildId: string): Promise<string> {
    await this.ensureScoreLedgerLoaded()
    return this.resolveScoreGuildSync(normalizeSystemKey(systemKey), platform, guildId)
  }

  /** Current configuration versus applied alias state, without changing the database. */
  async getGuildAliasRemapStatus() {
    await this.ensureScoreLedgerLoaded()
    return this.serializeMutation(() => this.ctx.database.transact(async db => {
      const systems = new Map((await db.get('xp_score_system', {})).map(system => [system.key, system]))
      const desired = normalizeScoreAliases(this.config.scoreGuildAliases ?? {}, systems)
      const applied = await db.get('xp_score_guild_alias', {})
      const appliedMap = aliasMap(applied)
      const desiredMap = aliasMap(desired)
      const pending = [...new Set([...appliedMap.keys(), ...desiredMap.keys()])]
        .some(key => (appliedMap.get(key) ?? key.slice(key.lastIndexOf('\0') + 1)) !== (desiredMap.get(key) ?? key.slice(key.lastIndexOf('\0') + 1)))
      return {
        pending,
        desired,
        applied,
        strategies: await db.get('xp_score_guild_alias_policy', {}),
      }
    }))
  }

  async previewGuildAliasRemap(
    actor: ProfileDeletionActor,
    options: { balanceStrategy?: GuildAliasCombineStrategy, periodStrategy?: GuildAliasCombineStrategy } = {},
  ) {
    await this.ensureScoreLedgerLoaded()
    const balanceStrategy = options.balanceStrategy
      ? normalizeGuildAliasStrategy(options.balanceStrategy, '累计积分合并策略')
      : normalizeGuildAliasPolicy(this.config.scoreGuildAliasDefaults).balance
    const periodStrategy = options.periodStrategy
      ? normalizeGuildAliasStrategy(options.periodStrategy, '周期成绩合并策略')
      : normalizeGuildAliasPolicy(this.config.scoreGuildAliasDefaults).period
    const snapshot = await this.serializeMutation(() => this.ctx.database.transact(async database => {
      await this.requireDeletionAuthority(database, actor)
      return buildGuildAliasRemapSnapshot(database, this.config.scoreGuildAliases ?? {}, balanceStrategy, periodStrategy)
    }))
    if (snapshot.alreadyRemapped) throw new XpPointsUserError('群挂靠配置已经应用，无需重映射。')
    const token = 'XPALIAS-' + randomBytes(12).toString('base64url')
    const expiresAt = Date.now() + 5 * 60_000
    const fingerprint = createHash('sha256').update(stableJson(snapshot)).digest('hex')
    this.guildAliasTokens.set(token, { actorKey: deletionActorKey(actor), expiresAt, fingerprint, balanceStrategy, periodStrategy })
    return {
      token,
      expiresAt: new Date(expiresAt),
      fingerprint,
      ...snapshot,
      summary: renderGuildAliasRemapSummary(snapshot, balanceStrategy, periodStrategy),
    }
  }

  async confirmGuildAliasRemap(token: string, actor: ProfileDeletionActor) {
    const stored = this.guildAliasTokens.get(token)
    if (!stored) throw new XpPointsUserError('群挂靠确认令牌不存在或已经使用，请重新预览。')
    if (stored.expiresAt <= Date.now()) {
      this.guildAliasTokens.delete(token)
      throw new XpPointsUserError('群挂靠确认令牌已过期，请重新预览。')
    }
    if (stored.actorKey !== deletionActorKey(actor)) throw new XpPointsUserError('确认令牌不属于当前管理员、机器人或会话。')
    let result!: Awaited<ReturnType<typeof buildGuildAliasRemapSnapshot>>
    await this.serializeMutation(() => this.ctx.database.transact(async database => {
      await this.requireDeletionAuthority(database, actor)
      if (stored.expiresAt <= Date.now()) throw new XpPointsUserError('群挂靠确认令牌已过期，请重新预览。')
      const current = await buildGuildAliasRemapSnapshot(database, this.config.scoreGuildAliases ?? {}, stored.balanceStrategy, stored.periodStrategy)
      const fingerprint = createHash('sha256').update(stableJson(current)).digest('hex')
      if (fingerprint !== stored.fingerprint) throw new XpPointsUserError('群挂靠配置、余额或周期成绩已经变化，请重新预览。')
      if (current.alreadyRemapped) throw new XpPointsUserError('群挂靠配置已经应用，无需重映射。')
      await applyGuildAliasRemapSnapshot(database, current, actor)
      result = current
    }))
    this.guildAliasTokens.delete(token)
    this.scoreLoaded = false
    await this.ensureScoreLedgerLoaded()
    return { ...result, executed: true, summary: renderGuildAliasRemapSummary(result, stored.balanceStrategy, stored.periodStrategy) }
  }

  private async ensureScoreLedgerLoaded(): Promise<void> {
    await this.ensureAccountStorage()
    if (this.scoreLoaded) return
    if (this.scoreLoading) return this.scoreLoading
    this.scoreLoading = this.initializeScoreLedger().finally(() => { this.scoreLoading = undefined })
    return this.scoreLoading
  }

  private async initializeScoreLedger(): Promise<void> {
    for (const definition of this.scoreDefinitions.values()) {
      await this.ensureRegisteredScoreSystem(definition)
    }
    await this.reconcileScoreAliases()
    await this.serializeMutation(() => this.ctx.database.transact(async db => {
      const systems = await db.get('xp_score_system', {})
      for (const system of systems) await configurePeriodsIn(db, system.key, this.config.scorePeriods?.[system.key])
    }))
    this.scoreLoaded = true
  }

  private async ensureRegisteredScoreSystem(definition: ScoreSystemDefinition): Promise<void> {
    const normalized = normalizeSystemDefinition(definition)
    await this.retryConflictingMutation(() => this.serializeMutation(() => this.ctx.database.transact(async database => {
      const existing = (await database.get('xp_score_system', { key: normalized.key }))[0]
      if (existing && existing.scope !== normalized.scope) {
        throw new Error(`积分系统 ${normalized.key} 已存在为 ${existing.scope} 作用域，消费方声明为 ${normalized.scope}。`)
      }
      if (!existing) {
        const now = new Date()
        await database.create('xp_score_system', { ...normalized, unit: normalized.unit ?? '分',
          active: true, createdBy: 'consumer-registration', createdAt: now, updatedAt: now })
      }
      await this.lifecycle.initializeSystemIn(database, normalized.key)
    })))
  }

  private async reconcileScoreAliases(): Promise<void> {
    const rows = await this.serializeMutation(() => this.ctx.database.transact(async database => {
    const systems = await database.get('xp_score_system', {})
    const systemMap = new Map(systems.map(system => [system.key, system]))
    const desired = normalizeScoreAliases(this.config.scoreGuildAliases ?? {}, systemMap)
    const applied = await database.get('xp_score_guild_alias', {})
    const appliedMap = new Map(applied.map(row => [scoreAliasKey(row.systemKey, row.platform, row.sourceGuildId), row]))
    const desiredMap = new Map(desired.map(row => [scoreAliasKey(row.systemKey, row.platform, row.sourceGuildId), row]))
    const changedSystems = new Set<string>()
    for (const [key, row] of appliedMap) {
      if (desiredMap.get(key)?.targetGuildId !== row.targetGuildId) changedSystems.add(row.systemKey)
    }
    for (const [key, row] of desiredMap) {
      if (appliedMap.get(key)?.targetGuildId !== row.targetGuildId) changedSystems.add(row.systemKey)
    }
    const pendingSystems = new Set<string>()
    for (const systemKey of changedSystems) {
      const subjects = await database.get('xp_score_subject', { systemKey })
      const balances = subjects.length ? await database.get('xp_subject_balance', { subjectId: subjects.map(row => row.id) }) : []
      const periodScores = subjects.length ? await database.get('xp_period_score', { subjectId: subjects.map(row => row.id) }) : []
      const journals = await database.get('xp_score_journal', { systemKey })
      if (balances.length || journals.length || periodScores.length) {
        pendingSystems.add(systemKey)
        continue
      }
    }
    if (changedSystems.size) {
      for (const systemKey of changedSystems) {
        if (pendingSystems.has(systemKey)) continue
        await database.remove('xp_score_guild_alias', { systemKey })
        const now = new Date()
        const rows = desired.filter(row => row.systemKey === systemKey)
          .map(row => ({ ...row, createdAt: now, updatedAt: now }))
        for (const row of rows) await database.create('xp_score_guild_alias', row)
      }
    }
    if (pendingSystems.size > 0) {
      this.ctx.logger.warn('群挂靠配置存在待应用变更，请管理员使用“积分系统.群挂靠重映射”预览确认；当前继续使用已应用映射。')
    }
    return database.get('xp_score_guild_alias', {})
    }))
    this.scoreAliases.clear()
    for (const row of rows) {
      this.scoreAliases.set(scoreAliasKey(row.systemKey, row.platform, row.sourceGuildId), row.targetGuildId)
    }
  }

  private async serializeMutation<T>(callback: () => Promise<T>): Promise<T> {
    return this.writes.run(callback)
  }

  private async retryConflictingMutation<T>(callback: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await callback()
      } catch (error) {
        if (!isRetryableConflict(error) || attempt === 7) throw error
        await delay(Math.min(250, 20 * 2 ** attempt))
      }
    }
    throw new Error('数据库写入重试次数已耗尽。')
  }

  private async loadCache(): Promise<void> {
    const [profiles, identities, accounts] = await Promise.all([
      this.ctx.database.get('xp_profile', {}),
      this.ctx.database.get('xp_identity', {}),
      this.ctx.database.get('xp_account', {}),
    ])
    const accountMap = new Map(accounts.map(account => [identityKey(account.platform, account.userId), account]))
    const profileMap = new Map(profiles.map(profile => [profile.id, profile]))
    const next = new Map<string, ManagedIdentity>()
    for (const identity of identities) {
      const profile = profileMap.get(identity.profileId)
      if (!profile) continue
      const account = accountMap.get(identityKey(identity.platform, identity.userId))
      if (!account) throw new Error('账号档案不完整：身份没有对应账号。')
      next.set(identityKey(identity.platform, identity.userId), {
        accountId: account.id,
        profileId: profile.id,
        nickname: profile.nickname,
        automatic: profile.automatic,
        platform: identity.platform,
        userId: identity.userId,
      })
    }
    this.identities.clear()
    for (const [key, value] of next) this.identities.set(key, value)
    this.loaded = true
  }

  async getManagedIdentity(platform: string, userId: string): Promise<ManagedIdentity | null> {
    await this.ensureLoaded()
    return this.identities.get(identityKey(platform, userId)) ?? null
  }

  async getManagedNickname(platform: string, userId: string): Promise<string | null> {
    return (await this.getManagedIdentity(platform, userId))?.nickname ?? null
  }

  registerProfileDataConsumer(consumer: ProfileDataConsumer): () => void {
    const name = consumer.name.trim()
    if (!name) throw new Error('档案数据消费方必须提供名称。')
    if (this.deletionConsumers.has(name)) throw new Error('档案数据消费方重复注册：' + name)
    this.deletionConsumers.set(name, consumer)
    return () => {
      if (this.deletionConsumers.get(name) === consumer) this.deletionConsumers.delete(name)
    }
  }

  async previewDeleteIdentity(target: string, actor: ProfileDeletionActor): Promise<ProfileDeletionPreview> {
    const request = { kind: 'identity' as const, target }
    return this.createDeletionPreview(request, actor)
  }

  async previewDeleteProfile(nickname: string, actor: ProfileDeletionActor): Promise<ProfileDeletionPreview> {
    const normalized = nickname.trim()
    if (!normalized) throw new XpPointsUserError('管理昵称不能为空。')
    const request = { kind: 'profile' as const, nickname: normalized }
    return this.createDeletionPreview(request, actor)
  }

  async confirmProfileDeletion(
    token: string,
    actor: ProfileDeletionActor,
  ): Promise<ProfileDeletionResult> {
    const stored = this.deletionTokens.get(token)
    if (!stored) throw new XpPointsUserError('确认令牌不存在或已经使用，请重新预览。')
    if (stored.expiresAt <= Date.now()) {
      this.deletionTokens.delete(token)
      throw new XpPointsUserError('确认令牌已过期，请重新预览。')
    }
    if (stored.actorKey !== deletionActorKey(actor)) {
      throw new XpPointsUserError('确认令牌不属于当前管理员、机器人或会话。')
    }
    // Consume only after ownership and expiry checks. A foreign attempt must not
    // invalidate the administrator's pending destructive action.
    this.deletionTokens.delete(token)
    this.assertRequiredDeletionConsumers()

    let result!: ProfileDeletionResult
    let committedScope!: ProfileDeletionScope
    const consumers = this.sortedDeletionConsumers()
    await this.serializeMutation(() => this.ctx.database.transact(async database => {
      await this.requireDeletionAuthority(database, actor)
      if (stored.expiresAt <= Date.now()) throw new XpPointsUserError('确认令牌已过期，请重新预览。')
      this.assertRequiredDeletionConsumers()
      const built = await this.buildDeletionPreview(database, stored.request)
      if (built.fingerprint !== stored.fingerprint) {
        throw new XpPointsUserError('相关档案数据已经变化，请重新预览后确认。')
      }
      for (const consumer of consumers) {
        await consumer.delete(database, built.scope)
      }
      committedScope = structuredClone(built.scope)
      await this.deleteXpData(database, built.scope)
      result = {
        mode: built.scope.mode,
        rootProfileId: built.scope.rootProfileId,
        deletedIdentities: built.scope.mode === 'identity' ? 1 : built.scope.identities.length,
        deletedProfiles: built.scope.mode === 'profile' ? built.profileRows : 0,
        consumerRows: built.consumerRows,
      }
    }))
    for (const consumer of consumers) {
      if (!consumer.afterDelete) continue
      try { await consumer.afterDelete(committedScope) }
      catch (error) {
        this.ctx.logger.warn('档案已删除，但消费方 %s 的文件清理失败：%s', consumer.name, safeErrorSummary(error))
        ;(result.warnings ??= []).push(`${consumer.name} 的附属文件清理未完成，请管理员检查日志；数据库删除已提交，不要重复删档。`)
      }
    }
    await this.reload()
    return result
  }

  private async createDeletionPreview(
    request: StoredDeletionToken['request'],
    actor: ProfileDeletionActor,
  ): Promise<ProfileDeletionPreview> {
    await this.ensureAccountStorage()
    this.assertRequiredDeletionConsumers()
    for (const [token, stored] of this.deletionTokens) {
      if (stored.expiresAt <= Date.now()) this.deletionTokens.delete(token)
    }
    const built = await this.serializeMutation(() => this.ctx.database.transact(async database => {
      await this.requireDeletionAuthority(database, actor)
      return this.buildDeletionPreview(database, request)
    }))
    const token = 'XPDEL-' + randomBytes(12).toString('base64url')
    const expiresAt = Date.now() + 5 * 60_000
    this.deletionTokens.set(token, {
      actorKey: deletionActorKey(actor),
      expiresAt,
      request,
      fingerprint: built.fingerprint,
    })
    return {
      token,
      expiresAt: new Date(expiresAt),
      mode: built.scope.mode,
      summary: built.summary,
    }
  }

  private assertRequiredDeletionConsumers(): void {
    const missing = (this.config.requiredDeletionConsumers ?? [])
      .filter(name => !this.deletionConsumers.has(name))
    if (missing.length) {
      throw new XpPointsUserError('必需的档案删除消费方尚未加载：' + missing.join('、'))
    }
  }

  private async requireDeletionAuthority(database: Context['database'], actor: ProfileDeletionActor): Promise<void> {
    if (await requireAccountAuthority(database, actor) < 5) throw new XpPointsUserError('删除数据需要权限 5。')
  }

  private sortedDeletionConsumers(): ProfileDataConsumer[] {
    return [...this.deletionConsumers.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  private async buildDeletionPreview(
    database: Context['database'],
    request: StoredDeletionToken['request'],
  ): Promise<BuiltDeletionPreview> {
    const scope = await this.buildDeletionScope(database, request)
    const ownSnapshot = await this.xpDeletionSnapshot(database, scope)
    this.accountOperations.assertMutable({ profileIds: scope.profileIds, accountIds: ownSnapshot.accounts.map(row => row.id) })
    const consumerSnapshots: Array<{ name: string, preview: ProfileDataConsumerPreview }> = []
    for (const consumer of this.sortedDeletionConsumers()) {
      consumerSnapshots.push({ name: consumer.name, preview: await consumer.preview(database, scope) })
    }
    const consumerRows = consumerSnapshots.reduce((sum, item) => sum + item.preview.affectedRows, 0)
    const summary = [
      scope.mode === 'identity'
        ? `删除账号 ${scope.targetIdentity!.platform}:${scope.targetIdentity!.userId}；共享档案和积分保留，该账号的独立积分和个人明细删除。`
        : `删除整个档案 #${scope.rootProfileId}，涉及 ${scope.identities.length} 个账号。`,
      `xp 数据：${ownSnapshot.scores.length} 条余额、${ownSnapshot.journals.length} 条积分日志、` +
        `${ownSnapshot.presences.length} 条群状态、${ownSnapshot.merges.length} 条合并记录。`,
      `将删除 ${ownSnapshot.accounts.length} 个账号记录、${ownSnapshot.subjects.length} 个计分主体及 ${ownSnapshot.operations.length} 条操作明细。仅保留不可反查账号的防重复操作标记；旧操作重试将拒绝。`,
      ...consumerSnapshots.flatMap(item => item.preview.summary.map(line => `${item.name}：${line}`)),
    ]
    const fingerprint = createHash('sha256').update(stableJson({
      scope,
      ownSnapshot,
      consumers: consumerSnapshots.map(item => ({
        name: item.name,
        affectedRows: item.preview.affectedRows,
        snapshot: item.preview.snapshot,
      })),
    })).digest('hex')
    return { scope, fingerprint, summary, consumerRows, profileRows: ownSnapshot.profiles.length }
  }

  private async buildDeletionScope(
    database: Context['database'],
    request: StoredDeletionToken['request'],
  ): Promise<ProfileDeletionScope> {
    let rootProfileId: number
    let targetIdentity: { platform: string, userId: string } | undefined
    if (request.kind === 'identity') {
      targetIdentity = parseTarget(request.target)
      const identity = (await database.get('xp_identity', targetIdentity))[0]
      if (!identity) throw new XpPointsUserError('没有找到对应的管理账号。')
      rootProfileId = await this.resolveCanonicalProfileIdIn(database, identity.profileId)
    }
    else {
      const profile = await this.profileByNicknameIn(database, request.nickname)
      if (!profile) throw new XpPointsUserError('没有找到对应的管理昵称。')
      rootProfileId = await this.resolveCanonicalProfileIdIn(database, profile.id)
    }

    const profileIds = await this.profileFamilyIds(database, rootProfileId)
    const identities = (await database.get('xp_identity', {}))
      .filter(identity => profileIds.includes(identity.profileId))
      .sort(compareIdentity)
    const mode = request.kind === 'identity' && identities.length > 1 ? 'identity' : 'profile'
    return {
      mode,
      rootProfileId,
      profileIds,
      identities: identities.map(identity => ({
        platform: identity.platform,
        userId: identity.userId,
        profileId: identity.profileId,
      })),
      ...(mode === 'identity' ? { targetIdentity } : {}),
    }
  }

  private async profileFamilyIds(database: Context['database'], rootProfileId: number): Promise<number[]> {
    const merges = await database.get('xp_profile_merge', {})
    const ids = new Set<number>([rootProfileId])
    for (const merge of merges) {
      if (await this.resolveCanonicalProfileIdIn(database, merge.sourceProfileId) === rootProfileId) {
        ids.add(merge.sourceProfileId)
        ids.add(merge.targetProfileId)
      }
    }
    return [...ids].sort((left, right) => left - right)
  }

  private async xpDeletionSnapshot(database: Context['database'], scope: ProfileDeletionScope) {
    return readAccountDeletion(database, scope)
  }

  private async deleteXpData(database: Context['database'], scope: ProfileDeletionScope): Promise<void> {
    await eraseAccountData(database, scope, await readAccountDeletion(database, scope))
  }

  private async profileByNicknameIn(database: Context['database'], nickname: string): Promise<XpProfile | null> {
    return (await database.get('xp_profile', { nickname }))[0] ?? null
  }

  private async profileByNickname(nickname: string): Promise<XpProfile | null> {
    return this.profileByNicknameIn(this.ctx.database, nickname)
  }

  async getProfile(profileId: number): Promise<XpProfile | null> {
    const canonicalId = await this.resolveCanonicalProfileId(profileId)
    return (await this.ctx.database.get('xp_profile', { id: canonicalId }))[0] ?? null
  }

  async inspectManagedProfile(nickname: string): Promise<ManagedProfileInspection> {
    await this.ensureScoreLedgerLoaded()
    const profile = await this.profileByNickname(nickname.trim())
    if (!profile) throw new XpPointsUserError('没有找到对应的管理昵称。')
    const rootProfileId = await this.resolveCanonicalProfileId(profile.id)
    const profileIds = await this.profileFamilyIds(this.ctx.database, rootProfileId)
    const identities = (await this.ctx.database.get('xp_identity', { profileId: profileIds }))
      .sort(compareIdentity)
    const identitySet = new Set(identities.map(identity => identityKey(identity.platform, identity.userId)))
    const presences = (await this.ctx.database.get('xp_guild_presence', {}))
      .filter(row => identitySet.has(identityKey(row.platform, row.userId)))
      .sort(comparePresence)
    const subjects = await this.ctx.database.get('xp_score_subject', { profileId: profileIds, active: true })
    const subjectMap = new Map(subjects.map(row => [row.id, row]))
    const accounts = await this.ctx.database.get('xp_account', {})
    const accountMap = new Map(accounts.map(row => [row.id, row]))
    const rows = subjects.length ? await this.ctx.database.get('xp_subject_balance', { subjectId: subjects.map(row => row.id) }) : []
    const balances = rows.map(row => {
      const subject = subjectMap.get(row.subjectId)!
      return { ...row, systemKey: subject.systemKey, profileId: subject.profileId,
        ...(subject.accountId ? { accountNickname: accountMap.get(subject.accountId)?.nickname ?? '未命名账号' } : {}) }
    }).sort(compareProfileGuildRow)
    return { profile, profileIds, identities, presences, balances }
  }

  async listProfileMerges(): Promise<XpProfileMerge[]> {
    return this.ctx.database.get('xp_profile_merge', {})
  }

  async resolveCanonicalProfileId(profileId: number): Promise<number> {
    return this.resolveCanonicalProfileIdIn(this.ctx.database, profileId)
  }

  private async resolveCanonicalProfileIdIn(database: Context['database'], profileId: number): Promise<number> {
    let current = profileId
    const seen = new Set<number>()
    while (!seen.has(current)) {
      seen.add(current)
      const merge = (await database.get('xp_profile_merge', { sourceProfileId: current }))[0]
      if (!merge) return current
      current = merge.targetProfileId
    }
    throw new Error('档案合并日志存在循环：' + [...seen, current].join(' -> '))
  }


  async ensureManagedIdentity(platform: string, userId: string, suggestedNickname?: string): Promise<ManagedIdentity> {
    await this.ensureScoreLedgerLoaded()
    const result = await this.lifecycle.ensureIdentity({ platform, userId, suggestedNickname })
    await this.reload()
    return { accountId: result.account.id, profileId: result.profile.id, nickname: result.profile.nickname,
      automatic: result.profile.automatic, platform, userId }
  }

  async ensureManagedGuildIdentity(
    platform: string,
    userId: string,
    guildId: string,
    suggestedNickname?: string,
  ): Promise<ManagedIdentity> {
    const identity = await this.ensureManagedIdentity(platform, userId, suggestedNickname)
    await this.markGuildPresence(platform, guildId, userId, 'active', 'guild-activity')
    return identity
  }

  async getGuildPresence(
    platform: string,
    guildId: string,
    userId: string,
  ): Promise<XpGuildPresence | null> {
    return (await this.ctx.database.get('xp_guild_presence', { platform, guildId, userId }))[0] ?? null
  }

  async markGuildPresence(
    platform: string,
    guildId: string,
    userId: string,
    state: XpGuildPresenceState,
    reason: string,
  ): Promise<void> {
    if (!platform || !guildId || !userId) return
    await this.serializeMutation(() => this.ctx.database.transact(async database => {
      await this.setGuildPresenceIn(database, platform, guildId, userId, state, reason, new Date())
    }))
  }

  async scanGuildMembers(
    bot: Pick<Bot, 'getGuildMemberIter'>,
    platform: string,
    guildId: string,
    execute = false,
  ): Promise<GuildMemberScanResult> {
    const memberIds = new Set<string>()
    try {
      for await (const member of bot.getGuildMemberIter(guildId)) {
        const userId = member.user?.id
        if (userId) memberIds.add(userId)
      }
    } catch (error) {
      this.ctx.logger.warn('成员列表读取失败：%s', safeErrorSummary(error))
      throw new XpPointsUserError('成员列表读取失败，未修改任何状态；请稍后重试。')
    }

    const candidates = await this.guildPresenceCandidates(platform, guildId)
    const existing = await this.ctx.database.get('xp_guild_presence', { platform, guildId })
    const existingMap = new Map(existing.map(row => [row.userId, row.state]))
    const changes: GuildMemberScanChange[] = []
    for (const userId of candidates) {
      const next: XpGuildPresenceState = memberIds.has(userId) ? 'active' : 'inactive'
      const previous = existingMap.get(userId) ?? 'unknown'
      if (previous !== next) changes.push({ userId, previous, next })
    }

    if (execute && changes.length) {
      const confirmedAt = new Date()
      await this.serializeMutation(() => this.ctx.database.transact(async database => {
        for (const change of changes) {
          await this.setGuildPresenceIn(
            database,
            platform,
            guildId,
            change.userId,
            change.next,
            'member-scan',
            confirmedAt,
          )
        }
      }))
    }
    return {
      platform,
      guildId,
      memberCount: memberIds.size,
      candidates: candidates.size,
      changes,
      executed: execute,
    }
  }


  /** Deprecated direct rename API: association is never implicit. */
  async setManagedNickname(platform: string, userId: string, rawNickname: string, actor?: AccountActor): Promise<ManagedIdentity> {
    if (!actor) throw new XpPointsUserError('修改管理昵称需要提供实际管理员账号；同名关联请使用确认流程。')
    const identity = await this.ensureManagedIdentity(platform, userId)
    const result = await this.accountOperations.rename(actor, identity.profileId, rawNickname)
    if (result.kind === 'association-required') throw new XpPointsUserError('昵称已属于另一真人，未修改；请私聊使用“关联大小号”预览并确认。')
    await this.reload()
    return (await this.getManagedIdentity(platform, userId))!
  }

  async setManagedNicknameTarget(target: string, nickname: string, actor?: AccountActor): Promise<ManagedIdentity> {
    const { platform, userId } = parseTarget(target)
    return this.setManagedNickname(platform, userId, nickname, actor)
  }

  async getManagedIdentityTarget(target: string): Promise<ManagedIdentity | null> {
    const { platform, userId } = parseTarget(target)
    return this.getManagedIdentity(platform, userId)
  }

  async ensureManagedIdentityTarget(target: string, suggestedNickname?: string): Promise<ManagedIdentity> {
    const { platform, userId } = parseTarget(target)
    return this.ensureManagedIdentity(platform, userId, suggestedNickname)
  }

  async getAccountScore(systemKey: string, target: ScoreAccountTarget, context: Omit<ScoreOperationContext, 'reason'>): Promise<number> {
    await this.requireScoreSystem(systemKey)
    return this.subjectLedger.get(systemKey, target, context)
  }
  async setAccountScore(systemKey: string, target: ScoreAccountTarget, value: number, context: InternalScoreMutationContext): Promise<ScoreMutationResult> {
    await this.ensureScoreLedgerLoaded()
    return this.subjectLedger.set(systemKey, target, value, context)
  }
  async addAccountScore(systemKey: string, target: ScoreAccountTarget, amount: number, context: InternalScoreMutationContext): Promise<ScoreMutationResult> {
    await this.ensureScoreLedgerLoaded()
    return this.subjectLedger.add(systemKey, target, amount, context)
  }

  private async resolveScorePool(
    systemKey: string,
    context: Pick<ScoreOperationContext, 'platform' | 'guildId'>,
  ): Promise<ResolvedScorePool> {
    const system = await this.requireScoreSystem(systemKey)
    const originPlatform = context.platform?.trim() ?? ''
    const originGuildId = context.guildId?.trim() ?? ''
    if (system.scope === 'global') {
      return { system, platform: '', guildId: '', originPlatform, originGuildId }
    }
    if (!originPlatform) throw new XpPointsUserError(`积分系统 ${system.key} 需要提供平台。`)
    if (system.scope === 'platform') {
      return { system, platform: originPlatform, guildId: '', originPlatform, originGuildId }
    }
    if (!originGuildId) throw new XpPointsUserError(`积分系统 ${system.key} 需要在群聊中使用。`)
    return {
      system,
      platform: originPlatform,
      guildId: this.resolveScoreGuildSync(system.key, originPlatform, originGuildId),
      originPlatform,
      originGuildId,
    }
  }

  async getScoreLeaderboard(systemKey: string, context: Omit<ScoreOperationContext, 'reason'>): Promise<ScoreLeaderboardEntry[]> {
    await this.requireScoreSystem(systemKey)
    const rows = await this.accountQueries.leaderboardEntries(systemKey, context,
      { inactivePolicy: this.config.leaderboardInactivePolicy })
    return rows.map(({ profileId, nickname, value, inactive }) => ({ profileId, nickname, value,
      ...(inactive ? { inactive } : {}) }))
  }
  async getScoreLeaderboardPage(systemKey: string, context: Omit<ScoreOperationContext, 'reason'>,
    options: { page?: number, pageSize?: number } = {}): Promise<ScoreLeaderboardPage> {
    await this.requireScoreSystem(systemKey)
    return this.accountQueries.leaderboard(systemKey, context, { ...options,
      pageSize: options.pageSize ?? this.config.leaderboardPageSize ?? 50, inactivePolicy: this.config.leaderboardInactivePolicy })
  }

  async getPeriodLeaderboard(systemKey: string, context: Omit<ScoreOperationContext, 'reason'>,
    options: { kind: ScorePeriodKind; at?: number; season?: string; page?: number; pageSize?: number }) {
    await this.requireScoreSystem(systemKey)
    const page = options.page ?? 1, pageSize = options.pageSize ?? this.config.leaderboardPageSize ?? 50
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new XpPointsUserError('周期榜页码或每页条数无效。')
    const at = options.at ?? Date.now()
    if (!Number.isFinite(at) || at > Date.now()) throw new XpPointsUserError('只能查询当前或过去的周期成绩。')
    const period = await this.serializeMutation(() => this.ctx.database.transact(async db => {
      await db.get('xp_period_policy', { systemKey })
      if (options.season) {
        if (options.kind !== 'season') throw new XpPointsUserError('赛季编号仅用于赛季榜。')
        return (await db.get('xp_period_definition', { systemKey, kind: 'season', label: options.season }, { sort: { start: 'desc' }, limit: 1 }))[0]
      }
      return resolvePeriodIn(db, systemKey, options.kind, at)
    }))
    const entries = period ? await this.accountQueries.leaderboardEntries(systemKey, context,
      { inactivePolicy: this.config.leaderboardInactivePolicy, periodId: period.id }) : []
    let rank = 0
    const ranked = entries.map((row, index) => { if (!index || row.value !== entries[index - 1].value) rank = index + 1; return { ...row, rank } })
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize))
    if (page > totalPages) throw new XpPointsUserError(`周期榜只有${totalPages}页。`)
    return { period, entries: ranked.slice((page - 1) * pageSize, page * pageSize), total: entries.length, page, pageSize, totalPages }
  }
  async getPeriodDefinition(systemKey: string, options: { kind: ScorePeriodKind; at?: number; season?: string }): Promise<PeriodDefinition | undefined> {
    await this.requireScoreSystem(systemKey, true)
    const at = options.at ?? Date.now()
    if (!Number.isFinite(at) || at > Date.now()) throw new XpPointsUserError('只能查询当前或过去的周期。')
    return this.serializeMutation(() => this.ctx.database.transact(async db => {
      if (options.season) {
        if (options.kind !== 'season') throw new XpPointsUserError('赛季编号仅用于赛季详情。')
        return (await db.get('xp_period_definition', { systemKey, kind: 'season', label: options.season },
          { sort: { start: 'desc' }, limit: 1 }))[0]
      }
      return resolvePeriodIn(db, systemKey, options.kind, at)
    }))
  }
  async parseScoreDate(systemKey: string, value: string) {
    await this.requireScoreSystem(systemKey)
    return periodDateIn(this.ctx.database, systemKey, value)
  }

  async getScoreJournalPage(
    systemKey: string,
    options: { page?: number, pageSize?: number } = {},
  ): Promise<ScoreJournalPage> {
    const system = await this.requireScoreSystem(systemKey, true)
    const page = normalizePositiveInteger(options.page ?? 1, '页码')
    const pageSize = normalizeBoundedInteger(
      options.pageSize ?? this.config.leaderboardPageSize ?? 50,
      10,
      200,
      '日志每页条数',
    )
    const query = { systemKey: system.key }
    const total = await this.ctx.database.eval('xp_score_journal', row => $.count(row.id), query)
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    if (page > totalPages) throw new XpPointsUserError(`积分日志只有 ${totalPages} 页。`)
    const entries = await this.ctx.database.select('xp_score_journal')
      .where(query)
      .orderBy('id', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute() as XpScoreJournal[]
    return { entries, page, pageSize, total, totalPages }
  }


  private async authoritiesForIdentities(identities: XpIdentity[]): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    const platforms = [...new Set(identities.map(identity => identity.platform))]
    for (const platform of platforms) {
      const scoped = identities.filter(identity => identity.platform === platform)
      const userIds = new Set(scoped.map(identity => identity.userId))
      const bindings = await this.ctx.database.get('binding', { platform, pid: [...userIds] })
      if (!bindings.length) continue
      const users = await this.ctx.database.get('user', {
        id: [...new Set(bindings.map(binding => binding.aid))],
      })
      const authorityByAid = new Map(users.map(user => [user.id, user.authority]))
      for (const binding of bindings) {
        const authority = authorityByAid.get(binding.aid)
        if (authority != null) result.set(identityKey(platform, binding.pid), authority)
      }
    }
    return result
  }

  private async setGuildPresenceIn(
    database: Context['database'],
    platform: string,
    guildId: string,
    userId: string,
    state: XpGuildPresenceState,
    reason: string,
    confirmedAt: Date,
  ): Promise<void> {
    const query = { platform, guildId, userId }
    const current = (await database.get('xp_guild_presence', query))[0]
    if (current) {
      await database.set('xp_guild_presence', query, {
        state,
        reason,
        lastConfirmedAt: confirmedAt,
        inactiveAt: state === 'inactive' ? (current.inactiveAt ?? confirmedAt) : null,
      })
      return
    }
    await database.create('xp_guild_presence', {
      ...query,
      state,
      reason,
      firstConfirmedAt: confirmedAt,
      lastConfirmedAt: confirmedAt,
      inactiveAt: state === 'inactive' ? confirmedAt : null,
    })
  }

  private async guildPresenceCandidates(platform: string, guildId: string): Promise<Set<string>> {
    await this.ensureScoreLedgerLoaded()
    const systems = (await this.ctx.database.get('xp_score_system', {}))
      .filter(system => system.scope === 'guild')
    const profileIds = new Set<number>()
    for (const system of systems) {
      const scores = await this.ctx.database.get('xp_subject_balance', {
        platform,
        guildId: this.resolveScoreGuildSync(system.key, platform, guildId),
      })
      if (!scores.length) continue
      const subjects = await this.ctx.database.get('xp_score_subject', {
        id: scores.map(row => row.subjectId), systemKey: system.key, active: true,
      })
      for (const subject of subjects) profileIds.add(subject.profileId)
    }
    const [identities, existing] = await Promise.all([
      this.ctx.database.get('xp_identity', { platform }),
      this.ctx.database.get('xp_guild_presence', { platform, guildId }),
    ])
    return new Set([
      ...identities.filter(identity => profileIds.has(identity.profileId)).map(identity => identity.userId),
      ...existing.map(row => row.userId),
    ])
  }
}

function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new XpPointsUserError(`${name}必须是正整数。`)
  return value
}

function normalizeBoundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  const normalized = normalizePositiveInteger(value, name)
  if (normalized < minimum || normalized > maximum) {
    throw new XpPointsUserError(`${name}必须在 ${minimum} 到 ${maximum} 之间。`)
  }
  return normalized
}

function deletionActorKey(actor: ProfileDeletionActor): string {
  return [actor.platform, actor.userId, actor.selfId, actor.channelId].join('\0')
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Date) return item.toISOString()
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
  })
}

function compareIdentity(
  left: Pick<XpIdentity, 'platform' | 'userId'>,
  right: Pick<XpIdentity, 'platform' | 'userId'>,
): number {
  return left.platform.localeCompare(right.platform) || left.userId.localeCompare(right.userId)
}

function compareProfileGuildRow(
  left: { profileId: number, platform: string, guildId: string, systemKey?: string },
  right: { profileId: number, platform: string, guildId: string, systemKey?: string },
): number {
  return left.profileId - right.profileId
    || (left.systemKey ?? '').localeCompare(right.systemKey ?? '')
    || left.platform.localeCompare(right.platform)
    || left.guildId.localeCompare(right.guildId)
}

function comparePresence(
  left: Pick<XpGuildPresence, 'platform' | 'guildId' | 'userId'>,
  right: Pick<XpGuildPresence, 'platform' | 'guildId' | 'userId'>,
): number {
  return left.platform.localeCompare(right.platform)
    || left.guildId.localeCompare(right.guildId)
    || left.userId.localeCompare(right.userId)
}

function normalizeSystemKey(value: string): string {
  const key = value?.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) {
    throw new XpPointsUserError('积分系统 key 仅允许小写字母、数字、点、下划线和连字符，最长 64 位。')
  }
  return key
}

function normalizeSystemName(value: string): string {
  const name = value?.trim()
  if (!name) throw new XpPointsUserError('积分系统名称不能为空。')
  if (name.length > 100) throw new XpPointsUserError('积分系统名称不能超过 100 个字符。')
  return name
}

function normalizeScoreUnit(value: string | undefined): string {
  const unit = value?.trim() || '分'
  if (unit.length > 32) throw new XpPointsUserError('积分单位不能超过 32 个字符。')
  return unit
}

function normalizeSystemDefinition(definition: ScoreSystemDefinition): ScoreSystemDefinition {
  const scope = definition.scope
  if (!(['global', 'platform', 'guild'] as XpScoreScope[]).includes(scope)) {
    throw new XpPointsUserError('积分系统作用域必须是 global、platform 或 guild。')
  }
  return {
    key: normalizeSystemKey(definition.key),
    name: normalizeSystemName(definition.name),
    unit: normalizeScoreUnit(definition.unit),
    scope,
  }
}

function scoreAliasKey(systemKey: string, platform: string, guildId: string): string {
  return [systemKey, platform, guildId].join('\0')
}

function normalizeScoreAliases(
  config: ScoreGuildAliases,
  systems: Map<string, XpScoreSystem>,
): Array<Pick<XpScoreGuildAlias, 'systemKey' | 'platform' | 'sourceGuildId' | 'targetGuildId'>> {
  const rows: Array<Pick<XpScoreGuildAlias, 'systemKey' | 'platform' | 'sourceGuildId' | 'targetGuildId'>> = []
  for (const [rawSystemKey, platforms] of Object.entries(config)) {
    const systemKey = normalizeSystemKey(rawSystemKey)
    const system = systems.get(systemKey)
    if (!system) throw new Error(`群挂靠引用了不存在的积分系统 ${systemKey}。`)
    if (system.scope !== 'guild') throw new Error(`只有 guild 作用域积分系统可以设置群挂靠：${systemKey}。`)
    for (const [rawPlatform, aliases] of Object.entries(platforms ?? {})) {
      const platform = rawPlatform.trim()
      if (!platform) throw new Error(`积分系统 ${systemKey} 的群挂靠平台不能为空。`)
      const sources = new Set(Object.keys(aliases ?? {}).map(value => value.trim()))
      for (const [rawSource, rawTarget] of Object.entries(aliases ?? {})) {
        const sourceGuildId = rawSource.trim()
        const targetGuildId = rawTarget.trim()
        if (!sourceGuildId || !targetGuildId) throw new Error(`积分系统 ${systemKey} 的群挂靠群号不能为空。`)
        if (sourceGuildId === targetGuildId) throw new Error(`积分系统 ${systemKey} 不允许群号挂靠自身：${sourceGuildId}。`)
        if (sources.has(targetGuildId)) {
          throw new Error(`积分系统 ${systemKey} 的群挂靠不允许链式或循环映射：${sourceGuildId} → ${targetGuildId}。`)
        }
        rows.push({ systemKey, platform, sourceGuildId, targetGuildId })
      }
    }
  }
  return rows.sort((left, right) => left.systemKey.localeCompare(right.systemKey)
    || left.platform.localeCompare(right.platform)
    || left.sourceGuildId.localeCompare(right.sourceGuildId))
}

type AliasDatabase = Context['database']
type AliasComponent = {
  targetGuildId: string
  sourceGuildId: string
  value: number
  kind?: 'source' | 'baseline' | 'adjustment' | 'override'
}
type AliasBalancePlan = {
  systemKey: string
  subjectId: string
  profileId: number
  platform: string
  current: Array<{ guildId: string, value: number }>
  next: Array<{ guildId: string, value: number }>
  components: Array<AliasComponent>
}
type AliasPeriodPlan = {
  periodId: string
  systemKey: string
  subjectId: string
  platform: string
  current: Array<{ guildId: string, value: number }>
  next: Array<{ guildId: string, value: number }>
  components: Array<AliasComponent>
}
type GuildAliasRemapSnapshot = {
  balanceStrategy: GuildAliasCombineStrategy
  periodStrategy: GuildAliasCombineStrategy
  desired: Array<Pick<XpScoreGuildAlias, 'systemKey' | 'platform' | 'sourceGuildId' | 'targetGuildId'>>
  changes: Array<{ systemKey: string, platform: string, sourceGuildId: string, oldTargetGuildId: string, newTargetGuildId: string }>
  balancePlans: AliasBalancePlan[]
  periodPlans: AliasPeriodPlan[]
  baselineRows: number
  affectedSystems: string[]
  affectedPools: string[]
  alreadyRemapped: boolean
}

function scoreAliasPolicyKey(systemKey: string, platform: string): string {
  return systemKey + '\0' + platform
}

function aliasMap(rows: Array<Pick<XpScoreGuildAlias, 'systemKey' | 'platform' | 'sourceGuildId' | 'targetGuildId'>>) {
  return new Map(rows.map(row => [scoreAliasKey(row.systemKey, row.platform, row.sourceGuildId), row.targetGuildId]))
}

function aliasChangeKey(systemKey: string, platform: string, sourceGuildId: string): string {
  return scoreAliasKey(systemKey, platform, sourceGuildId)
}

function remapComponentTarget(
  component: AliasComponent,
  systemKey: string,
  platform: string,
  desired: Map<string, string>,
  changes: GuildAliasRemapSnapshot['changes'],
): string {
  if (component.kind !== 'adjustment' && component.kind !== 'baseline'
    && !component.sourceGuildId.startsWith('__')) {
    return desired.get(aliasChangeKey(systemKey, platform, component.sourceGuildId)) ?? component.sourceGuildId
  }
  const moved = changes.filter(change => change.systemKey === systemKey && change.platform === platform
    && change.oldTargetGuildId === component.targetGuildId)
  const destinations = [...new Set(moved.map(change => change.newTargetGuildId))]
  return destinations.length === 1 ? destinations[0] : component.targetGuildId
}

function mergeAliasComponents(rows: AliasComponent[]): AliasComponent[] {
  const merged = new Map<string, AliasComponent>()
  for (const row of rows) {
    if (!Number.isFinite(row.value)) throw new XpPointsUserError('群挂靠组件包含非有限数值，操作已取消。')
    const key = [row.targetGuildId, row.sourceGuildId].join('\0')
    const old = merged.get(key)
    if (old) old.value += row.value
    else merged.set(key, { ...row, kind: row.kind ?? 'source' })
  }
  for (const row of merged.values()) if (!Number.isFinite(row.value)) throw new XpPointsUserError('群挂靠组件合并结果超出有限数值范围，操作已取消。')
  return [...merged.values()].filter(row => row.value !== 0).sort((left, right) => left.targetGuildId.localeCompare(right.targetGuildId)
    || left.sourceGuildId.localeCompare(right.sourceGuildId))
}

/**
 * A target-level adjustment bridges source detail to the visible balance under
 * the policy that was active when the detail was written.  If an administrator
 * changes only the combine strategy, carrying that old bridge forward would
 * count the same balance twice (for example, max-source detail plus a sum
 * adjustment).  Rebase the bridge against the new strategy while preserving
 * the currently visible target value.
 */
function rebaseStrategyOnlyComponents(
  rows: AliasComponent[],
  targetGuildId: string,
  currentValue: number,
  strategy: GuildAliasCombineStrategy,
): AliasComponent[] {
  const base = rows.filter(row => row.kind !== 'adjustment' && row.kind !== 'override')
  const otherAdjustments = rows.filter(row => row.kind === 'adjustment' && row.sourceGuildId !== TARGET_ADJUSTMENT_SOURCE)
  const adjustmentTotal = otherAdjustments.reduce((sum, row) => sum + row.value, 0)
  const required = currentValue - aggregateGuildComponents(base, strategy) - adjustmentTotal
  if (!Number.isFinite(required)) throw new XpPointsUserError('群挂靠策略调整结果超出有限数值范围，操作已取消。')
  return [
    ...base,
    ...otherAdjustments,
    ...(required === 0 ? [] : [{ targetGuildId, sourceGuildId: TARGET_ADJUSTMENT_SOURCE, value: required, kind: 'adjustment' as const }]),
  ]
}

async function buildGuildAliasRemapSnapshot(
  database: AliasDatabase,
  rawConfig: ScoreGuildAliases,
  balanceStrategy: GuildAliasCombineStrategy,
  periodStrategy: GuildAliasCombineStrategy,
): Promise<GuildAliasRemapSnapshot> {
  const systems = new Map((await database.get('xp_score_system', {})).map(system => [system.key, system]))
  const desired = normalizeScoreAliases(rawConfig, systems)
  const appliedRows = await database.get('xp_score_guild_alias', {})
  const applied = aliasMap(appliedRows)
  const desiredMap = aliasMap(desired)
  const allKeys = [...new Set([...applied.keys(), ...desiredMap.keys()])].sort()
  const changes: GuildAliasRemapSnapshot['changes'] = []
  for (const key of allKeys) {
    const [systemKey, platform, sourceGuildId] = key.split('\0')
    const oldTargetGuildId = applied.get(key) ?? sourceGuildId
    const newTargetGuildId = desiredMap.get(key) ?? sourceGuildId
    if (oldTargetGuildId !== newTargetGuildId) changes.push({ systemKey, platform, sourceGuildId, oldTargetGuildId, newTargetGuildId })
  }
  const strategyChanges: Array<{ systemKey: string, platform: string }> = []
  const allPlatforms = new Set<string>()
  for (const row of appliedRows) allPlatforms.add(scoreAliasPolicyKey(row.systemKey, row.platform))
  for (const row of desired) allPlatforms.add(scoreAliasPolicyKey(row.systemKey, row.platform))
  const aliasPolicies = new Map((await database.get('xp_score_guild_alias_policy', {})).map(row => [scoreAliasPolicyKey(row.systemKey, row.platform), row]))
  for (const key of allPlatforms) {
    const [systemKey, platform] = key.split('\0')
    const current = aliasPolicies.get(key)
    const old = normalizeGuildAliasPolicy({ balance: current?.balanceStrategy, period: current?.periodStrategy })
    if (old.balance !== balanceStrategy || old.period !== periodStrategy) strategyChanges.push({ systemKey, platform })
  }
  const affectedPairs = new Set<string>([
    ...changes.map(change => scoreAliasPolicyKey(change.systemKey, change.platform)),
    ...strategyChanges.map(change => scoreAliasPolicyKey(change.systemKey, change.platform)),
  ])
  const affectedSystems = [...new Set([...changes, ...strategyChanges].map(row => row.systemKey))].sort()
  const affectedPools = [...affectedPairs].sort()
  const balancePlans: AliasBalancePlan[] = []
  let baselineRows = 0
  for (const pair of affectedPairs) {
    const [systemKey, platform] = pair.split('\0')
    const system = systems.get(systemKey)
    if (!system || system.scope !== 'guild') continue
    const subjects = await database.get('xp_score_subject', { systemKey, active: true })
    const balances = await database.get('xp_subject_balance', { subjectId: subjects.map(subject => subject.id), platform })
    const components = await database.get('xp_score_guild_component', { systemKey, subjectId: subjects.map(subject => subject.id), platform }) as Array<AliasComponent & { subjectId: string }>
    const policy = await getGuildAliasPolicyIn(database, systemKey, platform)
    const pairChanges = changes.filter(change => change.systemKey === systemKey && change.platform === platform)
    const strategyOnly = policy.balance !== balanceStrategy && pairChanges.length === 0
    const bySubject = new Map<string, AliasComponent[]>()
    for (const row of components) (bySubject.get(row.subjectId) ?? bySubject.set(row.subjectId, []).get(row.subjectId)!).push(row)
    for (const subject of subjects) {
      const subjectBalances = balances.filter(row => row.subjectId === subject.id)
      const subjectComponents = bySubject.get(subject.id) ?? []
      if (!subjectBalances.length && !subjectComponents.length) continue
      const currentByTarget = new Map(subjectBalances.map(row => [row.guildId, row.value]))
      const grouped = new Map<string, AliasComponent[]>()
      const push = (row: AliasComponent) => (grouped.get(row.targetGuildId) ?? grouped.set(row.targetGuildId, []).get(row.targetGuildId)!).push(row)
      for (const row of subjectComponents) push({ targetGuildId: row.targetGuildId, sourceGuildId: row.sourceGuildId, value: row.value, kind: row.kind })
      for (const row of subjectBalances) {
        const existing = subjectComponents.filter(component => component.targetGuildId === row.guildId)
        if (!existing.length) {
          baselineRows++
          push({ targetGuildId: row.guildId, sourceGuildId: BASELINE_SOURCE, value: row.value, kind: 'baseline' })
        } else {
          const aggregate = aggregateGuildComponents(existing, policy.balance)
          const difference = row.value - aggregate
          if (!Number.isFinite(difference)) throw new XpPointsUserError('群挂靠基线差额超出有限数值范围，操作已取消。')
          if (difference !== 0) {
            baselineRows++
            push({ targetGuildId: row.guildId, sourceGuildId: TARGET_ADJUSTMENT_SOURCE, value: difference, kind: 'adjustment' })
          }
        }
      }
      let remapped: AliasComponent[] = []
      for (const rows of grouped.values()) {
        const mapped = rows.map(row => ({ ...row,
          targetGuildId: remapComponentTarget(row, systemKey, platform, desiredMap, changes) }))
        if (strategyOnly && currentByTarget.has(rows[0].targetGuildId)) {
          remapped.push(...rebaseStrategyOnlyComponents(mapped, mapped[0].targetGuildId,
            currentByTarget.get(rows[0].targetGuildId)!, balanceStrategy))
        } else remapped.push(...mapped)
      }
      // A target-level correction was only needed to make a maximum-merged
      // pool match its visible aggregate. When that pool is split into more
      // than one destination, source components already contain the known
      // values; carrying the correction to every branch would duplicate it.
      const splitMappedAdjustments = new Set<string>()
      for (const rows of grouped.values()) {
        const adjustments = rows.filter(row => row.kind === 'adjustment' && row.sourceGuildId === TARGET_ADJUSTMENT_SOURCE)
        if (!adjustments.length) continue
        const destinations = new Set(rows.filter(row => row.kind !== 'adjustment' && row.kind !== 'baseline')
          .map(row => remapComponentTarget(row, systemKey, platform, desiredMap, changes)))
        if (destinations.size > 1) for (const row of adjustments) {
          splitMappedAdjustments.add(remapComponentTarget(row, systemKey, platform, desiredMap, changes))
        }
      }
      const filteredRemapped = remapped.filter(row => !(row.kind === 'adjustment'
        && row.sourceGuildId === TARGET_ADJUSTMENT_SOURCE
        && splitMappedAdjustments.has(row.targetGuildId)))
      const merged = mergeAliasComponents(filteredRemapped)
      const nextByTarget = new Map<string, number>()
      for (const target of [...new Set(merged.map(row => row.targetGuildId))]) {
        const targetRows = merged.filter(row => row.targetGuildId === target)
        const value = aggregateGuildComponents(targetRows, balanceStrategy)
        if (value !== 0) nextByTarget.set(target, value)
      }
      const current = [...currentByTarget.entries()].map(([guildId, value]) => ({ guildId, value })).sort((a, b) => a.guildId.localeCompare(b.guildId))
      const next = [...nextByTarget.entries()].map(([guildId, value]) => ({ guildId, value })).sort((a, b) => a.guildId.localeCompare(b.guildId))
      if (JSON.stringify(current) !== JSON.stringify(next) || JSON.stringify(merged) !== JSON.stringify(subjectComponents)) {
        balancePlans.push({ systemKey, subjectId: subject.id, profileId: subject.profileId, platform, current, next, components: merged })
      }
    }
  }
  const periodPlans: AliasPeriodPlan[] = []
  const periods = await database.get('xp_period_definition', { systemKey: affectedSystems })
  for (const pair of affectedPairs) {
    const [systemKey, platform] = pair.split('\0')
    const system = systems.get(systemKey)
    if (!system || system.scope !== 'guild') continue
    const subjectIds = (await database.get('xp_score_subject', { systemKey, active: true })).map(subject => subject.id)
    const scores = await database.get('xp_period_score', { periodId: periods.filter(period => period.systemKey === systemKey).map(period => period.id), subjectId: subjectIds, platform })
    const components = await database.get('xp_period_guild_component', { periodId: periods.filter(period => period.systemKey === systemKey).map(period => period.id), subjectId: subjectIds, platform }) as Array<AliasComponent & { periodId: string, subjectId: string }>
    const policy = await getGuildAliasPolicyIn(database, systemKey, platform)
    const pairChanges = changes.filter(change => change.systemKey === systemKey && change.platform === platform)
    const strategyOnly = policy.period !== periodStrategy && pairChanges.length === 0
    for (const period of periods.filter(row => row.systemKey === systemKey)) {
      const periodScores = scores.filter(row => row.periodId === period.id)
      const periodComponents = components.filter(row => row.periodId === period.id)
      const subjectIdsForPeriod = new Set([...periodScores.map(row => row.subjectId), ...periodComponents.map(row => row.subjectId)])
      for (const subjectId of subjectIdsForPeriod) {
        const currentRows = periodScores.filter(row => row.subjectId === subjectId)
        const sourceRows = periodComponents.filter(row => row.subjectId === subjectId)
        const grouped = new Map<string, AliasComponent[]>()
        const push = (row: AliasComponent) => (grouped.get(row.targetGuildId) ?? grouped.set(row.targetGuildId, []).get(row.targetGuildId)!).push(row)
        for (const row of sourceRows) push({ targetGuildId: row.targetGuildId, sourceGuildId: row.sourceGuildId, value: row.value, kind: row.kind })
        for (const row of currentRows) {
          const existing = sourceRows.filter(component => component.targetGuildId === row.guildId)
          if (!existing.length) { baselineRows++; push({ targetGuildId: row.guildId, sourceGuildId: BASELINE_SOURCE, value: row.value, kind: 'baseline' }) }
          else {
            const aggregate = aggregateGuildComponents(existing, policy.period)
            const difference = row.value - aggregate
            if (!Number.isFinite(difference)) throw new XpPointsUserError('周期成绩基线差额超出有限数值范围，操作已取消。')
            if (difference !== 0) { baselineRows++; push({ targetGuildId: row.guildId, sourceGuildId: TARGET_ADJUSTMENT_SOURCE, value: difference, kind: 'adjustment' }) }
          }
        }
        let remapped: AliasComponent[] = []
        for (const rows of grouped.values()) {
          const mapped = rows.map(row => ({ ...row,
            targetGuildId: remapComponentTarget(row, systemKey, platform, desiredMap, changes) }))
          const currentValue = currentRows.find(row => row.guildId === rows[0].targetGuildId)?.value
          if (strategyOnly && currentValue !== undefined) {
            remapped.push(...rebaseStrategyOnlyComponents(mapped, mapped[0].targetGuildId, currentValue, periodStrategy))
          } else remapped.push(...mapped)
        }
        const splitMappedAdjustments = new Set<string>()
        for (const rows of grouped.values()) {
          const adjustments = rows.filter(row => row.kind === 'adjustment' && row.sourceGuildId === TARGET_ADJUSTMENT_SOURCE)
          if (!adjustments.length) continue
          const destinations = new Set(rows.filter(row => row.kind !== 'adjustment' && row.kind !== 'baseline')
            .map(row => remapComponentTarget(row, systemKey, platform, desiredMap, changes)))
          if (destinations.size > 1) for (const row of adjustments) {
            splitMappedAdjustments.add(remapComponentTarget(row, systemKey, platform, desiredMap, changes))
          }
        }
        const filteredRemapped = remapped.filter(row => !(row.kind === 'adjustment'
          && row.sourceGuildId === TARGET_ADJUSTMENT_SOURCE
          && splitMappedAdjustments.has(row.targetGuildId)))
        const merged = mergeAliasComponents(filteredRemapped)
        const nextByTarget = new Map<string, number>()
        for (const target of [...new Set(merged.map(row => row.targetGuildId))]) {
          const value = aggregateGuildComponents(merged.filter(row => row.targetGuildId === target), periodStrategy)
          if (value !== 0) nextByTarget.set(target, value)
        }
        const current = currentRows.map(row => ({ guildId: row.guildId, value: row.value })).sort((a, b) => a.guildId.localeCompare(b.guildId))
        const next = [...nextByTarget.entries()].map(([guildId, value]) => ({ guildId, value })).sort((a, b) => a.guildId.localeCompare(b.guildId))
        if (JSON.stringify(current) !== JSON.stringify(next) || JSON.stringify(merged) !== JSON.stringify(sourceRows)) {
          periodPlans.push({ periodId: period.id, systemKey, subjectId, platform, current, next, components: merged })
        }
      }
    }
  }
  return {
    balanceStrategy,
    periodStrategy,
    desired,
    changes,
    balancePlans: balancePlans.sort((a, b) => a.systemKey.localeCompare(b.systemKey) || a.subjectId.localeCompare(b.subjectId) || a.platform.localeCompare(b.platform)),
    periodPlans: periodPlans.sort((a, b) => a.systemKey.localeCompare(b.systemKey) || a.periodId.localeCompare(b.periodId) || a.subjectId.localeCompare(b.subjectId)),
    baselineRows,
    affectedSystems,
    affectedPools,
    alreadyRemapped: changes.length === 0 && strategyChanges.length === 0,
  }
}

function remapOperationId(snapshot: GuildAliasRemapSnapshot, actor: ProfileDeletionActor): string {
  return 'XPALIAS:' + createHash('sha256').update(stableJson({ snapshot, actor: deletionActorKey(actor) })).digest('hex')
}

async function applyGuildAliasRemapSnapshot(database: AliasDatabase, snapshot: GuildAliasRemapSnapshot, actor: ProfileDeletionActor): Promise<void> {
  const now = new Date()
  const operationId = remapOperationId(snapshot, actor)
  for (const plan of snapshot.balancePlans) {
    await database.remove('xp_subject_balance', { subjectId: plan.subjectId, platform: plan.platform })
    await database.remove('xp_score_guild_component', { systemKey: plan.systemKey, subjectId: plan.subjectId, platform: plan.platform })
    for (const row of plan.next) await database.create('xp_subject_balance', {
      subjectId: plan.subjectId, platform: plan.platform, guildId: row.guildId, value: row.value, updatedAt: now,
    })
    for (const row of plan.components) await database.create('xp_score_guild_component', {
      systemKey: plan.systemKey, subjectId: plan.subjectId, platform: plan.platform, targetGuildId: row.targetGuildId,
      sourceGuildId: row.sourceGuildId, value: row.value, kind: row.kind ?? 'source', updatedAt: now,
    })
    const before = plan.current.reduce((sum, row) => sum + row.value, 0)
    const after = plan.next.reduce((sum, row) => sum + row.value, 0)
    const mutationId = operationId + ':' + plan.systemKey + ':' + plan.subjectId + ':' + plan.platform
    const journal = await database.create('xp_score_journal', {
      mutationId, systemKey: plan.systemKey, profileId: plan.profileId, platform: plan.platform,
      guildId: plan.next[0]?.guildId ?? plan.current[0]?.guildId ?? '', originPlatform: plan.platform,
      originGuildId: plan.next[0]?.guildId ?? plan.current[0]?.guildId ?? '', operation: 'guild-alias-remap', operand: null,
      delta: after - before, before, after, source: 'xp-points', reason: 'online guild alias remap',
      actorPlatform: actor.platform, actorUserId: actor.userId, createdAt: now,
    })
    await database.create('xp_journal_subject', { journalId: journal.id, subjectId: plan.subjectId, accountId: null })
  }
  for (const plan of snapshot.periodPlans) {
    await database.remove('xp_period_score', { periodId: plan.periodId, subjectId: plan.subjectId, platform: plan.platform })
    await database.remove('xp_period_guild_component', { periodId: plan.periodId, subjectId: plan.subjectId, platform: plan.platform })
    for (const row of plan.next) await database.create('xp_period_score', {
      periodId: plan.periodId, subjectId: plan.subjectId, platform: plan.platform, guildId: row.guildId, value: row.value, updatedAt: now.getTime(),
    })
    for (const row of plan.components) await database.create('xp_period_guild_component', {
      periodId: plan.periodId, subjectId: plan.subjectId, platform: plan.platform, targetGuildId: row.targetGuildId,
      sourceGuildId: row.sourceGuildId, value: row.value, kind: row.kind ?? 'source', updatedAt: now.getTime(),
    })
    await database.create('xp_period_adjustment', {
      operationId: operationId + ':period:' + plan.periodId + ':' + plan.subjectId + ':' + plan.platform,
      snapshot: JSON.stringify({ kind: 'guild-alias-remap', ...plan, actor: deletionActorKey(actor) }), createdAt: now.getTime(),
    })
  }
  for (const systemKey of snapshot.affectedSystems) {
    await database.remove('xp_score_guild_alias', { systemKey })
    for (const row of snapshot.desired.filter(row => row.systemKey === systemKey)) {
      await database.create('xp_score_guild_alias', { ...row, createdAt: now, updatedAt: now })
    }
  }
  for (const pair of snapshot.affectedPools) {
    const [systemKey, platform] = pair.split('\0')
    await database.upsert('xp_score_guild_alias_policy', [{ systemKey, platform,
      balanceStrategy: snapshot.balanceStrategy,
      periodStrategy: snapshot.periodStrategy, updatedAt: now }])
  }
}

function renderGuildAliasRemapSummary(snapshot: GuildAliasRemapSnapshot, balanceStrategy: GuildAliasCombineStrategy, periodStrategy: GuildAliasCombineStrategy): string[] {
  const changed = snapshot.changes.length
  const balanceChanges = snapshot.balancePlans.filter(plan => JSON.stringify(plan.current) !== JSON.stringify(plan.next)).length
  const periodChanges = snapshot.periodPlans.filter(plan => JSON.stringify(plan.current) !== JSON.stringify(plan.next)).length
  return [
    `挂靠变化 ${changed} 条；累计策略：${balanceStrategy === 'sum' ? '累加' : '取最高'}；周期策略：${periodStrategy === 'sum' ? '累加' : '取最高'}。`,
    `将更新 ${balanceChanges} 个计分主体的群池余额、${periodChanges} 个周期成绩。`,
    snapshot.baselineRows ? `有 ${snapshot.baselineRows} 处历史余额或周期成绩缺少来源组件，将按当前可见值建立保守基线；不会恢复无法证明的旧低分。` : '现有来源组件完整，可按来源重建群池。',
    '本次挂靠重映射不是竞技奖励，不会额外发放周期积分。',
  ]
}

function scoreMutationId(systemKey: string, source: string, idempotencyKey: string): string {
  const normalized = idempotencyKey.trim()
  if (!normalized) throw new XpPointsUserError('积分幂等键不能为空。')
  return 'XPSCORE-IDEMP-' + createHash('sha256')
    .update([systemKey, source, normalized].join('\0'))
    .digest('hex')
}
