import { XpPointsUserError } from './errors'
import { createHash } from 'node:crypto'
import { assertOperationNotErased } from './erased-operation'
import type { Context } from 'koishi'
import { planScoreModeConversion, type AccountScoreMode, type ScoreCombineStrategy } from './account-policy'
import { ACCOUNT_SCHEMA_VERSION, ACCOUNT_SCHEMA_KEY } from './account-storage'
import { periodBalances, withZeroPeriodBalances, writePeriodConversionIn } from './period-conversion'
import type { XpScoreGuildComponent } from './model'
import type { PeriodGuildComponent } from './period-model'

type Database = Context['database']

/** Internal request, constructed after command parsing; never trust client authority. */
export interface AccountConversionRequest {
  operationId: string
  profileId: number
  systemKey: string
  nextMode: AccountScoreMode
  retainedAccountId?: string
  strategy: ScoreCombineStrategy
  periodStrategy?: ScoreCombineStrategy
  actor: { kind: 'self' | 'administrator', platform: string, userId: string }
}

function stable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime()
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]),
  )
  return value
}
const serialize = (value: unknown) => JSON.stringify(stable(value))
const sorted = <T>(rows: T[]): T[] => rows.sort((a, b) => serialize(a).localeCompare(serialize(b)))
export const ACCOUNT_CONVERSION_BASELINE_SOURCE = '__account_conversion_baseline__'

function scoreConversionComponents(
  state: Awaited<ReturnType<typeof readConversionState>>,
  request: AccountConversionRequest,
  plan: Awaited<ReturnType<typeof planScoreModeConversion>>,
  destinations: Array<{ id: string, accountId: string | null }>,
  now: Date,
): Array<Omit<XpScoreGuildComponent, 'updatedAt'> & { updatedAt: Date }> {
  if (state.system.scope !== 'guild') return []
  const rows: Array<Omit<XpScoreGuildComponent, 'updatedAt'> & { updatedAt: Date }> = []
  const destination = request.nextMode === 'shared'
    ? destinations[0]
    : destinations.find(row => row.accountId === request.retainedAccountId)
  if (!destination) throw new XpPointsUserError('账号转换缺少积分承接主体。')
  if (state.policy.mode === 'shared' && request.nextMode === 'independent') {
    const sourceId = plan.retire[0]
    const sourceRows = state.scoreComponents.filter(row => row.subjectId === sourceId)
    for (const row of sourceRows) rows.push({ ...row, subjectId: destination.id, updatedAt: now })
    const existingTargets = new Set(sourceRows.map(row => row.targetGuildId))
    for (const balance of plan.balances.filter(row => row.subjectId === destination.id)) {
      if (existingTargets.has(balance.guildId)) continue
      rows.push({ systemKey: request.systemKey, subjectId: destination.id, platform: balance.platform,
        targetGuildId: balance.guildId, sourceGuildId: ACCOUNT_CONVERSION_BASELINE_SOURCE,
        value: balance.value, kind: 'baseline', updatedAt: now })
    }
    return rows
  }
  // Several independent subjects cannot be losslessly attributed to one
  // guild source after they become shared. Preserve the visible result as a
  // conservative baseline; the operation snapshot retains the discarded
  // source detail for audit without duplicating it in future remaps.
  for (const balance of plan.balances.filter(row => row.subjectId === destination.id)) rows.push({
    systemKey: request.systemKey, subjectId: destination.id, platform: balance.platform,
    targetGuildId: balance.guildId, sourceGuildId: ACCOUNT_CONVERSION_BASELINE_SOURCE,
    value: balance.value, kind: 'baseline', updatedAt: now,
  })
  return rows
}

function periodConversionComponents(
  state: Awaited<ReturnType<typeof readConversionState>>,
  request: AccountConversionRequest,
  plan: Awaited<ReturnType<typeof planScoreModeConversion>>,
  destinations: Array<{ id: string, accountId: string | null }>,
  now: number,
): Array<Omit<PeriodGuildComponent, 'updatedAt'> & { updatedAt: number }> {
  if (state.system.scope !== 'guild') return []
  const rows: Array<Omit<PeriodGuildComponent, 'updatedAt'> & { updatedAt: number }> = []
  const destination = request.nextMode === 'shared'
    ? destinations[0]
    : destinations.find(row => row.accountId === request.retainedAccountId)
  if (!destination) throw new XpPointsUserError('账号转换缺少积分承接主体。')
  const unpack = (row: { subjectId: string, platform: string, guildId: string, value: number }) => {
    const [periodId, platform] = JSON.parse(row.platform) as [string, string]
    return { periodId, platform, subjectId: row.subjectId, targetGuildId: row.guildId, value: row.value }
  }
  if (state.policy.mode === 'shared' && request.nextMode === 'independent') {
    const sourceId = plan.retire[0]
    const sourceRows = state.periodComponents.filter(row => row.subjectId === sourceId)
    for (const row of sourceRows) rows.push({ ...row, subjectId: destination.id, updatedAt: now })
    const existingTargets = new Set(sourceRows.map(row => `${row.periodId}\0${row.targetGuildId}`))
    for (const balance of plan.balances.filter(row => row.subjectId === destination.id)) {
      const item = unpack(balance)
      const key = `${item.periodId}\0${item.targetGuildId}`
      if (existingTargets.has(key)) continue
      rows.push({ periodId: item.periodId, subjectId: destination.id, platform: item.platform,
        targetGuildId: item.targetGuildId, sourceGuildId: ACCOUNT_CONVERSION_BASELINE_SOURCE,
        value: item.value, kind: 'baseline', updatedAt: now })
    }
    return rows
  }
  for (const balance of plan.balances.filter(row => row.subjectId === destination.id)) {
    const item = unpack(balance)
    rows.push({ periodId: item.periodId, subjectId: destination.id, platform: item.platform,
      targetGuildId: item.targetGuildId, sourceGuildId: ACCOUNT_CONVERSION_BASELINE_SOURCE,
      value: item.value, kind: 'baseline', updatedAt: now })
  }
  return rows
}
const hash = (value: unknown) => createHash('sha256').update(serialize(value)).digest('hex')

