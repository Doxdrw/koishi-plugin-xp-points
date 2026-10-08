import { XpPointsUserError } from './errors'
import { randomBytes } from 'node:crypto'

export interface AccountInteractionActor {
  platform: string
  userId: string
  selfId: string
  channelId: string
  isDirect: boolean
}

function actorKey(actor: AccountInteractionActor): string {
  if (![actor.platform, actor.userId, actor.selfId, actor.channelId].every(value => typeof value === 'string' && value.length > 0)
    || typeof actor.isDirect !== 'boolean') throw new XpPointsUserError('确认会话信息不完整。')
  return JSON.stringify([actor.platform, actor.selfId, actor.isDirect, actor.channelId, actor.userId])
}

interface Confirmation<T> {
  actorKey: string
  expiresAt: number
  request: T
  fingerprint: string
  inFlight?: Promise<unknown>
}

/** Exact pasted-token flow; it must not claim arbitrary next messages. */
export class AccountConfirmationCoordinator<T> {
  private readonly tokens = new Map<string, Confirmation<T>>()
  constructor(private readonly now = () => Date.now()) {}

  matches(content: string): boolean { return /^XPACCOUNT-[A-Za-z0-9_-]{32}$/.test(content.trim()) }

  issue(actor: AccountInteractionActor, request: T, fingerprint: string) {
    const key = actorKey(actor)
    if (!fingerprint) throw new XpPointsUserError('确认缺少数据快照。')
    this.expire()
    // Prevent an unbounded idle map; active confirmations are never displaced.
    if (this.tokens.size >= 1000) throw new XpPointsUserError('待确认操作过多，请稍后重新预览。')
    const token = 'XPACCOUNT-' + randomBytes(24).toString('base64url')
    const expiresAt = this.now() + 300_000
    this.tokens.set(token, { actorKey: key, expiresAt, request: structuredClone(request), fingerprint })
    return { token, expiresAt: new Date(expiresAt) }
  }

  async confirm<R>(content: string, actor: AccountInteractionActor,
    execute: (request: T, fingerprint: string, assertFresh: () => void) => Promise<R>): Promise<R> {
    const token = content.trim()
    const stored = this.tokens.get(token)
    if (!stored || !this.matches(token)) throw new XpPointsUserError('确认令牌不存在或已经使用，请重新预览。')
    if (stored.actorKey !== actorKey(actor)) throw new XpPointsUserError('请由原操作者在原机器人和会话中确认。')
    if (stored.inFlight) return stored.inFlight as Promise<R>
    const assertFresh = () => {
      if (this.tokens.get(token) !== stored || this.now() >= stored.expiresAt) {
        throw new XpPointsUserError('确认令牌已过期或取消，请重新预览。')
      }
    }
    try { assertFresh() } catch (error) { this.tokens.delete(token); throw error }
    // Set single-flight synchronously before invoking code that can await.
    stored.inFlight = Promise.resolve().then(() => execute(structuredClone(stored.request), stored.fingerprint, assertFresh))
    try { return await stored.inFlight as R }
    finally { if (this.tokens.get(token) === stored) this.tokens.delete(token) }
  }

  clear(): void { this.tokens.clear() }
  cancel(actor: AccountInteractionActor): number {
    const key = actorKey(actor)
    const matching = [...this.tokens].filter(([, stored]) => stored.actorKey === key)
    if (matching.some(([, stored]) => stored.inFlight)) throw new XpPointsUserError('操作正在执行，不能取消。')
    for (const [token] of matching) this.tokens.delete(token)
    return matching.length
  }
  private expire() {
    for (const [token, stored] of this.tokens) if (!stored.inFlight && this.now() >= stored.expiresAt) this.tokens.delete(token)
  }
}

export interface AccountOccupancyScope { profileIds: readonly number[], accountIds: readonly string[] }

/** Service-owned leases; games release them after settlement, not before awards. */
export class AccountOccupancyRegistry {
  private readonly leases = new Map<symbol, { consumer: string, scope: AccountOccupancyScope }>()

  acquire(consumer: string, scope: AccountOccupancyScope): () => void {
    if (!consumer.trim() || !scope.profileIds.length || !scope.accountIds.length
      || scope.profileIds.some(id => !Number.isSafeInteger(id) || id <= 0)
      || scope.accountIds.some(id => typeof id !== 'string' || !id.trim())) throw new XpPointsUserError('占用登记缺少真实账号或真人。')
    const id = Symbol(consumer)
    this.leases.set(id, { consumer, scope: { profileIds: [...new Set(scope.profileIds)], accountIds: [...new Set(scope.accountIds)] } })
    return () => { this.leases.delete(id) }
  }

  assertMutable(scope: AccountOccupancyScope): void {
    const conflicts = [...new Set([...this.leases.values()].filter(lease =>
      lease.scope.profileIds.some(id => scope.profileIds.includes(id))
      || lease.scope.accountIds.some(id => scope.accountIds.includes(id))).map(lease => lease.consumer))]
    if (conflicts.length) throw new XpPointsUserError(`相关账号正在参与 ${conflicts.join('、')}，请在活动结算完成后重试。`)
  }

  releaseConsumer(consumer: string): void {
    for (const [id, lease] of this.leases) if (lease.consumer === consumer) this.leases.delete(id)
  }
  clear(): void { this.leases.clear() }
}
