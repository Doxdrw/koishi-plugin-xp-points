import { XpPointsUserError } from './errors'
import { createHash, randomBytes } from 'node:crypto'
import { recordCompetitiveIn, validateCompetitiveRetry, type CompetitiveContext } from './period-ledger'
import { assertOperationNotErased } from './erased-operation'
import { $, type Context } from 'koishi'
import type { ScoreMutationResult, InternalScoreMutationContext } from './score-ledger'
import type { XpScoreJournal } from './model'
import { ACCOUNT_SCHEMA_VERSION, ACCOUNT_SCHEMA_KEY } from './account-storage'
import { applyAccountConversionIn, previewAccountConversion, readConversionState, type AccountConversionRequest } from './account-conversion'
import { requireAccountAuthority, type AccountActor } from './account-maintenance'
import { SubjectWriteCoordinator } from './mutation-coordinator'
import { applyScoreGuildComponentMutationIn, getGuildAliasPolicyIn } from './guild-alias-components'
export { SubjectWriteCoordinator } from './mutation-coordinator'

type Database = Context['database']
/** Every score mutation names a real platform account; person IDs are not score targets. */
export type ScoreAccountTarget = { accountId: string }
export interface SubjectScoreEntry {
  profileId: number
  subjectId: string
  accountId: string | null
  nickname: string
  accountNickname: string | null
  accountNicknameStatus: 'automatic' | 'managed' | 'unknown' | null
  primaryAccountId: string | null
  label: string | null
  value: number
  /** Internal filtering input, never append these IDs to public board messages. */
  identities: Array<{ platform: string, userId: string }>
}
type PoolContext = { platform?: string, guildId?: string }
export interface SubjectBatchRequest {
  operationId: string
  systemKey: string
  profileId: number
  operation: 'add' | 'set'
  operand: number
  actor: AccountActor
  context: PoolContext & CompetitiveContext
  reason: string
}
const finite = (...values: number[]) => {
  if (!values.every(Number.isFinite)) throw new XpPointsUserError('积分或变化量超出有限数值范围。')
}

async function canonicalPerson(database: Database, profileId: number): Promise<number> {
  const seen = new Set<number>()
  while (true) {
    if (seen.has(profileId)) throw new XpPointsUserError('真人合并链存在循环。')
    seen.add(profileId)
    const merged = (await database.get('xp_profile_merge', { sourceProfileId: profileId }))[0]
    if (!merged) break
    profileId = merged.targetProfileId
  }
  if (!(await database.get('xp_profile', { id: profileId })).length) throw new XpPointsUserError('没有找到真人档案。')
  return profileId
}

async function targetOwner(database: Database, target: ScoreAccountTarget) {
  if (!target || typeof target !== 'object' || Object.keys(target).some(key => key !== 'accountId')
    || typeof target.accountId !== 'string' || !target.accountId.trim()) {
    throw new XpPointsUserError('请指定一个有效账号。')
  }
  const account = (await database.get('xp_account', { id: target.accountId }))[0]
  if (!account) throw new XpPointsUserError('没有找到账号档案。')
  const identity = (await database.get('xp_identity', { platform: account.platform, userId: account.userId }))[0]
  if (!identity) throw new XpPointsUserError('账号缺少真人归属。')
  return { profileId: await canonicalPerson(database, identity.profileId), accountId: account.id }
}

async function accountBelongsToPerson(database: Database, accountId: string, profileId: number): Promise<boolean> {
  const account = (await database.get('xp_account', { id: accountId }))[0]
  if (!account) return false
  const identity = (await database.get('xp_identity', { platform: account.platform, userId: account.userId }))[0]
  if (!identity) return false
  return await canonicalPerson(database, identity.profileId) === profileId
}

async function resolvePool(database: Database, systemKey: string, context: PoolContext) {
  const system = (await database.get('xp_score_system', { key: systemKey }))[0]
  if (!system) throw new XpPointsUserError('没有找到积分系统。')
  const originPlatform = context.platform?.trim() ?? ''
  const originGuildId = context.guildId?.trim() ?? ''
  if (system.scope === 'global') return { system, platform: '', guildId: '', originPlatform, originGuildId }
  if (!originPlatform) throw new XpPointsUserError('此积分系统需要平台。')
  if (system.scope === 'platform') return { system, platform: originPlatform, guildId: '', originPlatform, originGuildId }
  if (system.scope !== 'guild' || !originGuildId) throw new XpPointsUserError('此积分系统需要群聊。')
  const alias = (await database.get('xp_score_guild_alias', { systemKey, platform: originPlatform, sourceGuildId: originGuildId }))[0]
  return { system, platform: originPlatform, guildId: alias?.targetGuildId ?? originGuildId, originPlatform, originGuildId }
}

