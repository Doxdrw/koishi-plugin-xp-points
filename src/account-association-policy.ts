import { XpPointsUserError } from './errors'
import type { AccountScoreMode, ConversionSubject, ScoreCombineStrategy, SubjectBalance } from './account-policy'

/** One complete person's state in ONE system. Never pass an account subset. */
export interface AssociationPerson {
  profileId: number
  mode: AccountScoreMode
  accounts: readonly string[]
  subjects: readonly ConversionSubject[]
  balances: readonly SubjectBalance[]
  /** Required when this shared person's balance becomes independent. */
  retainedAccountId?: string
}

export interface PersonAssociationInput {
  kind: 'merge-persons'
  source: AssociationPerson
  target: AssociationPerson
  nextMode: AccountScoreMode
  strategy: ScoreCombineStrategy
  destinations: readonly { id: string, accountId: string | null }[]
}

export interface PersonAssociationPlan {
  kind: 'merge-persons'
  sourceProfileId: number
  targetProfileId: number
  accountIds: string[]
  retire: string[]
  balances: SubjectBalance[]
  pools: Array<{
    platform: string
    guildId: string
    sources: Array<{ profileId: number, subjectId: string, accountId: string | null, value: number }>
    destinations: Array<{ subjectId: string, accountId: string | null, value: number }>
    /** Explicit warning data; never silently discard a negative balance. */
    discardedNegativeSources: Array<{ subjectId: string, value: number }>
  }>
}

const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function ids(values: readonly string[], label: string): Set<string> {
  if (values.some(value => typeof value !== 'string' || !value.trim())) throw new XpPointsUserError(`${label}不能为空。`)
  const result = new Set(values)
  if (result.size !== values.length) throw new XpPointsUserError(`${label}重复。`)
  return result
}
function finite(value: number): number {
  if (!Number.isFinite(value)) throw new XpPointsUserError('积分超出有限数值范围。')
  return value
}

/**
 * Pure impact calculation, NOT an authorization or mutation entry point.
 * The transaction must verify actual administrator authority, the complete
 * two-person snapshot, all systems and occupancy before consuming any plan.
 * Single-account movement is intentionally a distinct future transaction.
 * Historical journals/retired balances are never a source of merge points.
 */
