import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import { normalizePeriodConfig, scorePeriodWindow, zonedDayStart, parsePeriodDate, type ScorePeriodConfig, type ScorePeriodKind } from './period-calendar'
import type { PeriodDefinition, PeriodPolicy } from './period-model'
import { applyPeriodGuildComponentDeltaIn, getGuildAliasPolicyIn } from './guild-alias-components'
type Database = Context['database']
interface Revision { effectiveAt: number; config: Required<ScorePeriodConfig> }
export interface CompetitiveContext {
  competitive?: boolean
  /** Explicit timestamp only; omitted means actual mutation time. */
  effectiveAt?: number
  businessId?: string
}
const kinds: ScorePeriodKind[] = ['day', 'week', 'month', 'year', 'season']
const configEqual = (a: ScorePeriodConfig, b: ScorePeriodConfig) => JSON.stringify(normalizePeriodConfig(a)) === JSON.stringify(normalizePeriodConfig(b))
function revisions(policy: PeriodPolicy): Revision[] { return JSON.parse(policy.revisions) }
function configAt(policy: PeriodPolicy, at: number): Revision {
  const changes = revisions(policy)
  return [...changes].reverse().find(r => r.effectiveAt <= at) ?? changes[0]
}
const finite = (...values: number[]) => { if (values.some(v => !Number.isFinite(v))) throw new Error('周期成绩必须是有限数值。') }

export async function periodDateIn(db: Database, systemKey: string, raw: string): Promise<number> {
  const policy = (await db.get('xp_period_policy', { systemKey }))[0]
  if (!policy) throw new Error('此系统尚未初始化周期榜。')
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    parsePeriodDate(raw)
    const candidates = revisions(policy).map(r => zonedDayStart(raw, r.config.timeZone))
    for (const at of candidates) if (zonedDayStart(raw, configAt(policy, at).config.timeZone) === at) return at
    throw new Error('此日期跨越时区配置变更，请提供带时区的完整ISO时间。')
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) throw new Error('成绩日期请用YYYY-MM-DD或带时区的ISO时间。')
  parsePeriodDate(raw.slice(0, 10))
  const at = Date.parse(raw); finite(at); return at
}

/** Called inside the owning service's write queue and transaction only. */
export async function configurePeriodsIn(db: Database, systemKey: string, input: ScorePeriodConfig = {}, now = Date.now()) {
  const config = normalizePeriodConfig(input)
  let policy = (await db.get('xp_period_policy', { systemKey }))[0]
  if (!policy) {
    policy = await db.create('xp_period_policy', { systemKey, enabledAt: now, revision: 0,
      revisions: JSON.stringify([{ effectiveAt: now, config }]) })
    return policy
  }
  const changes = revisions(policy), active = configAt(policy, now)
  if (configEqual(changes.at(-1)!.config, config)) return policy
  // Configuration takes effect at the end of the current season. Preserve every
  // effective revision; only replace an unapplied future setting.
  const current = scorePeriodWindow('season', now, active.config)
  const effectiveAt = current?.end ?? now
  const kept = changes.filter(r => r.effectiveAt <= now)
  if (!configEqual(active.config, config)) kept.push({ effectiveAt, config })
  await db.set('xp_period_policy', { systemKey }, { revisions: JSON.stringify(kept), revision: policy.revision + 1 })
  return { ...policy, revisions: JSON.stringify(kept), revision: policy.revision + 1 }
}