async function resolveSubject(database: Database, systemKey: string, owner: Awaited<ReturnType<typeof targetOwner>>) {
  const policy = (await database.get('xp_account_policy', { systemKey, profileId: owner.profileId }))[0]
  if (!policy) throw new XpPointsUserError('账号积分策略尚未初始化。')
  if (policy.mode === 'independent' && owner.accountId === null) {
    throw new XpPointsUserError('独立积分存在账号歧义，请明确指定账号或使用全部账号操作。')
  }
  if (!['shared', 'independent'].includes(policy.mode)) throw new XpPointsUserError('账号积分策略无效。')
  const subjects = await database.get('xp_score_subject', { systemKey, profileId: owner.profileId, active: true,
    accountId: policy.mode === 'shared' ? null : owner.accountId })
  if (subjects.length !== 1) throw new XpPointsUserError('当前计分主体不唯一或不完整。')
  return subjects[0]
}

async function personEntries(database: Database, systemKey: string, profileId: number,
  pool: Awaited<ReturnType<typeof resolvePool>>): Promise<SubjectScoreEntry[]> {
  const profile = (await database.get('xp_profile', { id: profileId }))[0]
  if (!profile) throw new XpPointsUserError('没有找到真人档案。')
  const identities = await database.get('xp_identity', { profileId })
  const accounts = []
  for (const identity of identities) {
    const account = (await database.get('xp_account', { platform: identity.platform, userId: identity.userId }))[0]
    if (!account) throw new XpPointsUserError('账号记录不完整。')
    accounts.push(account)
  }
  const policy = (await database.get('xp_account_policy', { systemKey, profileId }))[0]
  const preference = (await database.get('xp_person_preference', { profileId }))[0]
  if (!preference || (preference.primaryAccountId !== null && !accounts.some(row => row.id === preference.primaryAccountId))) {
    throw new XpPointsUserError('真人主号偏好不完整或归属错误。')
  }
  if (!accounts.length || !policy || !['shared', 'independent'].includes(policy.mode)) throw new XpPointsUserError('账号或计分策略不完整。')
  const subjects = await database.get('xp_score_subject', { systemKey, profileId, active: true })
  if (policy.mode === 'shared' ? subjects.length !== 1 || subjects[0].accountId !== null
    : subjects.length !== accounts.length || new Set(subjects.map(row => row.accountId)).size !== accounts.length
      || subjects.some(row => !accounts.some(account => account.id === row.accountId))) {
    throw new XpPointsUserError('有效计分主体与账号策略不一致。')
  }
  if (new Set(accounts.map(row => row.label)).size !== accounts.length) throw new XpPointsUserError('同一真人的账号标签重复。')
  const result: SubjectScoreEntry[] = []
  for (const subject of subjects) {
    const account = accounts.find(row => row.id === subject.accountId)
    const value = (await database.get('xp_subject_balance', { subjectId: subject.id, platform: pool.platform, guildId: pool.guildId }))[0]?.value ?? 0
    finite(value)
    result.push({ profileId, subjectId: subject.id, accountId: subject.accountId, nickname: profile.nickname,
      accountNickname: account?.nickname ?? null, accountNicknameStatus: account?.nicknameStatus ?? null,
      primaryAccountId: preference.primaryAccountId, label: account?.label ?? null, value,
      identities: (account ? [account] : accounts).map(row => ({ platform: row.platform, userId: row.userId })),
    })
  }
  return result.sort((a, b) => b.value - a.value || a.subjectId.localeCompare(b.subjectId))
}

async function firstPersonAccountId(database: Database, profileId: number): Promise<string | undefined> {
  for (const identity of await database.get('xp_identity', { profileId })) {
    const account = (await database.get('xp_account', { platform: identity.platform, userId: identity.userId }))[0]
    if (account) return account.id
  }
  return undefined
}

const asResult = (row: XpScoreJournal, deduplicated: boolean): ScoreMutationResult => ({
  before: row.before, after: row.after, delta: row.delta, journalId: row.id, deduplicated,
})

