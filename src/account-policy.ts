import { XpPointsUserError } from './errors'
/** Account relationships and balances are deliberately separate concepts. */
export type AccountScoreMode = 'shared' | 'independent'
export type ScoreCombineStrategy = 'maximum' | 'sum'

/** Existing per-system choices are valid even when mixed; never rewrite them. */
export function resolveDefaultScoreMode(stored: AccountScoreMode | null | undefined,
  modes: readonly AccountScoreMode[], fallback: AccountScoreMode = 'shared'): AccountScoreMode {
  if (stored != null && !['shared', 'independent'].includes(stored)) throw new XpPointsUserError('真人默认计分方式无效。')
  if (!['shared', 'independent'].includes(fallback) || modes.some(mode => !['shared', 'independent'].includes(mode))) {
    throw new XpPointsUserError('账号计分方式无效。')
  }
  return stored ?? (modes.length && modes.every(mode => mode === modes[0]) ? modes[0] : fallback)
}

export interface SubjectBalance {
  subjectId: string
  platform: string
  guildId: string
  value: number
}

export interface ConversionSubject {
  id: string
  accountId: string | null
  active: boolean
}

export interface ConversionInput {
  mode: AccountScoreMode
  nextMode: AccountScoreMode
  accounts: readonly string[]
  subjects: readonly ConversionSubject[]
  balances: readonly SubjectBalance[]
  /** Fresh subject IDs: never reuse a retired balance owner. */
  destinations: readonly { id: string, accountId: string | null }[]
  retainedAccountId?: string
  strategy: ScoreCombineStrategy
  actor: 'self' | 'administrator'
}

export interface ConversionPlan {
  retire: string[]
  balances: SubjectBalance[]
  /** Audit of every source, including zero and negative balances. */
  pools: Array<{
    platform: string
    guildId: string
    sources: Array<{ subjectId: string, value: number }>
    value: number
  }>
}

function unique(values: readonly string[], label: string): Set<string> {
  if (values.some(value => !value?.trim())) throw new XpPointsUserError(`${label}不能为空。`)
  const result = new Set(values)
  if (result.size !== values.length) throw new XpPointsUserError(`${label}重复。`)
  return result
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new XpPointsUserError('积分超出有限数值范围。')
  return value
}

/**
 * Pure, validated conversion preview. Caller supplies one system only; a single
 * transaction must consume this plan and retire its sources. Period balances
 * use the same operation independently, never as fresh competitive rewards.
 */
export function planScoreModeConversion(input: ConversionInput): ConversionPlan {
  if (!['shared', 'independent'].includes(input.mode)
    || !['shared', 'independent'].includes(input.nextMode)) throw new XpPointsUserError('未知账号积分模式。')
  if (!['maximum', 'sum'].includes(input.strategy)) throw new XpPointsUserError('未知积分合并策略。')
  if (!['self', 'administrator'].includes(input.actor)) throw new XpPointsUserError('未知操作身份。')
  if (input.mode === input.nextMode) throw new XpPointsUserError('账号积分模式没有变化。')
  const accounts = unique(input.accounts, '账号')
  if (!accounts.size) throw new XpPointsUserError('没有可转换的账号。')
  const allIds = unique(input.subjects.map(subject => subject.id), '计分主体')
  const active = input.subjects.filter(subject => subject.active)
  if (input.mode === 'shared') {
    if (active.length !== 1 || active[0].accountId !== null) throw new XpPointsUserError('共享计分主体不完整。')
  } else {
    const assigned = new Set(active.map(subject => subject.accountId))
    if (active.length !== accounts.size || assigned.size !== accounts.size
      || active.some(subject => subject.accountId === null || !accounts.has(subject.accountId))) {
      throw new XpPointsUserError('独立计分主体必须与账号一一对应。')
    }
  }
  const destinations = unique(input.destinations.map(subject => subject.id), '新计分主体')
  if ([...destinations].some(id => allIds.has(id))) throw new XpPointsUserError('不能复用已存在的计分主体。')
  if (input.nextMode === 'shared') {
    if (input.destinations.length !== 1 || input.destinations[0].accountId !== null) {
      throw new XpPointsUserError('必须提供一个新的共享计分主体。')
    }
  } else {
    const assigned = new Set(input.destinations.map(subject => subject.accountId))
    if (assigned.size !== accounts.size || input.destinations.length !== accounts.size
      || input.destinations.some(subject => subject.accountId === null || !accounts.has(subject.accountId))) {
      throw new XpPointsUserError('新的独立计分主体必须与账号一一对应。')
    }
    if (!input.retainedAccountId || !accounts.has(input.retainedAccountId)) {
      throw new XpPointsUserError('请指定承接原共享积分的账号。')
    }
  }
  if (input.actor === 'self' && input.strategy !== 'maximum') throw new XpPointsUserError('本人合并只能取最高分。')
  const activeIds = new Set(active.map(subject => subject.id))
  const pools = new Map<string, { platform: string, guildId: string, values: Map<string, number> }>()
  for (const balance of input.balances) {
    if (!activeIds.has(balance.subjectId)) throw new XpPointsUserError('余额包含退休或无关计分主体。')
    finite(balance.value)
    if (input.actor === 'self' && balance.value < 0) throw new XpPointsUserError('存在负分，请联系管理员处理。')
    const key = JSON.stringify([balance.platform, balance.guildId])
    let pool = pools.get(key)
    if (!pool) pools.set(key, pool = { platform: balance.platform, guildId: balance.guildId, values: new Map() })
    if (pool.values.has(balance.subjectId)) throw new XpPointsUserError('同一积分池余额重复。')
    pool.values.set(balance.subjectId, balance.value)
  }
  const plan: ConversionPlan = { retire: active.map(subject => subject.id).sort(), balances: [], pools: [] }
  const destination = input.nextMode === 'shared'
    ? input.destinations[0].id
    : input.destinations.find(subject => subject.accountId === input.retainedAccountId)!.id
  for (const [, pool] of [...pools].sort(([left], [right]) => left.localeCompare(right))) {
    const sources = active.map(subject => ({ subjectId: subject.id, value: pool.values.get(subject.id) ?? 0 }))
      .sort((left, right) => left.subjectId.localeCompare(right.subjectId))
    const value = input.mode === 'shared' ? sources[0].value
      : input.strategy === 'maximum' ? Math.max(...sources.map(source => source.value))
        : sources.reduce((total, source) => finite(total + source.value), 0)
    // An overflowing difference also cannot be represented in a finite audit.
    sources.forEach(source => finite(value - source.value))
    plan.pools.push({ platform: pool.platform, guildId: pool.guildId, sources, value })
    if (value !== 0) plan.balances.push({ subjectId: destination, platform: pool.platform, guildId: pool.guildId, value })
  }
  return plan
}