export async function readConversionState(database: Database, profileId: number, systemKey: string, allowInactive = false) {
  const schema = (await database.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
  if (schema?.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构尚未初始化。')
  const profile = (await database.get('xp_profile', { id: profileId }))[0]
  const system = (await database.get('xp_score_system', { key: systemKey }))[0]
  const preference = (await database.get('xp_person_preference', { profileId }))[0]
  const policy = (await database.get('xp_account_policy', { systemKey, profileId }))[0]
  if (!profile || !system || !preference || !policy) throw new XpPointsUserError('真人、积分系统或账号策略不完整。')
  if (!system.active && !allowInactive) throw new XpPointsUserError('积分系统已停用。')
  const identities = sorted(await database.get('xp_identity', { profileId }))
  const accounts = []
  for (const identity of identities) {
    const account = (await database.get('xp_account', { platform: identity.platform, userId: identity.userId }))[0]
    if (!account) throw new XpPointsUserError('账号记录不完整。')
    accounts.push(account)
  }
  const subjects = sorted(await database.get('xp_score_subject', { profileId, systemKey }))
  const subjectIds = subjects.map(row => row.id)
  const balances = subjectIds.length ? sorted(await database.get('xp_subject_balance', { subjectId: subjectIds })) : []
  const periodScores = subjectIds.length ? sorted(await database.get('xp_period_score', { subjectId: subjectIds })) : []
  const scoreComponents = subjectIds.length ? sorted(await database.get('xp_score_guild_component', { systemKey, subjectId: subjectIds })) : []
  const periodComponents = subjectIds.length ? sorted(await database.get('xp_period_guild_component', { subjectId: subjectIds })) : []
  const periodIds = [...new Set([...periodScores.map(row => row.periodId), ...periodComponents.map(row => row.periodId)])]
  const periodDefinitions = periodIds.length ? sorted(await database.get('xp_period_definition', { id: periodIds })) : []
  const links = subjectIds.length ? sorted(await database.get('xp_journal_subject', { subjectId: subjectIds })) : []
  const journals = links.length ? sorted(await database.get('xp_score_journal', { id: links.map(row => row.journalId) })) : []
  if (journals.length !== links.length) throw new XpPointsUserError('计分主体的流水关联不完整。')
  const aliases = sorted(await database.get('xp_score_guild_alias', { systemKey }))
  for (const balance of balances) {
    if ((system.scope === 'global' && (balance.platform || balance.guildId))
      || (system.scope === 'platform' && (!balance.platform || balance.guildId))
      || (system.scope === 'guild' && (!balance.platform || !balance.guildId))) {
      throw new XpPointsUserError('计分主体积分池与作用域不一致。')
    }
  }
  return { profile, system, preference, policy, identities, accounts: sorted(accounts), subjects, balances, periodScores,
    scoreComponents, periodComponents, periodDefinitions, links, journals, aliases }
}

function validateRequest(request: AccountConversionRequest): void {
  if (!/^XPAC:[A-Za-z0-9-]{8,100}$/.test(request.operationId)
    || !Number.isSafeInteger(request.profileId) || request.profileId <= 0
    || !request.systemKey?.trim() || !request.actor.platform?.trim() || !request.actor.userId?.trim()) {
    throw new XpPointsUserError('账号转换请求无效。')
  }
}

/** Read-only data preview; permission, session binding and occupancy are caller responsibilities. */
export async function previewAccountConversion(database: Database, request: AccountConversionRequest, allowInactive = false) {
  validateRequest(request)
  const state = await readConversionState(database, request.profileId, request.systemKey, allowInactive)
  if (request.actor.kind === 'self' && !state.identities.some(row =>
    row.platform === request.actor.platform && row.userId === request.actor.userId)) {
    throw new XpPointsUserError('只能整理管理员已关联的本人账号。')
  }
  const destinations = request.nextMode === 'shared'
    ? [{ id: 'XPS-' + hash([request.operationId, null]), accountId: null }]
    : state.accounts.map(account => ({ id: 'XPS-' + hash([request.operationId, account.id]), accountId: account.id }))
  const plan = planScoreModeConversion({ mode: state.policy.mode, nextMode: request.nextMode,
    accounts: state.accounts.map(row => row.id), subjects: state.subjects, balances: state.balances,
    destinations, retainedAccountId: request.retainedAccountId, strategy: request.strategy, actor: request.actor.kind })
  const periodPlan = planScoreModeConversion({ mode: state.policy.mode, nextMode: request.nextMode,
    accounts: state.accounts.map(row => row.id), subjects: state.subjects, balances: periodBalances(state.periodScores),
    destinations, retainedAccountId: request.retainedAccountId, strategy: request.periodStrategy ?? 'maximum', actor: request.actor.kind })
  return { request, fingerprint: hash(state), state, destinations, plan, periodPlan }
}

export type AccountConversionPreview = Awaited<ReturnType<typeof previewAccountConversion>>
export interface AccountConversionResult { operationId: string, retiredSubjectIds: string[], subjectIds: string[], deduplicated: boolean }

/**
 * Transaction body only: caller MUST serialize ledger/relationship writes and
 * invoke through database.transact(). Mandatory guard rechecks live authority,
 * session/token ownership and consumer occupancy, including on a retry.
 * Used by the token-confirmed production account operations boundary.
 */
export async function applyAccountConversionIn(
  database: Database,
  request: AccountConversionRequest,
  expectedFingerprint: string,
  assertAllowed: (database: Database, request: AccountConversionRequest) => Promise<void>,
  allowInactive = false,
): Promise<AccountConversionResult> {
  // Minato initializes transactions lazily. Before the first driver access its
  // transact() may swallow callback rejection, so initialize read-only first.
  const schema = (await database.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
  if (schema?.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构尚未初始化。')
  validateRequest(request)
  await assertAllowed(database, request)
  await assertOperationNotErased(database, 'account', request.operationId)
  const previous = (await database.get('xp_account_operation', { id: request.operationId }))[0]
  if (previous) {
    const snapshot = JSON.parse(previous.snapshot)
    if (previous.kind !== 'mode-conversion' || snapshot.version !== 1
      || serialize(snapshot.request) !== serialize(request) || snapshot.fingerprint !== expectedFingerprint) {
      throw new XpPointsUserError('操作 ID 已被其他请求使用。')
    }
    return { ...snapshot.result, deduplicated: true }
  }
  const preview = await previewAccountConversion(database, request, allowInactive)
  if (preview.fingerprint !== expectedFingerprint) throw new XpPointsUserError('账号关系或余额已变化，请重新预览。')
  const { state, plan, destinations, periodPlan } = preview
  const now = new Date()
  // Keep old subjects and journals for audit, but no spendable retired balances.
  await database.remove('xp_subject_balance', { subjectId: plan.retire })
  await database.remove('xp_score_guild_component', { subjectId: plan.retire })
  await database.remove('xp_period_guild_component', { subjectId: plan.retire })
  await database.set('xp_score_subject', { id: plan.retire }, { active: false, retiredAt: now })
  for (const destination of destinations) await database.create('xp_score_subject', {
    ...destination, profileId: request.profileId, systemKey: request.systemKey, active: true, createdAt: now, retiredAt: null,
  })
  if (plan.balances.length) await database.upsert('xp_subject_balance', plan.balances.map(row => ({ ...row, updatedAt: now })))
  const scoreComponents = scoreConversionComponents(state, request, plan, destinations, now)
  for (const row of scoreComponents) await database.create('xp_score_guild_component', row)
  const periodDestination = request.nextMode === 'shared' ? destinations[0].id : destinations.find(d => d.accountId === request.retainedAccountId)!.id
  await writePeriodConversionIn(database, { operationId: request.operationId, sourceIds: plan.retire, before: state.periodScores,
    after: withZeroPeriodBalances(periodPlan, periodDestination), strategy: request.periodStrategy ?? 'maximum' })
  const periodComponents = periodConversionComponents(state, request, periodPlan, destinations, now.getTime())
  for (const row of periodComponents) await database.create('xp_period_guild_component', row)
  await database.set('xp_account_policy', { profileId: request.profileId, systemKey: request.systemKey }, {
    mode: request.nextMode, revision: state.policy.revision + 1,
  })
  const result: AccountConversionResult = { operationId: request.operationId, retiredSubjectIds: plan.retire,
    subjectIds: destinations.map(row => row.id), deduplicated: false }
  await database.create('xp_account_operation', {
    id: request.operationId, kind: 'mode-conversion', actorPlatform: request.actor.platform, actorUserId: request.actor.userId,
    createdAt: now, snapshot: serialize({ version: 1, request, fingerprint: expectedFingerprint,
      previousPolicy: state.policy, sources: state.subjects.filter(row => row.active),
      sourceBalances: state.balances, destinations, plan, result }),
  })
  return result
}