export function planPersonAssociation(input: PersonAssociationInput): PersonAssociationPlan {
  if (input.kind !== 'merge-persons') throw new XpPointsUserError('请选择明确的两真人档案合并操作。')
  if (!['shared', 'independent'].includes(input.nextMode)) throw new XpPointsUserError('未知账号积分模式。')
  if (!['maximum', 'sum'].includes(input.strategy)) throw new XpPointsUserError('未知积分合并策略。')
  const people = [input.source, input.target]
  if (people.some(person => !Number.isSafeInteger(person.profileId) || person.profileId <= 0)
    || input.source.profileId === input.target.profileId) throw new XpPointsUserError('必须选择两个不同的有效真人档案。')
  const allAccounts = ids(people.flatMap(person => [...person.accounts]), '关联账号')
  const allSubjectIds = ids(people.flatMap(person => person.subjects.map(subject => subject.id)), '原计分主体')
  const active: Array<ConversionSubject & { profileId: number, recipient: string | null }> = []
  const poolValues = new Map<string, { platform: string, guildId: string, values: Map<string, number> }>()
  for (const person of people) {
    if (!['shared', 'independent'].includes(person.mode)) throw new XpPointsUserError('未知原账号积分模式。')
    const accounts = new Set(person.accounts)
    if (!accounts.size) throw new XpPointsUserError('真人档案没有账号。')
    const current = person.subjects.filter(subject => subject.active)
    if (person.mode === 'shared') {
      if (current.length !== 1 || current[0].accountId !== null) throw new XpPointsUserError('共享计分主体不完整。')
      if (input.nextMode === 'independent' && !accounts.has(person.retainedAccountId!)) {
        throw new XpPointsUserError('请为每个原共享档案明确指定承接账号。')
      }
    } else if (current.length !== accounts.size
      || new Set(current.map(subject => subject.accountId)).size !== accounts.size
      || current.some(subject => subject.accountId === null || !accounts.has(subject.accountId))) {
      throw new XpPointsUserError('独立计分主体必须与账号一一对应。')
    }
    const currentIds = new Set(current.map(subject => subject.id))
    for (const subject of current) active.push({ ...subject, profileId: person.profileId,
      recipient: person.mode === 'shared' ? person.retainedAccountId ?? null : subject.accountId })
    for (const balance of person.balances) {
      if (!currentIds.has(balance.subjectId)) throw new XpPointsUserError('余额包含退休或无关计分主体。')
      if (typeof balance.platform !== 'string' || typeof balance.guildId !== 'string') throw new XpPointsUserError('积分池无效。')
      finite(balance.value)
      const key = JSON.stringify([balance.platform, balance.guildId])
      let pool = poolValues.get(key)
      if (!pool) poolValues.set(key, pool = { platform: balance.platform, guildId: balance.guildId, values: new Map() })
      if (pool.values.has(balance.subjectId)) throw new XpPointsUserError('同一积分池余额重复。')
      pool.values.set(balance.subjectId, balance.value)
    }
  }
  const newIds = ids(input.destinations.map(subject => subject.id), '新计分主体')
  if ([...newIds].some(id => allSubjectIds.has(id))) throw new XpPointsUserError('不能复用已存在的计分主体。')
  if (input.nextMode === 'shared') {
    if (input.destinations.length !== 1 || input.destinations[0].accountId !== null) throw new XpPointsUserError('必须提供一个新的共享计分主体。')
  } else if (input.destinations.length !== allAccounts.size
    || new Set(input.destinations.map(subject => subject.accountId)).size !== allAccounts.size
    || input.destinations.some(subject => subject.accountId === null || !allAccounts.has(subject.accountId))) {
    throw new XpPointsUserError('新的独立计分主体必须与全部账号一一对应。')
  }
  active.sort((a, b) => ordered(a.id, b.id))
  const destinations = [...input.destinations].sort((a, b) => ordered(a.id, b.id))
  const plan: PersonAssociationPlan = { kind: 'merge-persons', sourceProfileId: input.source.profileId,
    targetProfileId: input.target.profileId, accountIds: [...allAccounts].sort(ordered),
    retire: active.map(subject => subject.id), balances: [], pools: [] }
  for (const [, pool] of [...poolValues].sort(([a], [b]) => ordered(a, b))) {
    const sources = active.map(subject => ({ profileId: subject.profileId, subjectId: subject.id,
      accountId: subject.accountId, value: pool.values.get(subject.id) ?? 0 }))
    const values = input.nextMode === 'shared'
      ? [input.strategy === 'maximum' ? Math.max(...sources.map(source => source.value))
        : sources.reduce((total, source) => finite(total + source.value), 0)]
      : destinations.map(destination => {
        const source = active.find(subject => subject.recipient === destination.accountId)
        return source ? pool.values.get(source.id) ?? 0 : 0
      })
    if (input.nextMode === 'shared') sources.forEach(source => finite(values[0] - source.value))
    const outputs = destinations.map((destination, index) => ({ subjectId: destination.id,
      accountId: destination.accountId, value: finite(values[index]) }))
    const discardedNegativeSources = input.nextMode === 'shared' && input.strategy === 'maximum'
      ? sources.filter(source => source.value < 0 && source.value !== values[0])
        .map(({ subjectId, value }) => ({ subjectId, value })) : []
    plan.pools.push({ platform: pool.platform, guildId: pool.guildId, sources,
      destinations: outputs, discardedNegativeSources })
    for (const output of outputs) if (output.value !== 0) plan.balances.push({ subjectId: output.subjectId,
      platform: pool.platform, guildId: pool.guildId, value: output.value })
  }
  return plan
}
