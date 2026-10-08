import { XpPointsUserError } from './errors'
import { randomUUID } from 'node:crypto'
import type { Context } from 'koishi'
import type { XpAccount, XpAccountPolicy } from './account-model'
import { resolveDefaultScoreMode, type AccountScoreMode, type ScoreCombineStrategy } from './account-policy'
import { ACCOUNT_SCHEMA_VERSION, ACCOUNT_SCHEMA_KEY, initializeAccountSchema, requireAccountSchema } from './account-storage'
import { SubjectWriteCoordinator } from './subject-ledger'

type Database = Context['database']
export interface AccountDefaults {
  mode?: AccountScoreMode
  combineStrategy?: ScoreCombineStrategy
}
export function normalizeAccountDefaults(value: AccountDefaults = {}) {
  const mode = value.mode ?? 'shared'
  const combineStrategy = value.combineStrategy ?? 'maximum'
  if (!['shared', 'independent'].includes(mode) || !['maximum', 'sum'].includes(combineStrategy)) {
    throw new XpPointsUserError('账号默认模式或合分策略无效。')
  }
  return { mode, combineStrategy }
}

export interface AccountIdentityInput {
  platform: string
  userId: string
  /** Caller resolves platform/session display name; ID is the last fallback. */
  suggestedNickname?: string
}

async function availableName(database: Database, base: string, userId: string, owner?: number): Promise<string> {
  const suffix = userId.replace(/\s+/g, '').slice(-4) || 'user'
  for (let index = 0; ; index++) {
    const candidate = index === 0 ? base : `${base}#${suffix}${index === 1 ? '' : '-' + index}`
    const row = (await database.get('xp_profile', { nickname: candidate }))[0]
    if (!row || row.id === owner) return candidate
  }
}

async function personAccounts(database: Database, profileId: number): Promise<XpAccount[]> {
  const identities = await database.get('xp_identity', { profileId })
  if (!identities.length) throw new XpPointsUserError('真人没有关联账号。')
  const accounts: XpAccount[] = []
  for (const identity of identities) {
    const account = (await database.get('xp_account', { platform: identity.platform, userId: identity.userId }))[0]
    if (!account) throw new XpPointsUserError('已有账号记录缺失，拒绝自动补造。')
    accounts.push(account)
  }
  if (new Set(accounts.map(row => row.label)).size !== accounts.length) throw new XpPointsUserError('账号标签重复。')
  return accounts
}

async function ensurePolicy(database: Database, profileId: number, systemKey: string, accounts: XpAccount[], defaultMode: AccountScoreMode) {
  const existing = (await database.get('xp_account_policy', { profileId, systemKey }))[0]
  const subjects = await database.get('xp_score_subject', { profileId, systemKey })
  if (existing) {
    const active = subjects.filter(row => row.active)
    if (existing.mode === 'shared' ? active.length !== 1 || active[0].accountId !== null
      : existing.mode !== 'independent' || active.length !== accounts.length
        || new Set(active.map(row => row.accountId)).size !== accounts.length
        || active.some(row => !accounts.some(account => account.id === row.accountId))) {
      throw new XpPointsUserError('已有计分策略不完整，拒绝重新初始化余额主体。')
    }
    return existing
  }
  if (subjects.length) throw new XpPointsUserError('存在没有策略的历史计分主体，拒绝复用或重建。')
  const policy = await database.create('xp_account_policy', { profileId, systemKey, mode: defaultMode, revision: 0 })
  for (const accountId of defaultMode === 'shared' ? [null] : accounts.map(row => row.id)) {
    await database.create('xp_score_subject', { id: 'XPS-' + randomUUID(), profileId, systemKey, accountId,
      active: true, createdAt: new Date(), retiredAt: null })
  }
  return policy
}

/** Lifecycle for the current account/subject schema. */
export class AccountLifecycleStore {
  private readonly defaults: ReturnType<typeof normalizeAccountDefaults>
  constructor(private readonly database: Database, private readonly writes: SubjectWriteCoordinator, defaults: AccountDefaults = {}) {
    this.defaults = normalizeAccountDefaults(defaults)
  }

