import { XpPointsUserError } from './errors'
import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import { previewAccountConversion, applyAccountConversionIn, readConversionState, type AccountConversionRequest } from './account-conversion'
import { assertOperationNotErased } from './erased-operation'
import { requireAccountAuthority, type AccountActor } from './account-maintenance'
import { ACCOUNT_SCHEMA_VERSION, ACCOUNT_SCHEMA_KEY } from './account-storage'
import { SubjectWriteCoordinator } from './subject-ledger'

type Database = Context['database']
export type AccountModeRequest = Omit<AccountConversionRequest, 'actor'> & { actor: AccountActor }
export type AllAccountModeRequest = Omit<AccountModeRequest, 'systemKey'>

function stable(value: any): any {
  if (value instanceof Date) return value.getTime()
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  return value
}
const serialize = (value: unknown) => JSON.stringify(stable(value))
const fingerprint = (value: unknown) => createHash('sha256').update(serialize(value)).digest('hex')

/** Permission-aware mode boundary. Never accepts a caller-declared administrator role. */
export class AccountModeStore {
  constructor(private readonly database: Database, private readonly writes: SubjectWriteCoordinator,
    private readonly assertMutable: (scope: { profileIds: number[], accountIds: string[] }) => Promise<void>) {}

  private async authorize<T extends AllAccountModeRequest>(db: Database, request: T) {
    const authority = await requireAccountAuthority(db, request.actor)
    const identity = (await db.get('xp_identity', { platform: request.actor.platform, userId: request.actor.userId }))[0]
    if (authority < 2 && identity?.profileId !== request.profileId) throw new XpPointsUserError('只能整理管理员已关联的本人账号。')
    return { ...request, actor: { ...request.actor, kind: authority >= 2 ? 'administrator' as const : 'self' as const } }
  }

  private async previewAllIn(db: Database, request: AllAccountModeRequest) {
    if (!/^XPAC:[A-Za-z0-9-]{8,70}$/.test(request.operationId)
      || !['shared', 'independent'].includes(request.nextMode) || !['maximum', 'sum'].includes(request.strategy)) throw new XpPointsUserError('全系统模式请求无效。')
    const authorized = await this.authorize(db, request)
    if (authorized.actor.kind === 'self' && (request.strategy === 'sum' || request.periodStrategy === 'sum')) throw new XpPointsUserError('本人合并只能取最高分。')
    const preference = (await db.get('xp_person_preference', { profileId: request.profileId }))[0]
    if (!preference) throw new XpPointsUserError('真人账号偏好不完整。')
    const identities = (await db.get('xp_identity', { profileId: request.profileId })).sort((a,b) => serialize(a).localeCompare(serialize(b)))
    const accounts = []
    for (const identity of identities) {
      const account = (await db.get('xp_account', { platform: identity.platform, userId: identity.userId }))[0]
      if (!account) throw new XpPointsUserError('账号档案不完整。')
      accounts.push(account)
    }
    if (!accounts.length || (request.retainedAccountId && !accounts.some(a => a.id === request.retainedAccountId))) throw new XpPointsUserError('承接账号须属于本人账号组。')
    await this.assertMutable({ profileIds: [request.profileId], accountIds: accounts.map(a => a.id) })
    const systems = (await db.get('xp_score_system', {})).sort((a,b) => a.key.localeCompare(b.key))
    const states = []
    const changes: Array<Awaited<ReturnType<typeof previewAccountConversion>>> = []
    for (const [index, system] of systems.entries()) {
      const state = await readConversionState(db, request.profileId, system.key, true)
      states.push(state)
      if (state.policy.mode === request.nextMode) continue
      changes.push(await previewAccountConversion(db, { ...authorized, systemKey: system.key,
        operationId: request.operationId + '-' + index }, true))
    }
    const state = { preference, identities, accounts, systems, states, role: authorized.actor.kind }
    return { request, fingerprint: fingerprint(state), state, changes }
  }

  previewAll(request: AllAccountModeRequest) {
    const copy = structuredClone(request)
    return this.run(db => this.previewAllIn(db, copy))
  }

