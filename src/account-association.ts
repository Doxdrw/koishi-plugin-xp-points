import { XpPointsUserError } from './errors'
import { createHash } from 'node:crypto'
import { assertOperationNotErased } from './erased-operation'
import { type Context } from 'koishi'
import { readConversionState } from './account-conversion'
import { planPersonAssociation } from './account-association-policy'
import { requireAccountAuthority, type AccountActor } from './account-maintenance'
import type { AccountScoreMode, ScoreCombineStrategy } from './account-policy'
import { ACCOUNT_SCHEMA_VERSION, ACCOUNT_SCHEMA_KEY } from './account-storage'
import { SubjectWriteCoordinator } from './subject-ledger'
import { periodBalances, writePeriodConversionIn } from './period-conversion'
import { ACCOUNT_CONVERSION_BASELINE_SOURCE } from './account-conversion'

type Database = Context['database']
export interface PersonAssociationRequest {
  operationId: string
  kind: 'merge-persons' | 'move-account'
  movedAccountId?: string
  sourceProfileId: number
  targetProfileId: number
  /** Explicit main selection, never inferred from a nickname collision. */
  primaryAccountId?: string
  defaultScoreMode?: AccountScoreMode
  actor: AccountActor
  /** Every registered system, including disabled systems, must be explicit. */
  systems: Array<{ systemKey: string, mode: AccountScoreMode, strategy: ScoreCombineStrategy, periodStrategy?: ScoreCombineStrategy,
    sourceRetainedAccountId?: string, targetRetainedAccountId?: string }>
}
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]))
  return value
}
const serialize = (value: unknown) => JSON.stringify(stable(value))
const hash = (value: unknown) => createHash('sha256').update(serialize(value)).digest('hex')
const sorted = <T>(rows: T[]) => rows.sort((a, b) => serialize(a) < serialize(b) ? -1 : serialize(a) > serialize(b) ? 1 : 0)

function validate(request: PersonAssociationRequest) {
  if (request.defaultScoreMode !== undefined && !['shared', 'independent'].includes(request.defaultScoreMode)) throw new XpPointsUserError('关联默认计分方式无效。')
  if (!['merge-persons', 'move-account'].includes(request.kind) || !/^XPAR:[A-Za-z0-9-]{8,100}$/.test(request.operationId)
    || !Number.isSafeInteger(request.sourceProfileId) || request.sourceProfileId <= 0
    || !Number.isSafeInteger(request.targetProfileId) || request.targetProfileId <= 0
    || request.sourceProfileId === request.targetProfileId) throw new XpPointsUserError('两真人关联请求无效。')
  if (request.kind === 'move-account' ? !request.movedAccountId?.trim() : request.movedAccountId !== undefined) {
    throw new XpPointsUserError('请明确区分单账号移动与整档合并。')
  }
  if (!Array.isArray(request.systems) || new Set(request.systems.map(row => row.systemKey)).size !== request.systems.length) {
    throw new XpPointsUserError('积分系统选择重复或无效。')
  }
}

async function readPerson(db: Database, profileId: number) {
  const profile = (await db.get('xp_profile', { id: profileId }))[0]
  const preference = (await db.get('xp_person_preference', { profileId }))[0]
  const identities = sorted(await db.get('xp_identity', { profileId }))
  const accounts = []
  for (const identity of identities) {
    const account = (await db.get('xp_account', { platform: identity.platform, userId: identity.userId }))[0]
    if (!account) throw new XpPointsUserError('账号档案不完整。')
    accounts.push(account)
  }
  if (!profile || !preference || !accounts.length || new Set(accounts.map(row => row.label)).size !== accounts.length
    || (preference.primaryAccountId !== null && !accounts.some(row => row.id === preference.primaryAccountId))) {
    throw new XpPointsUserError('真人档案、账号标签或主号偏好不完整。')
  }
  return { profile, preference, identities, accounts: sorted(accounts) }
}

