import { XpPointsUserError } from './errors'

/** How values from several source pools are combined at a new target pool. */
export type GuildAliasCombineStrategy = 'maximum' | 'sum'

export interface GuildAliasPolicy {
  balance: GuildAliasCombineStrategy
  period: GuildAliasCombineStrategy
}

export interface GuildAliasValue {
  key: string
  value: number
}

export function normalizeGuildAliasStrategy(value: unknown, label = '群挂靠合并策略'): GuildAliasCombineStrategy {
  if (value === 'maximum' || value === 'sum') return value
  throw new XpPointsUserError(`${label}必须是 maximum（取最高）或 sum（累加）。`)
}

export function normalizeGuildAliasPolicy(input?: Partial<GuildAliasPolicy>): GuildAliasPolicy {
  return {
    balance: input?.balance === undefined ? 'maximum' : normalizeGuildAliasStrategy(input.balance, '累计积分合并策略'),
    period: input?.period === undefined ? 'maximum' : normalizeGuildAliasStrategy(input.period, '周期成绩合并策略'),
  }
}

export function combineGuildAliasValues(values: readonly number[], strategy: GuildAliasCombineStrategy): number {
  if (!values.length) return 0
  if (!values.every(Number.isFinite)) throw new XpPointsUserError('群挂靠合并包含非有限数值，操作已取消。')
  const result = strategy === 'sum' ? values.reduce((total, value) => total + value, 0) : Math.max(...values)
  if (!Number.isFinite(result)) throw new XpPointsUserError('群挂靠合并结果超出有限数值范围，操作已取消。')
  return result
}

/** Deterministic, side-effect-free plan primitive used by online and offline paths. */
export function planGuildAliasValues(
  values: readonly GuildAliasValue[],
  strategy: GuildAliasCombineStrategy,
): { before: number, after: number, values: GuildAliasValue[] } {
  const normalized = values.map(row => {
    if (!row.key.trim() || !Number.isFinite(row.value)) throw new XpPointsUserError('群挂靠合并输入无效。')
    return { key: row.key, value: row.value }
  }).sort((left, right) => left.key.localeCompare(right.key))
  const before = combineGuildAliasValues(normalized.map(row => row.value), strategy)
  return { before, after: before, values: normalized }
}
