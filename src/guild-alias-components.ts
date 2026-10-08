import type { Context } from 'koishi'
import { XpPointsUserError } from './errors'
import { combineGuildAliasValues, normalizeGuildAliasPolicy, type GuildAliasCombineStrategy, type GuildAliasPolicy } from './guild-alias-policy'

type Database = Context['database']

export const TARGET_ADJUSTMENT_SOURCE = '__target_adjustment__'
// Stable source marker for a baseline synthesized when a visible score has no
// component rows.
export const BASELINE_SOURCE = '__baseline__'

interface ComponentRow {
  targetGuildId: string
  sourceGuildId: string
  value: number
  kind?: string
}

export async function getGuildAliasPolicyIn(database: Database, systemKey: string, platform: string): Promise<GuildAliasPolicy> {
  const row = (await database.get('xp_score_guild_alias_policy', { systemKey, platform }))[0]
  return normalizeGuildAliasPolicy({ balance: row?.balanceStrategy, period: row?.periodStrategy })
}

function checkFinite(value: number): number {
  if (!Number.isFinite(value)) throw new XpPointsUserError('群挂靠组件包含非有限数值，操作已取消。')
  return value
}

function baseRows(rows: ComponentRow[]) {
  return rows.filter(row => row.kind !== 'adjustment' && row.kind !== 'override')
}

function adjustments(rows: ComponentRow[]) {
  return rows.filter(row => row.kind === 'adjustment').reduce((sum, row) => sum + checkFinite(row.value), 0)
}

export function aggregateGuildComponents(rows: ComponentRow[], strategy: GuildAliasCombineStrategy): number {
  const override = rows.find(row => row.kind === 'override')
  if (override) return checkFinite(override.value)
  const base = combineGuildAliasValues(baseRows(rows).map(row => checkFinite(row.value)), strategy)
  const result = base + adjustments(rows)
  return checkFinite(result)
}

async function ensureScoreBaselineIn(
  database: Database,
  systemKey: string,
  subjectId: string,
  platform: string,
  targetGuildId: string,
  current: number,
  strategy: GuildAliasCombineStrategy,
): Promise<ComponentRow[]> {
  let rows = await database.get('xp_score_guild_component', { systemKey, subjectId, platform, targetGuildId }) as ComponentRow[]
  if (!rows.length) {
    if (current !== 0) {
      await database.create('xp_score_guild_component', {
        systemKey, subjectId, platform, targetGuildId, sourceGuildId: BASELINE_SOURCE,
        value: checkFinite(current), kind: 'baseline', updatedAt: new Date(),
      })
    }
    return rows
  }
  const aggregate = aggregateGuildComponents(rows, strategy)
  const difference = current - aggregate
  checkFinite(difference)
  if (difference !== 0) {
    const query = { systemKey, subjectId, platform, targetGuildId, sourceGuildId: TARGET_ADJUSTMENT_SOURCE }
    const existing = (await database.get('xp_score_guild_component', query))[0]
    const value = (existing?.value ?? 0) + difference
    checkFinite(value)
    if (existing) await database.set('xp_score_guild_component', query, { value, kind: 'adjustment', updatedAt: new Date() })
    else await database.create('xp_score_guild_component', { ...query, value, kind: 'adjustment', updatedAt: new Date() })
  }
  rows = await database.get('xp_score_guild_component', { systemKey, subjectId, platform, targetGuildId }) as ComponentRow[]
  return rows
}

export async function applyScoreGuildComponentMutationIn(input: {
  database: Database
  systemKey: string
  subjectId: string
  platform: string
  targetGuildId: string
  sourceGuildId: string
  before: number
  targetAfter: number
  operation: 'add' | 'set'
  amount: number
  strategy: GuildAliasCombineStrategy
  now?: Date
}): Promise<number> {
  const { database, systemKey, subjectId, platform, targetGuildId, sourceGuildId, strategy } = input
  const now = input.now ?? new Date()
  checkFinite(input.before); checkFinite(input.targetAfter); checkFinite(input.amount)
  const currentRows = await ensureScoreBaselineIn(database, systemKey, subjectId, platform, targetGuildId, input.before, strategy)
  const sourceQuery = { systemKey, subjectId, platform, targetGuildId, sourceGuildId: sourceGuildId || targetGuildId }
  const adjustmentQuery = { systemKey, subjectId, platform, targetGuildId, sourceGuildId: TARGET_ADJUSTMENT_SOURCE }
  const sourceRow = (await database.get('xp_score_guild_component', sourceQuery))[0]
  const adjustmentRow = (await database.get('xp_score_guild_component', adjustmentQuery))[0]
  if (input.operation === 'add') {
    const sourceValue = (sourceRow?.value ?? 0) + input.amount
    checkFinite(sourceValue)
    if (sourceRow) await database.set('xp_score_guild_component', sourceQuery, { value: sourceValue, kind: sourceRow.kind ?? 'source', updatedAt: now })
    else await database.create('xp_score_guild_component', { ...sourceQuery, value: sourceValue, kind: 'source', updatedAt: now })
  }
  const rows = await database.get('xp_score_guild_component', { systemKey, subjectId, platform, targetGuildId }) as ComponentRow[]
  const base = combineGuildAliasValues(baseRows(rows).map(row => checkFinite(row.value)), strategy)
  const adjustmentWithoutCurrent = rows.filter(row => row.kind === 'adjustment' && row.sourceGuildId !== TARGET_ADJUSTMENT_SOURCE)
    .reduce((sum, row) => sum + checkFinite(row.value), 0)
  const requiredAdjustment = input.targetAfter - base - adjustmentWithoutCurrent
  checkFinite(requiredAdjustment)
  if (adjustmentRow) {
    if (requiredAdjustment === 0) await database.remove('xp_score_guild_component', adjustmentQuery)
    else await database.set('xp_score_guild_component', adjustmentQuery, { value: requiredAdjustment, kind: 'adjustment', updatedAt: now })
  } else if (requiredAdjustment !== 0) {
    await database.create('xp_score_guild_component', { ...adjustmentQuery, value: requiredAdjustment, kind: 'adjustment', updatedAt: now })
  }
  return input.targetAfter
}