async function previewIn(db: Database, request: PersonAssociationRequest) {
  validate(request)
  const source = await readPerson(db, request.sourceProfileId)
  const target = await readPerson(db, request.targetProfileId)
  const moving = request.kind === 'move-account'
    ? source.accounts.filter(row => row.id === request.movedAccountId) : source.accounts
  if (!moving.length) throw new XpPointsUserError('待移动账号不属于原真人。')
  const primaryAfter = request.primaryAccountId ?? target.preference.primaryAccountId
  if (request.primaryAccountId !== undefined && ![...moving, ...target.accounts].some(row => row.id === request.primaryAccountId)) {
    throw new XpPointsUserError('指定主号不属于关联后的账号组。')
  }
  const primaryChange = { before: target.preference.primaryAccountId, after: primaryAfter }
  if (request.kind === 'move-account' && source.accounts.length === 1) {
    throw new XpPointsUserError('这是原档案最后一个账号，请重新预览整档合并。')
  }
  const systems = sorted(await db.get('xp_score_system', {}))
  if (systems.length !== request.systems.length || systems.some(row => !request.systems.some(choice => choice.systemKey === row.key))) {
    throw new XpPointsUserError('必须明确选择全部积分系统的处理方式。')
  }
  // Existing target labels win. Suffixes are deterministic and shown before confirmation.
  const labels = new Set(target.accounts.map(row => row.label))
  const labelChanges = moving.map(account => {
    let label = account.label
    for (let index = 2; labels.has(label); index++) {
      const suffix = '-' + index
      label = account.label.slice(0, 64 - suffix.length) + suffix
    }
    labels.add(label)
    return { accountId: account.id, before: account.label, after: label }
  })
  const systemPlans = []
  for (const system of systems) {
    const requested = request.systems.find(row => row.systemKey === system.key)!
    // A singleton has only one possible recipient. Multi-account shared groups
    // still require an explicit choice; never clone their shared balance.
    const choice = { ...requested,
      sourceRetainedAccountId: requested.sourceRetainedAccountId ?? (source.accounts.length === 1 ? source.accounts[0].id : undefined),
      targetRetainedAccountId: requested.targetRetainedAccountId ?? (target.accounts.length === 1 ? target.accounts[0].id : undefined),
    }
    const from = await readConversionState(db, source.profile.id, system.key, true)
    const to = await readConversionState(db, target.profile.id, system.key, true)
    const sourceActive = from.subjects.filter(row => row.active)
    if (from.policy.mode === 'shared' ? sourceActive.length !== 1 || sourceActive[0].accountId !== null
      : from.policy.mode !== 'independent' || sourceActive.length !== from.accounts.length
        || new Set(sourceActive.map(row => row.accountId)).size !== from.accounts.length
        || sourceActive.some(row => !from.accounts.some(account => account.id === row.accountId))) {
      throw new XpPointsUserError('原组计分主体与账号策略不完整。')
    }
    if (from.balances.some(row => !sourceActive.some(subject => subject.id === row.subjectId) || !Number.isFinite(row.value))) {
      throw new XpPointsUserError('原组余额包含退休主体或非法数值。')
    }
    const accounts = [...moving, ...target.accounts]
    const destinations = (choice.mode === 'shared' ? [null] : accounts.map(row => row.id)).map(accountId => ({
      id: 'XPS-' + hash([request.operationId, system.key, accountId]), accountId,
    }))
    const virtualId = 'XPMOVE-EMPTY-' + hash([request.operationId, system.key])
    const single = request.kind === 'move-account'
    const movingSubjects = single ? from.policy.mode === 'shared'
      ? [{ id: virtualId, accountId: moving[0].id, active: true }]
      : from.subjects.filter(row => row.active && row.accountId === moving[0].id) : from.subjects
    const movingIds = new Set(movingSubjects.map(row => row.id))
    const plan = planPersonAssociation({ kind: 'merge-persons', nextMode: choice.mode, strategy: choice.strategy,
      source: { profileId: source.profile.id, mode: single ? 'independent' : from.policy.mode,
        accounts: moving.map(row => row.id), subjects: movingSubjects,
        balances: single ? from.balances.filter(row => movingIds.has(row.subjectId)) : from.balances,
        retainedAccountId: choice.sourceRetainedAccountId },
      target: { profileId: target.profile.id, mode: to.policy.mode, accounts: to.accounts.map(row => row.id),
        subjects: to.subjects, balances: to.balances, retainedAccountId: choice.targetRetainedAccountId }, destinations })
    const periodPlan = planPersonAssociation({ kind: 'merge-persons', nextMode: choice.mode, strategy: choice.periodStrategy ?? 'maximum',
      source: { profileId: source.profile.id, mode: single ? 'independent' : from.policy.mode,
        accounts: moving.map(row => row.id), subjects: movingSubjects,
        balances: periodBalances(single ? from.periodScores.filter(row => movingIds.has(row.subjectId)) : from.periodScores),
        retainedAccountId: choice.sourceRetainedAccountId },
      target: { profileId: target.profile.id, mode: to.policy.mode, accounts: to.accounts.map(row => row.id),
        subjects: to.subjects, balances: periodBalances(to.periodScores), retainedAccountId: choice.targetRetainedAccountId }, destinations })
    // A shared group's points never travel with one departing member. The zero
    // virtual source is preview-only, not a persisted/retired score subject.
    plan.retire = plan.retire.filter(id => id !== virtualId)
    periodPlan.retire = periodPlan.retire.filter(id => id !== virtualId)
    systemPlans.push({ system, choice, from, to, destinations, plan, periodPlan })
  }
  // A new merge elsewhere may alter historical canonical ownership; invalidate conservatively.
  const merges = sorted(await db.get('xp_profile_merge', {}))
  if (merges.some(row => row.sourceProfileId === source.profile.id || row.sourceProfileId === target.profile.id)) {
    throw new XpPointsUserError('待关联档案已存在合并去向，请重新选择规范档案。')
  }
  const state = { source, target, moving, systemPlans, labelChanges, merges, primaryChange }
  return { request: structuredClone(request), fingerprint: hash(state), ...state }
}
export type PersonAssociationPreview = Awaited<ReturnType<typeof previewIn>>
export interface PersonAssociationResult { operationId: string, profileId: number, accountIds: string[], deduplicated: boolean }

