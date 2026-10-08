import { XpPointsUserError } from './errors'
import { randomUUID } from 'node:crypto'
import type { Context } from 'koishi'
import { AccountConfirmationCoordinator, AccountOccupancyRegistry, type AccountInteractionActor } from './account-interactions'
import { AccountMaintenanceStore, type AccountActor } from './account-maintenance'
import { PersonAssociationStore, type PersonAssociationRequest } from './account-association'
import { AccountModeStore, type AccountModeRequest, type AllAccountModeRequest } from './account-mode'
import { SubjectLedgerStore, type SubjectBatchRequest } from './subject-ledger'
import type { SubjectWriteCoordinator } from './mutation-coordinator'
import { ACCOUNT_SCHEMA_VERSION, ACCOUNT_SCHEMA_KEY } from './account-storage'

type Database = Context['database']
export type ModeChoice = Omit<AccountModeRequest, 'actor' | 'operationId'>
export type AssociationChoice = Omit<PersonAssociationRequest, 'actor' | 'operationId'>
export type BatchChoice = Omit<SubjectBatchRequest, 'actor' | 'operationId'>
type PendingOperation =
  | { kind: 'all-mode', request: AllAccountModeRequest }
  | { kind: 'mode', request: AccountModeRequest }
  | { kind: 'association', request: PersonAssociationRequest }
  | { kind: 'batch', request: SubjectBatchRequest }

export interface OccupiedAccount {
  accountId: string
  profileId: number
  platform: string
  userId: string
  nickname: string
}
export interface AccountOccupancyHandle {
  acquire(targets: readonly AccountActor[]): Promise<{ accounts: OccupiedAccount[], release: () => void }>
  dispose(): void
}

const operator = (actor: AccountInteractionActor): AccountActor => ({ platform: actor.platform, userId: actor.userId })

/**
 * Command-facing account boundary. It owns tokens and occupancy, but every store
 * uses the enclosing xpPoints service's one queue. Production must activate this
 * Account operations are recorded together with the current ledger and
 * consumer state so they can be audited and retried safely.
 * Preview payloads are private administrator data, never public board content.
 */
export class AccountOperations {
  private readonly confirmations: AccountConfirmationCoordinator<PendingOperation>
  private readonly occupancy = new AccountOccupancyRegistry()
  private readonly consumers = new Map<string, symbol>()
  private readonly metadata: AccountMaintenanceStore
  private readonly modes: AccountModeStore
  private readonly associations: PersonAssociationStore
  private readonly ledger: SubjectLedgerStore
  private disposed = false

  constructor(private readonly database: Database, private readonly writes: SubjectWriteCoordinator,
    now: () => number = () => Date.now()) {
    this.confirmations = new AccountConfirmationCoordinator(now)
    const guard = async (scope: { profileIds: readonly number[], accountIds: readonly string[] }) => {
      this.assertActive()
      this.occupancy.assertMutable(scope)
    }
    this.metadata = new AccountMaintenanceStore(database, writes,
      scope => guard({ profileIds: [scope.profileId], accountIds: scope.accountIds }))
    this.modes = new AccountModeStore(database, writes, guard)
    this.associations = new PersonAssociationStore(database, writes, guard)
    this.ledger = new SubjectLedgerStore(database, writes)
  }

  private assertActive() {
    if (this.disposed) throw new XpPointsUserError('账号服务已注销。')
  }

  /** Caller must hold the same service write queue, including during deletion. */
  assertMutable(scope: { profileIds: readonly number[], accountIds: readonly string[] }): void {
    this.assertActive()
    this.occupancy.assertMutable(scope)
  }

  matchesConfirmation(content: string): boolean { return this.confirmations.matches(content) }

  async previewMode(actor: AccountInteractionActor, choice: ModeChoice) {
    this.assertActive()
    const session = { ...actor }
    const request: AccountModeRequest = { ...structuredClone(choice), actor: operator(session), operationId: 'XPAC:' + randomUUID() }
    const preview = await this.modes.preview(request)
    this.assertActive()
    return { kind: 'mode' as const, preview,
      ...this.confirmations.issue(session, { kind: 'mode', request }, preview.fingerprint) }
  }

  async previewAllModes(actor: AccountInteractionActor, choice: Omit<AllAccountModeRequest, 'actor' | 'operationId'>) {
    this.assertActive()
    const session = { ...actor }
    const request = { ...structuredClone(choice), actor: operator(session), operationId: 'XPAC:' + randomUUID() }
    const preview = await this.modes.previewAll(request)
    this.assertActive()
    return { kind: 'all-mode' as const, preview,
      ...this.confirmations.issue(session, { kind: 'all-mode', request }, preview.fingerprint) }
  }

