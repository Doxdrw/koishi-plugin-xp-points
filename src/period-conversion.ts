import type { Context } from 'koishi'
import type { PeriodScore } from './period-model'
import type { SubjectBalance, ConversionPlan } from './account-policy'

/** Reuse validated score conversion arithmetic, giving each period its own pool. */
export function periodBalances(rows: readonly PeriodScore[]): SubjectBalance[] {
  return rows.map(row => ({ subjectId: row.subjectId, platform: JSON.stringify([row.periodId, row.platform]), guildId: row.guildId, value: row.value }))
}
export function unpackPeriodBalance(row: SubjectBalance): PeriodScore {
  const [periodId, platform] = JSON.parse(row.platform)
  return { periodId, platform, subjectId: row.subjectId, guildId: row.guildId, value: row.value, updatedAt: Date.now() }
}
export async function writePeriodConversionIn(db: Context['database'], input: {
  operationId: string; sourceIds: string[]; before: PeriodScore[]; after: SubjectBalance[]; strategy: string
}) {
  if (!input.before.length) return
  const after = input.after.map(unpackPeriodBalance)
  await db.remove('xp_period_score', { subjectId: input.sourceIds })
  if (after.length) await db.upsert('xp_period_score', after)
  for (const id of new Set(input.before.map(r => r.periodId))) await db.set('xp_period_definition', { id }, { revisedAt: Date.now() })
  await db.create('xp_period_adjustment', { operationId: input.operationId, createdAt: Date.now(),
    snapshot: JSON.stringify({ strategy: input.strategy, before: input.before, after }) })
}
export function withZeroPeriodBalances(plan: ConversionPlan, destinationId: string): SubjectBalance[] {
  return [...plan.balances, ...plan.pools.filter(p => p.value === 0).map(p => ({ subjectId: destinationId, platform: p.platform, guildId: p.guildId, value: 0 }))]
}