/** Query-only primitive for the service's filtered, snapshot-consistent board. */
export async function subjectLeaderboardIn(db: Database, systemKey: string, context: PoolContext) {
  const pool = await resolvePool(db, systemKey, context)
  const entries: SubjectScoreEntry[] = []
  for (const policy of await db.get('xp_account_policy', { systemKey })) {
    entries.push(...await personEntries(db, systemKey, policy.profileId, pool))
  }
  return entries.sort((a, b) => b.value - a.value || a.profileId - b.profileId || a.subjectId.localeCompare(b.subjectId))
}

/**
 * Single writer for subject balances and mode conversion. All public handles,
 * relationship operations and deletion share the xpPoints-owned queue.
 */
export class SubjectLedgerStore {
  constructor(private readonly database: Database, private readonly writes: SubjectWriteCoordinator) {}

  private async transaction<T>(callback: (database: Database) => Promise<T>): Promise<T> {
    return this.writes.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.database.transact(async db => {
            const schema = (await db.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
            if (schema?.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构尚未初始化。')
            return callback(db)
          })
        } catch (error) {
          if (attempt >= 2 || !/database is (locked|busy)|deadlock|serialization failure/i.test(String(error))) throw error
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
        }
      }
    })
  }

  previewConversion(request: AccountConversionRequest) {
    return this.transaction(db => previewAccountConversion(db, request))
  }

  convert(request: AccountConversionRequest, fingerprint: string,
    guard: (database: Database, request: AccountConversionRequest) => Promise<void>) {
    return this.transaction(async db => {
      await this.lockPerson(db, request.profileId)
      return applyAccountConversionIn(db, request, fingerprint, guard)
    })
  }

  private async lockPerson(db: Database, profileId: number) {
    // No-op UPDATE obtains a transaction write lock without changing previews.
    // Relationship/merge writers must acquire these locks in ascending ID order.
    if (!(await db.get('xp_person_preference', { profileId })).length) throw new XpPointsUserError('真人账号偏好尚未初始化。')
    await db.set('xp_person_preference', { profileId }, row => ({ revision: row.revision }))
  }

  get(systemKey: string, target: ScoreAccountTarget, context: PoolContext): Promise<number> {
    return this.transaction(async db => {
      const pool = await resolvePool(db, systemKey, context)
      const subject = await resolveSubject(db, systemKey, await targetOwner(db, target))
      const value = (await db.get('xp_subject_balance', { subjectId: subject.id, platform: pool.platform, guildId: pool.guildId }))[0]?.value ?? 0
      finite(value)
      return value
    })
  }

  overview(systemKey: string, profileId: number, context: PoolContext) {
    return this.transaction(async db => {
      const pool = await resolvePool(db, systemKey, context)
      const entries = await personEntries(db, systemKey, await canonicalPerson(db, profileId), pool)
      return { entries, maximum: entries[0].value }
    })
  }

  /** Unfiltered internal rows. Caller applies presence/authority in SOURCE guild. */
  leaderboard(systemKey: string, context: PoolContext): Promise<SubjectScoreEntry[]> {
    return this.transaction(db => subjectLeaderboardIn(db, systemKey, context))
  }

  add(systemKey: string, target: ScoreAccountTarget, amount: number, context: InternalScoreMutationContext) {
    return this.mutate(systemKey, target, 'add', amount, context)
  }

  set(systemKey: string, target: ScoreAccountTarget, value: number, context: InternalScoreMutationContext) {
    return this.mutate(systemKey, target, 'set', value, context)
  }

  private async batchPreviewIn(db: Database, request: SubjectBatchRequest) {
    if (!/^XPAB:[A-Za-z0-9-]{8,100}$/.test(request.operationId)
      || !['add', 'set'].includes(request.operation) || !request.reason?.trim()) throw new XpPointsUserError('批量积分请求无效。')
    finite(request.operand)
    if (await requireAccountAuthority(db, request.actor) < 2) throw new XpPointsUserError('批量修改积分需要管理员权限。')
    const profileId = await canonicalPerson(db, request.profileId)
    if (profileId !== request.profileId) throw new XpPointsUserError('真人档案已合并，请重新选择。')
    const pool = await resolvePool(db, request.systemKey, request.context)
    const state = await readConversionState(db, profileId, request.systemKey)
    const entries = await personEntries(db, request.systemKey, profileId, pool)
    if (new Set(entries.map(row => row.subjectId)).size !== entries.length) throw new XpPointsUserError('批量计分主体重复。')
    const changes = entries.map(entry => {
      const after = request.operation === 'add' ? entry.value + request.operand : request.operand
      finite(after, after - entry.value)
      return { subjectId: entry.subjectId, accountId: entry.accountId, before: entry.value, after, delta: after - entry.value }
    })
    const totalDelta = changes.reduce((sum, row) => { finite(sum + row.delta); return sum + row.delta }, 0)
    return { request, entries, changes, totalDelta, pool,
      fingerprint: createHash('sha256').update(JSON.stringify({ state, pool })).digest('hex') }
  }

  previewBatch(request: SubjectBatchRequest) {
    const copy = structuredClone(request)
    return this.transaction(db => this.batchPreviewIn(db, copy))
  }

  applyBatch(request: SubjectBatchRequest, fingerprint: string, assertFresh: () => void) {
    const copy = structuredClone(request)
    return this.transaction(async db => {
      assertFresh()
      if (await requireAccountAuthority(db, copy.actor) < 2) throw new XpPointsUserError('批量修改积分需要管理员权限。')
      await assertOperationNotErased(db, 'account', copy.operationId)
      const previous = (await db.get('xp_account_operation', { id: copy.operationId }))[0]
      if (previous) {
        const old = JSON.parse(previous.snapshot)
        if (previous.kind !== 'score-batch' || old.version !== 1 || old.fingerprint !== fingerprint
          || JSON.stringify(old.request) !== JSON.stringify(copy)) throw new XpPointsUserError('批量操作 ID 已被其他请求使用。')
        return { ...old.result, deduplicated: true }
      }
      await this.lockPerson(db, copy.profileId)
      const preview = await this.batchPreviewIn(db, copy)
      if (preview.fingerprint !== fingerprint) throw new XpPointsUserError('账号关系或余额已变化，请重新预览。')
      assertFresh()
      const results: Array<ScoreMutationResult & { subjectId: string }> = []
      const sharedAccountId = preview.entries.some(entry => entry.accountId === null)
        ? await firstPersonAccountId(db, copy.profileId)
        : undefined
      if (preview.entries.some(entry => entry.accountId === null) && !sharedAccountId) {
        throw new XpPointsUserError('真人没有可用于共享计分的实际账号。')
      }
      for (const entry of preview.entries) {
        const target = { accountId: entry.accountId ?? sharedAccountId! }
        const result = await this.mutateIn(db, copy.systemKey, target, copy.operation, copy.operand, {
          ...copy.context, reason: copy.reason, actor: copy.actor, source: 'xp-points-command',
          idempotencyKey: copy.operationId + ':' + entry.subjectId,
        })
        results.push({ ...result, subjectId: entry.subjectId })
      }
      const result = { operationId: copy.operationId, results, totalDelta: preview.totalDelta, deduplicated: false }
      await db.create('xp_account_operation', { id: copy.operationId, kind: 'score-batch',
        actorPlatform: copy.actor.platform, actorUserId: copy.actor.userId, createdAt: new Date(),
        snapshot: JSON.stringify({ version: 1, request: copy, fingerprint, changes: preview.changes, result }) })
      return result
    })
  }

  private mutate(systemKey: string, target: ScoreAccountTarget, operation: 'add' | 'set', operand: number,
    context: InternalScoreMutationContext): Promise<ScoreMutationResult> {
    const targetCopy = structuredClone(target), contextCopy = structuredClone(context)
    return this.transaction(db => this.mutateIn(db, systemKey, targetCopy, operation, operand, contextCopy))
  }

  private async mutateIn(db: Database, systemKey: string, target: ScoreAccountTarget, operation: 'add' | 'set', operand: number,
    context: InternalScoreMutationContext): Promise<ScoreMutationResult> {
    const reason = context.reason?.trim()
    const source = context.source?.trim()
    const idempotencyKey = context.idempotencyKey?.trim()
    const mutationId = idempotencyKey ? 'XPSCORE-IDEMP-' + createHash('sha256')
      .update([systemKey, source, idempotencyKey].join('\0')).digest('hex') : 'XPSCORE-' + randomBytes(18).toString('base64url')
      finite(operand)
      if (!reason || !source || (context.idempotencyKey != null && !idempotencyKey)) throw new XpPointsUserError('积分变更缺少原因、来源或有效幂等键。')
      await assertOperationNotErased(db, 'score', mutationId)
      const owner = await targetOwner(db, target)
      await this.lockPerson(db, owner.profileId)
      // Re-resolve after locking to refuse an account moved by another writer.
      const currentOwner = await targetOwner(db, target)
      if (currentOwner.profileId !== owner.profileId) throw new XpPointsUserError('账号归属已变化，请重试。')
      const pool = await resolvePool(db, systemKey, context)
      const previous = (await db.get('xp_score_journal', { mutationId }))[0]
      if (previous) {
        const link = (await db.get('xp_journal_subject', { journalId: previous.id }))[0]
        if (!link) throw new XpPointsUserError('历史奖励缺少计分主体关联，不能安全重试。')
        const subject = (await db.get('xp_score_subject', { id: link.subjectId }))[0]
        const priorOwner = await canonicalPerson(db, previous.profileId)
        finite(previous.before, previous.after, previous.delta)
        const sameOperand = previous.operand != null ? previous.operand === operand
          : operation === 'add' ? previous.before + operand === previous.after : previous.after === operand
        const sharedSubjectIsActive = Boolean((await db.get('xp_score_subject', {
          systemKey, profileId: owner.profileId, active: true, accountId: null,
        })).length)
        if (!subject || subject.systemKey !== systemKey
          || (link.accountId !== null
            ? (sharedSubjectIsActive
              ? !(await accountBelongsToPerson(db, link.accountId, owner.profileId))
              : link.accountId !== owner.accountId)
            : priorOwner !== owner.profileId)
          || previous.systemKey !== systemKey || previous.operation !== operation || previous.source !== source
          || previous.reason !== reason || previous.platform !== pool.platform || previous.guildId !== pool.guildId
          || previous.originPlatform !== pool.originPlatform || previous.originGuildId !== pool.originGuildId
          || previous.actorPlatform !== (context.actor?.platform ?? '') || previous.actorUserId !== (context.actor?.userId ?? '')
          || !sameOperand) throw new XpPointsUserError('积分幂等键已被其他变更使用。')
        // Resolve retry before current policy: retired/shared rewards stay done
        // even when a former person-only target is now independent/ambiguous.
        await validateCompetitiveRetry(db, previous.id, context)
        return asResult(previous, true)
      }
      if (!pool.system.active) throw new XpPointsUserError('积分系统已停用。')
      const subject = await resolveSubject(db, systemKey, owner)
      const query = { subjectId: subject.id, platform: pool.platform, guildId: pool.guildId }
      const before = (await db.get('xp_subject_balance', query))[0]?.value ?? 0
      const expected = operation === 'add' ? before + operand : operand
      finite(before, expected, expected - before)
      if (pool.system.scope === 'guild') {
        const policy = await getGuildAliasPolicyIn(db, systemKey, pool.platform)
        await applyScoreGuildComponentMutationIn({
          database: db,
          systemKey,
          subjectId: subject.id,
          platform: pool.platform,
          targetGuildId: pool.guildId,
          sourceGuildId: pool.originGuildId || pool.guildId,
          before,
          targetAfter: expected,
          operation,
          amount: operand,
          strategy: policy.balance,
        })
      }
      if (operation === 'add') await db.upsert('xp_subject_balance', row => [{ ...query,
        value: $.add($.ifNull(row.value, 0), operand), updatedAt: new Date() }])
      else await db.upsert('xp_subject_balance', [{ ...query, value: operand, updatedAt: new Date() }])
      const after = (await db.get('xp_subject_balance', query))[0]?.value ?? 0
      finite(after, after - before)
      if (after !== expected) throw new XpPointsUserError('积分写入结果不一致，事务已取消。')
      if (after === 0) await db.remove('xp_subject_balance', query)
      const journal = await db.create('xp_score_journal', {
        mutationId, systemKey, profileId: owner.profileId, platform: pool.platform, guildId: pool.guildId,
        originPlatform: pool.originPlatform, originGuildId: pool.originGuildId, operation, operand,
        before, after, delta: after - before, source, reason,
        actorPlatform: context.actor?.platform ?? '', actorUserId: context.actor?.userId ?? '', createdAt: new Date(),
      })
      await db.create('xp_journal_subject', { journalId: journal.id, subjectId: subject.id, accountId: owner.accountId })
      await recordCompetitiveIn(db, { systemKey, subjectId: subject.id, platform: pool.platform, guildId: pool.guildId,
        originGuildId: pool.originGuildId, delta: journal.delta, journalId: journal.id, context, now: journal.createdAt.getTime() })
      return asResult(journal, false)
  }
}