export async function resolvePeriodIn(db: Database, systemKey: string, kind: ScorePeriodKind, at: number, allowBackfill = false): Promise<PeriodDefinition | undefined> {
  const policy = (await db.get('xp_period_policy', { systemKey }))[0]
  if (!policy) return
  const fixed = (await db.get('xp_period_definition', { systemKey, kind, start: { $lte: at }, end: { $gt: at } }, { sort: { start: 'desc' }, limit: 1 }))[0]
  if (fixed) return fixed
  if (at < policy.enabledAt && !allowBackfill) return
  const revision = configAt(policy, at), changes = revisions(policy)
  const next = changes.find(r => r.effectiveAt > revision.effectiveAt)
  const window = scorePeriodWindow(kind, at, revision.config)
  if (!window) return
  // A new config cannot extend backwards into the prior fixed season/calendar.
  const start = Math.max(window.start, revision.effectiveAt === policy.enabledAt ? window.start : revision.effectiveAt)
  const end = Math.min(window.end, next?.effectiveAt ?? Infinity)
  const id = createHash('sha256').update(JSON.stringify([systemKey, kind, start, end, revision.config.timeZone])).digest('hex')
  const existing = (await db.get('xp_period_definition', { id }))[0]
  if (existing) return existing
  return db.create('xp_period_definition', { id, systemKey, kind, start, end, label: window.label,
    timeZone: revision.config.timeZone, incomplete: policy.enabledAt > start || start !== window.start || end !== window.end, revisedAt: 0 })
}

export async function recordCompetitiveIn(db: Database, input: {
  systemKey: string; subjectId: string; platform: string; guildId: string; originGuildId?: string; delta: number; journalId: number; context: CompetitiveContext; now: number
}) {
  const { context, now } = input
  const effectiveAt = context.effectiveAt ?? now
  finite(input.delta, effectiveAt, now)
  if (effectiveAt > now) throw new Error('不能把竞技成绩记入未来时间。')
  if (context.businessId && context.businessId.length > 200) throw new Error('竞技业务关联标识过长。')
  const policy = (await db.get('xp_period_policy', { systemKey: input.systemKey }))[0]
  if (!policy) return // Old/test caller not opted into period initialization.
  await db.create('xp_period_journal', { journalId: input.journalId, competitive: context.competitive !== false,
    effectiveAt, businessId: context.businessId ?? '', delta: input.delta })
  if (context.competitive === false) return
  for (const kind of kinds) {
    const period = await resolvePeriodIn(db, input.systemKey, kind, effectiveAt, context.effectiveAt !== undefined)
    if (!period) continue
    const query = { periodId: period.id, subjectId: input.subjectId, platform: input.platform, guildId: input.guildId }
    const old = (await db.get('xp_period_score', query))[0]?.value ?? 0
    const value = old + input.delta
    finite(old, value)
    let nextValue = value
    const system = (await db.get('xp_score_system', { key: input.systemKey }))[0]
    if (system?.scope === 'guild') {
      const policy = await getGuildAliasPolicyIn(db, input.systemKey, input.platform)
      nextValue = await applyPeriodGuildComponentDeltaIn({
        database: db,
        periodId: period.id,
        subjectId: input.subjectId,
        platform: input.platform,
        targetGuildId: input.guildId,
        sourceGuildId: input.originGuildId ?? input.guildId,
        before: old,
        delta: input.delta,
        strategy: policy.period,
        now,
      })
      finite(nextValue)
    }
    await db.upsert('xp_period_score', [{ ...query, value: nextValue, updatedAt: now }])
    await db.set('xp_period_definition', { id: period.id }, { revisedAt: now })
  }
}

/** Retry has already been checked for amount and target by the balance ledger. */
export async function validateCompetitiveRetry(db: Database, journalId: number, context: CompetitiveContext) {
  const old = (await db.get('xp_period_journal', { journalId }))[0]
  if (!old) {
    if (context.effectiveAt !== undefined || context.competitive === true || context.businessId) throw new Error('历史积分流水没有周期元数据，不能通过重试补记竞技成绩。')
    return
  }
  if (old.competitive !== (context.competitive !== false) || context.effectiveAt !== undefined && old.effectiveAt !== context.effectiveAt
    || old.businessId !== (context.businessId ?? '')) throw new Error('重复积分请求的竞技时间或标记与原记录不一致。')
}