  async previewAssociation(actor: AccountInteractionActor, choice: AssociationChoice) {
    this.assertActive()
    const session = { ...actor }
    const request: PersonAssociationRequest = { ...structuredClone(choice), actor: operator(session), operationId: 'XPAR:' + randomUUID() }
    const preview = await this.associations.preview(request)
    this.assertActive()
    return { kind: 'association' as const, preview,
      ...this.confirmations.issue(session, { kind: 'association', request }, preview.fingerprint) }
  }

  async previewBatch(actor: AccountInteractionActor, choice: BatchChoice) {
    this.assertActive()
    const session = { ...actor }
    const request: SubjectBatchRequest = { ...structuredClone(choice), actor: operator(session), operationId: 'XPAB:' + randomUUID() }
    const preview = await this.ledger.previewBatch(request)
    this.assertActive()
    return { kind: 'batch' as const, preview,
      ...this.confirmations.issue(session, { kind: 'batch', request }, preview.fingerprint) }
  }

  async confirm(actor: AccountInteractionActor, content: string) {
    this.assertActive()
    return this.confirmations.confirm(content, { ...actor }, async (operation, fingerprint, assertFresh) => {
      this.assertActive()
      switch (operation.kind) {
        case 'all-mode': return { kind: 'all-mode' as const, result: await this.modes.applyAll(operation.request, fingerprint, assertFresh) }
        case 'mode': return { kind: 'mode' as const, result: await this.modes.apply(operation.request, fingerprint, assertFresh) }
        case 'association': return { kind: 'association' as const, result: await this.associations.apply(operation.request, fingerprint, assertFresh) }
        case 'batch': return { kind: 'batch' as const, result: await this.ledger.applyBatch(operation.request, fingerprint, assertFresh) }
      }
    })
  }

  cancel(actor: AccountInteractionActor): number {
    this.assertActive()
    return this.confirmations.cancel(actor)
  }

  rename(actor: AccountActor, profileId: number, nickname: string) {
    this.assertActive()
    return this.metadata.rename(actor, profileId, nickname)
  }
  setPrimary(actor: AccountActor, profileId: number, accountId: string) {
    this.assertActive()
    return this.metadata.setPrimary(actor, profileId, accountId)
  }
  setLabel(actor: AccountActor, profileId: number, accountId: string, label: string) {
    this.assertActive()
    return this.metadata.setLabel(actor, profileId, accountId, label)
  }
  setNickname(actor: AccountActor, profileId: number, accountId: string, nickname: string) {
    this.assertActive()
    return this.metadata.setNickname(actor, profileId, accountId, nickname)
  }

  registerConsumer(consumer: string): AccountOccupancyHandle {
    this.assertActive()
    const name = consumer.trim()
    if (!name || this.consumers.has(name)) throw new XpPointsUserError('占用消费方名称为空或重复。')
    const registration = Symbol(name)
    this.consumers.set(name, registration)
    const assertRegistered = () => {
      this.assertActive()
      if (this.consumers.get(name) !== registration) throw new XpPointsUserError('占用消费方已注销。')
    }
    return {
      acquire: targets => {
        assertRegistered()
        const copies = targets.map(target => ({ platform: target.platform, userId: target.userId }))
        if (!copies.length || copies.some(target => !target.platform?.trim() || !target.userId?.trim())) {
          return Promise.reject(new Error('占用登记必须提供实际参赛账号。'))
        }
        return this.writes.run(async () => {
          assertRegistered()
          const accounts = await this.database.transact(async db => {
            const schema = (await db.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
            if (schema?.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构尚未初始化。')
            const resolved = new Map<string, OccupiedAccount>()
            for (const target of copies) {
              const identity = (await db.get('xp_identity', target))[0]
              const account = (await db.get('xp_account', target))[0]
              const person = identity ? (await db.get('xp_profile', { id: identity.profileId }))[0] : undefined
              if (!identity || !account || !person) throw new XpPointsUserError('参赛账号尚未建档或关系不完整。')
              resolved.set(account.id, { accountId: account.id, profileId: person.id,
                platform: account.platform, userId: account.userId, nickname: person.nickname })
            }
            return [...resolved.values()]
          })
          // Disposal may occur while database reads await. Never leave a ghost lease.
          assertRegistered()
          const release = this.occupancy.acquire(name, {
            profileIds: accounts.map(account => account.profileId), accountIds: accounts.map(account => account.accountId),
          })
          return { accounts, release }
        })
      },
      dispose: () => {
        if (this.consumers.get(name) !== registration) return
        this.consumers.delete(name)
        this.occupancy.releaseConsumer(name)
      },
    }
  }

  dispose(): void {
    this.disposed = true
    this.confirmations.clear()
    this.consumers.clear()
    this.occupancy.clear()
  }
}