export async function applyPeriodGuildComponentDeltaIn(input: {
  database: Database
  periodId: string
  subjectId: string
  platform: string
  targetGuildId: string
  sourceGuildId: string
  before: number
  delta: number
  strategy: GuildAliasCombineStrategy
  now?: number
}): Promise<number> {
  const { database, periodId, subjectId, platform, targetGuildId, strategy } = input
  const now = input.now ?? Date.now()
  checkFinite(input.before); checkFinite(input.delta)
  let rows = await database.get('xp_period_guild_component', { periodId, subjectId, platform, targetGuildId }) as ComponentRow[]
  if (!rows.length) {
    if (input.before !== 0) {
      await database.create('xp_period_guild_component', {
        periodId, subjectId, platform, targetGuildId, sourceGuildId: BASELINE_SOURCE,
        value: checkFinite(input.before), kind: 'baseline', updatedAt: now,
      })
    }
    rows = await database.get('xp_period_guild_component', { periodId, subjectId, platform, targetGuildId }) as ComponentRow[]
  } else {
    const aggregate = aggregateGuildComponents(rows, strategy)
    const difference = input.before - aggregate
    checkFinite(difference)
    if (difference !== 0) {
      const query = { periodId, subjectId, platform, targetGuildId, sourceGuildId: TARGET_ADJUSTMENT_SOURCE }
      const old = (await database.get('xp_period_guild_component', query))[0]
      const value = (old?.value ?? 0) + difference
      checkFinite(value)
      if (old) await database.set('xp_period_guild_component', query, { value, kind: 'adjustment', updatedAt: now })
      else await database.create('xp_period_guild_component', { ...query, value, kind: 'adjustment', updatedAt: now })
      rows = await database.get('xp_period_guild_component', { periodId, subjectId, platform, targetGuildId }) as ComponentRow[]
    }
  }
  const source = input.sourceGuildId || targetGuildId
  const query = { periodId, subjectId, platform, targetGuildId, sourceGuildId: source }
  const existing = (await database.get('xp_period_guild_component', query))[0]
  const sourceValue = (existing?.value ?? 0) + input.delta
  checkFinite(sourceValue)
  if (existing) await database.set('xp_period_guild_component', query, { value: sourceValue, kind: existing.kind ?? 'source', updatedAt: now })
  else await database.create('xp_period_guild_component', { ...query, value: sourceValue, kind: 'source', updatedAt: now })
  const rowsAfter = await database.get('xp_period_guild_component', { periodId, subjectId, platform, targetGuildId }) as ComponentRow[]
  const afterBase = combineGuildAliasValues(baseRows(rowsAfter).map(row => checkFinite(row.value)), strategy)
  const otherAdjustments = rowsAfter.filter(row => row.kind === 'adjustment' && row.sourceGuildId !== TARGET_ADJUSTMENT_SOURCE)
    .reduce((sum, row) => sum + checkFinite(row.value), 0)
  const targetAfter = input.before + input.delta
  const requiredAdjustment = targetAfter - afterBase - otherAdjustments
  checkFinite(requiredAdjustment)
  const adjustmentQuery = { periodId, subjectId, platform, targetGuildId, sourceGuildId: TARGET_ADJUSTMENT_SOURCE }
  const adjustmentRow = (await database.get('xp_period_guild_component', adjustmentQuery))[0]
  if (adjustmentRow) {
    if (requiredAdjustment === 0) await database.remove('xp_period_guild_component', adjustmentQuery)
    else await database.set('xp_period_guild_component', adjustmentQuery, { value: requiredAdjustment, kind: 'adjustment', updatedAt: now })
  } else if (requiredAdjustment !== 0) {
    await database.create('xp_period_guild_component', { ...adjustmentQuery, value: requiredAdjustment, kind: 'adjustment', updatedAt: now })
  }
  return targetAfter
}