/** Explicit whole-person association or single-account move. */
export class PersonAssociationStore {
  constructor(private readonly database: Database, private readonly writes: SubjectWriteCoordinator,
    private readonly assertMutable: (scope: { profileIds: number[], accountIds: string[] }) => Promise<void>) {}

  private run<T>(request: PersonAssociationRequest, callback: (db: Database) => Promise<T>): Promise<T> {
    return this.writes.run(() => this.database.transact(async db => {
      const marker = (await db.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
      if (marker?.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构尚未初始化。')
      validate(request)
      // Do not trust an authority supplied in a preview or another associated account.
      if (await requireAccountAuthority(db, request.actor) < 2) throw new XpPointsUserError('关联他人账号需要管理员权限。')
      return callback(db)
    }))
  }

  preview(request: PersonAssociationRequest): Promise<PersonAssociationPreview> {
    const copy = structuredClone(request)
    return this.run(copy, async db => {
      const preview = await previewIn(db, copy)
      await this.assertMutable({ profileIds: [copy.sourceProfileId, copy.targetProfileId],
        accountIds: [...preview.source.accounts, ...preview.target.accounts].map(row => row.id) })
      return preview
    })
  }

  apply(request: PersonAssociationRequest, fingerprint: string, assertFresh: () => void): Promise<PersonAssociationResult> {
    const copy = structuredClone(request)
    return this.run(copy, async db => {
      assertFresh()
      await assertOperationNotErased(db, 'account', copy.operationId)
      const previous = (await db.get('xp_account_operation', { id: copy.operationId }))[0]
      if (previous) {
        const snapshot = JSON.parse(previous.snapshot)
        if (previous.kind !== (copy.kind === 'merge-persons' ? 'person-association' : 'account-move') || snapshot.version !== 1 || snapshot.fingerprint !== fingerprint
          || serialize(snapshot.request) !== serialize(copy)) throw new XpPointsUserError('操作 ID 已被其他请求使用。')
        return { ...snapshot.result, deduplicated: true }
      }
      for (const profileId of [copy.sourceProfileId, copy.targetProfileId].sort((a, b) => a - b)) {
        if (!(await db.get('xp_person_preference', { profileId })).length) throw new XpPointsUserError('档案已变化，请重新预览。')
        await db.set('xp_person_preference', { profileId }, row => ({ revision: row.revision }))
      }
      const preview = await previewIn(db, copy)
      if (preview.fingerprint !== fingerprint) throw new XpPointsUserError('账号关系或余额已变化，请重新预览。')
      const accountIds = [...preview.moving, ...preview.target.accounts].map(row => row.id)
      await this.assertMutable({ profileIds: [copy.sourceProfileId, copy.targetProfileId],
        accountIds: [...preview.source.accounts, ...preview.target.accounts].map(row => row.id) })
      if (await requireAccountAuthority(db, copy.actor) < 2) throw new XpPointsUserError('关联他人账号需要管理员权限。')
      assertFresh()
      const now = new Date()
      for (const item of preview.systemPlans) {
        await db.remove('xp_subject_balance', { subjectId: item.plan.retire })
        await db.remove('xp_score_guild_component', { subjectId: item.plan.retire })
        await db.remove('xp_period_guild_component', { subjectId: item.plan.retire })
        await db.set('xp_score_subject', { id: item.plan.retire }, { active: false, retiredAt: now })
        for (const destination of item.destinations) await db.create('xp_score_subject', {
          ...destination, profileId: copy.targetProfileId, systemKey: item.system.key,
          active: true, createdAt: now, retiredAt: null,
        })
        if (item.plan.balances.length) await db.upsert('xp_subject_balance', item.plan.balances.map(row => ({ ...row, updatedAt: now })))
        if (item.system.scope === 'guild') for (const row of item.plan.balances) await db.create('xp_score_guild_component', {
          systemKey: item.system.key, subjectId: row.subjectId, platform: row.platform,
          targetGuildId: row.guildId, sourceGuildId: ACCOUNT_CONVERSION_BASELINE_SOURCE, value: row.value,
          kind: 'baseline' as const, updatedAt: now,
        })
        await writePeriodConversionIn(db, { operationId: copy.operationId, sourceIds: item.periodPlan.retire,
          before: [...item.from.periodScores, ...item.to.periodScores].filter(row => item.periodPlan.retire.includes(row.subjectId)),
          after: item.periodPlan.pools.flatMap(pool => pool.destinations.map(d => ({ subjectId: d.subjectId, platform: pool.platform, guildId: pool.guildId, value: d.value }))),
          strategy: item.choice.periodStrategy ?? 'maximum' })
        if (item.system.scope === 'guild') for (const row of item.periodPlan.balances) {
          const [periodId, platform] = JSON.parse(row.platform) as [string, string]
          await db.create('xp_period_guild_component', { periodId, subjectId: row.subjectId, platform, targetGuildId: row.guildId,
            sourceGuildId: ACCOUNT_CONVERSION_BASELINE_SOURCE, value: row.value, kind: 'baseline' as const, updatedAt: now.getTime() })
        }
        await db.set('xp_account_policy', { profileId: copy.targetProfileId, systemKey: item.system.key }, {
          mode: item.choice.mode, revision: item.to.policy.revision + 1,
        })
        if (copy.kind === 'move-account') await db.set('xp_account_policy', {
          profileId: copy.sourceProfileId, systemKey: item.system.key,
        }, { revision: item.from.policy.revision + 1 })
      }
      if (copy.kind === 'merge-persons') await db.remove('xp_account_policy', { profileId: copy.sourceProfileId })
      for (const change of preview.labelChanges) if (change.before !== change.after) {
        await db.set('xp_account', { id: change.accountId }, { label: change.after })
      }
      for (const account of preview.moving) await db.set('xp_identity', {
        platform: account.platform, userId: account.userId, profileId: copy.sourceProfileId,
      }, { profileId: copy.targetProfileId, updatedAt: now })
      await db.set('xp_person_preference', { profileId: copy.targetProfileId }, {
        revision: preview.target.preference.revision + 1,
        primaryAccountId: preview.primaryChange.after,
        ...(copy.defaultScoreMode ? { defaultScoreMode: copy.defaultScoreMode } : {}),
      })
      await db.set('xp_profile', { id: copy.targetProfileId }, { automatic: false, updatedAt: now })
      if (copy.kind === 'merge-persons') {
        await db.create('xp_profile_merge', { sourceProfileId: copy.sourceProfileId, targetProfileId: copy.targetProfileId, createdAt: now })
        await db.remove('xp_person_preference', { profileId: copy.sourceProfileId })
        await db.remove('xp_profile', { id: copy.sourceProfileId })
      } else {
        await db.set('xp_person_preference', { profileId: copy.sourceProfileId }, {
          revision: preview.source.preference.revision + 1,
          primaryAccountId: preview.source.preference.primaryAccountId === copy.movedAccountId ? null : preview.source.preference.primaryAccountId,
        })
        await db.set('xp_profile', { id: copy.sourceProfileId }, { updatedAt: now })
      }
      const result: PersonAssociationResult = { operationId: copy.operationId, profileId: copy.targetProfileId, accountIds, deduplicated: false }
      await db.create('xp_account_operation', { id: copy.operationId, kind: copy.kind === 'merge-persons' ? 'person-association' : 'account-move',
        actorPlatform: copy.actor.platform, actorUserId: copy.actor.userId, createdAt: now,
        snapshot: serialize({ version: 1, request: copy, fingerprint, preview, result }) })
      return result
    })
  }
}