  applyAll(request: AllAccountModeRequest, expected: string, assertFresh: () => void) {
    const copy = structuredClone(request)
    return this.run(async db => {
      assertFresh()
      await this.authorize(db, copy)
      await assertOperationNotErased(db, 'account', copy.operationId)
      const previous = (await db.get('xp_account_operation', { id: copy.operationId }))[0]
      if (previous) {
        const saved = JSON.parse(previous.snapshot)
        if (previous.kind !== 'all-mode-conversion' || saved.fingerprint !== expected || serialize(saved.request) !== serialize(copy)) throw new XpPointsUserError('操作 ID 已被其他请求使用。')
        // Retry cannot bypass current ownership, authority or live occupancy.
        await this.previewAllIn(db, copy)
        return { ...saved.result, deduplicated: true }
      }
      await db.set('xp_person_preference', { profileId: copy.profileId }, row => ({ revision: row.revision }))
      const preview = await this.previewAllIn(db, copy)
      if (preview.fingerprint !== expected) throw new XpPointsUserError('账号、系统或余额已变化，请重新预览。')
      const results = []
      for (const change of preview.changes) {
        results.push(await applyAccountConversionIn(db, change.request, change.fingerprint, async transaction => {
          assertFresh()
          const auth = await this.authorize(transaction, copy)
          if (auth.actor.kind !== change.request.actor.kind) throw new XpPointsUserError('权限已变化，请重新预览。')
          await this.assertMutable({ profileIds: [copy.profileId], accountIds: preview.state.accounts.map(a => a.id) })
        }, true))
      }
      assertFresh()
      await db.set('xp_person_preference', { profileId: copy.profileId }, {
        defaultScoreMode: copy.nextMode, revision: preview.state.preference.revision + 1,
      })
      const result = { operationId: copy.operationId, profileId: copy.profileId,
        mode: copy.nextMode, changedSystems: preview.changes.map(c => c.state.system.key), deduplicated: false }
      await db.create('xp_account_operation', { id: copy.operationId, kind: 'all-mode-conversion',
        actorPlatform: copy.actor.platform, actorUserId: copy.actor.userId, createdAt: new Date(),
        snapshot: serialize({ version: 1, request: copy, fingerprint: expected, previousDefault: preview.state.preference.defaultScoreMode, results, result }) })
      return result
    })
  }

  private run<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    return this.writes.run(() => this.database.transact(async db => {
      const schema = (await db.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
      if (schema?.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构尚未初始化。')
      return callback(db)
    }))
  }

  preview(request: AccountModeRequest) {
    const copy = structuredClone(request)
    return this.run(async db => {
      const authorized = await this.authorize(db, copy)
      const preview = await previewAccountConversion(db, authorized)
      await this.assertMutable({ profileIds: [copy.profileId], accountIds: preview.state.accounts.map(row => row.id) })
      return preview
    })
  }

  apply(request: AccountModeRequest, fingerprint: string, assertFresh: () => void) {
    const copy = structuredClone(request)
    return this.run(async db => {
      assertFresh()
      if (!(await db.get('xp_person_preference', { profileId: copy.profileId })).length) throw new XpPointsUserError('真人账号偏好不完整。')
      await db.set('xp_person_preference', { profileId: copy.profileId }, row => ({ revision: row.revision }))
      const authorized = await this.authorize(db, copy)
      return applyAccountConversionIn(db, authorized, fingerprint, async transaction => {
        const actual = await this.authorize(transaction, copy)
        if (actual.actor.kind !== authorized.actor.kind) throw new XpPointsUserError('权限已变化，请重新预览。')
        const ids: string[] = []
        for (const identity of await transaction.get('xp_identity', { profileId: copy.profileId })) {
          const account = (await transaction.get('xp_account', { platform: identity.platform, userId: identity.userId }))[0]
          if (!account) throw new XpPointsUserError('账号档案不完整。')
          ids.push(account.id)
        }
        await this.assertMutable({ profileIds: [copy.profileId], accountIds: ids })
        assertFresh()
      })
    })
  }
}