  private run<T>(callback: (database: Database) => Promise<T>, bootstrap = false): Promise<T> {
    return this.writes.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.database.transact(async db => {
            // Force lazy transaction setup before any validation can reject.
            await db.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY })
            if (!bootstrap) await requireAccountSchema(db)
            return callback(db)
          })
        } catch (error) {
          if (attempt >= 7 || !/unique constraint|duplicate entry|database is (locked|busy)|deadlock|serialization failure/i.test(String(error))) throw error
          await new Promise(resolve => setTimeout(resolve, Math.min(100, 10 * (attempt + 1))))
        }
      }
    })
  }

  /** Initialize a fresh installation; existing current rows are never rewritten. */
  bootstrap(): Promise<void> {
    return this.run(async db => {
      const marker = (await db.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
      if (marker) {
        if (marker.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构版本不兼容。')
        for (const profile of await db.get('xp_profile', {})) await this.ensurePersonDefault(db, profile.id)
        return
      }
      await initializeAccountSchema(db)
    }, true)
  }

  /** Additive metadata only: no identity, subject or balance conversion. */
  private async ensurePersonDefault(db: Database, profileId: number): Promise<AccountScoreMode> {
    const preference = (await db.get('xp_person_preference', { profileId }))[0]
    if (!preference) throw new XpPointsUserError('真人账号偏好不完整。')
    const policies = await db.get('xp_account_policy', { profileId })
    const mode = resolveDefaultScoreMode(preference.defaultScoreMode, policies.map(row => row.mode), this.defaults.mode)
    if (preference.defaultScoreMode == null) await db.set('xp_person_preference', { profileId }, {
      defaultScoreMode: mode, revision: preference.revision + 1,
    })
    return mode
  }

  ensureIdentity(input: AccountIdentityInput) {
    // Copy so later mutation of caller options cannot change a queued request.
    const { platform, userId, suggestedNickname } = input
    return this.run(async db => {
      if (!platform?.trim() || !userId?.trim()) throw new XpPointsUserError('平台和账号不能为空。')
      const base = suggestedNickname?.trim() || userId
      let identity = (await db.get('xp_identity', { platform, userId }))[0]
      let account = (await db.get('xp_account', { platform, userId }))[0]
      if (Boolean(identity) !== Boolean(account)) throw new XpPointsUserError('身份与账号记录不一致，拒绝自动补造。')
      let profile = identity ? (await db.get('xp_profile', { id: identity.profileId }))[0] : undefined
      if (identity && !profile) throw new XpPointsUserError('账号关联的真人档案不存在。')
      if (!identity) {
        const now = new Date()
        profile = await db.create('xp_profile', { nickname: await availableName(db, base, userId),
          automatic: true, createdAt: now, updatedAt: now })
        identity = await db.create('xp_identity', { platform, userId, profileId: profile.id, createdAt: now, updatedAt: now })
        account = await db.create('xp_account', { id: 'XPA-' + randomUUID(), platform, userId, label: '账号1',
          nickname: profile.nickname, nicknameStatus: 'automatic', createdAt: now })
        await db.create('xp_person_preference', { profileId: profile.id, primaryAccountId: null, revision: 0, defaultScoreMode: this.defaults.mode })
      } else {
        const preference = (await db.get('xp_person_preference', { profileId: profile!.id }))[0]
        if (!preference) throw new XpPointsUserError('已有真人缺少账号偏好，拒绝自动修复。')
        await db.set('xp_person_preference', { profileId: profile!.id }, row => ({ revision: row.revision }))
        const currentIdentity = (await db.get('xp_identity', { platform, userId }))[0]
        if (currentIdentity?.profileId !== profile!.id) throw new XpPointsUserError('账号归属已变化，请重试。')
        profile = (await db.get('xp_profile', { id: profile!.id }))[0]
        if (!profile) throw new XpPointsUserError('真人档案已变化，请重试。')
        if (profile!.automatic && profile!.nickname === userId && base !== userId) {
          const nickname = await availableName(db, base, userId, profile!.id)
          const updatedAt = new Date()
          await db.set('xp_profile', { id: profile!.id }, { nickname, updatedAt })
          profile = { ...profile!, nickname, updatedAt }
        }
        if (account!.nicknameStatus === 'automatic' && account!.nickname === userId && base !== userId) {
          await db.set('xp_account', { id: account!.id }, { nickname: base })
          account = { ...account!, nickname: base }
        }
      }
      const accounts = await personAccounts(db, profile!.id)
      const defaultMode = await this.ensurePersonDefault(db, profile!.id)
      const policies: XpAccountPolicy[] = []
      for (const system of await db.get('xp_score_system', {})) {
        policies.push(await ensurePolicy(db, profile!.id, system.key, accounts, defaultMode))
      }
      return { profile: profile!, account: account!, policies }
    })
  }

  /** The caller already holds the shared write queue and database transaction. */
  async initializeSystemIn(db: Database, systemKey: string): Promise<void> {
    await requireAccountSchema(db)
    if (!(await db.get('xp_score_system', { key: systemKey })).length) throw new XpPointsUserError('积分系统不存在。')
    const profiles = (await db.get('xp_profile', {})).sort((a, b) => a.id - b.id)
    for (const profile of profiles) {
      if (!(await db.get('xp_person_preference', { profileId: profile.id })).length) throw new XpPointsUserError('真人账号偏好不完整。')
      await db.set('xp_person_preference', { profileId: profile.id }, row => ({ revision: row.revision }))
      const defaultMode = await this.ensurePersonDefault(db, profile.id)
      await ensurePolicy(db, profile.id, systemKey, await personAccounts(db, profile.id), defaultMode)
    }
  }

  /** Initialization and system creation must commit together in production. */
  initializeSystem(systemKey: string): Promise<void> {
    return this.run(db => this.initializeSystemIn(db, systemKey))
  }
}
