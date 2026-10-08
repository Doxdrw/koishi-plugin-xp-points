import { XpPointsUserError } from './errors'
import { randomUUID } from 'node:crypto'
import { $, type Context } from 'koishi'
import { ACCOUNT_SCHEMA_VERSION, ACCOUNT_SCHEMA_KEY } from './account-storage'
import type { SubjectWriteCoordinator } from './subject-ledger'

type Database = Context['database']
export interface AccountActor { platform: string, userId: string }
export interface AccountMutationScope { profileId: number, accountIds: string[] }
export type NicknameMaintenanceResult =
  | { kind: 'renamed' | 'unchanged', profileId: number, nickname: string }
  | { kind: 'association-required', profileId: number, targetProfileId: number, nickname: string }

/** Query the actual Koishi login, never the person's other linked accounts. */
export async function requireAccountAuthority(database: Database, actor: AccountActor): Promise<number> {
  if (!actor.platform?.trim() || !actor.userId?.trim()) throw new XpPointsUserError('操作账号无效。')
  const binding = (await database.get('binding', { platform: actor.platform, pid: actor.userId }))[0]
  const user = binding ? (await database.get('user', { id: binding.aid }))[0] : undefined
  if (!user || !Number.isFinite(user.authority) || user.authority < 1) throw new XpPointsUserError('当前账号无操作权限。')
  return user.authority
}

/** Metadata service. Caller must supply the service's live occupancy guard. */
export class AccountMaintenanceStore {
  constructor(private readonly database: Database, private readonly writes: SubjectWriteCoordinator,
    private readonly assertMutable: (scope: AccountMutationScope) => Promise<void>) {}

  private run<T>(actor: AccountActor, profileId: number, administratorOnly: boolean,
    callback: (database: Database, scope: AccountMutationScope) => Promise<T>): Promise<T> {
    const actualActor = { ...actor }
    return this.writes.run(() => this.database.transact(async db => {
      const schema = (await db.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
      if (schema?.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构尚未初始化。')
      if (!Number.isSafeInteger(profileId) || profileId <= 0) throw new XpPointsUserError('真人档案 ID 无效。')
      const authority = await requireAccountAuthority(db, actualActor)
      const identity = (await db.get('xp_identity', { platform: actualActor.platform, userId: actualActor.userId }))[0]
      if (authority < 2 && (administratorOnly || identity?.profileId !== profileId)) throw new XpPointsUserError('需要管理员权限或本人已关联账号。')
      const preference = (await db.get('xp_person_preference', { profileId }))[0]
      if (!preference) throw new XpPointsUserError('真人账号偏好不完整。')
      await db.set('xp_person_preference', { profileId }, row => ({ revision: row.revision }))
      const accounts = []
      for (const member of await db.get('xp_identity', { profileId })) {
        const account = (await db.get('xp_account', { platform: member.platform, userId: member.userId }))[0]
        if (!account) throw new XpPointsUserError('账号档案不完整。')
        accounts.push(account)
      }
      if (!accounts.length) throw new XpPointsUserError('真人没有关联账号。')
      const scope = { profileId, accountIds: accounts.map(account => account.id) }
      await this.assertMutable(scope)
      return callback(db, scope)
    }))
  }

  private async audit(db: Database, actor: AccountActor, profileId: number, kind: string, before: unknown, after: unknown) {
    const now = new Date()
    await db.set('xp_person_preference', { profileId }, row => ({ revision: $.add(row.revision, 1) }))
    await db.create('xp_account_operation', { id: 'XPAM:' + randomUUID(), kind,
      actorPlatform: actor.platform, actorUserId: actor.userId, createdAt: now,
      snapshot: JSON.stringify({ version: 1, profileId, before, after }) })
  }

  rename(actor: AccountActor, profileId: number, rawNickname: string): Promise<NicknameMaintenanceResult> {
    const operator = { ...actor }
    return this.run(operator, profileId, true, async db => {
      const nickname = rawNickname?.trim()
      if (!nickname || nickname.length > 255 || /[\r\n]/.test(nickname)) throw new XpPointsUserError('昵称不能为空、过长或包含换行。')
      const profile = (await db.get('xp_profile', { id: profileId }))[0]
      if (!profile) throw new XpPointsUserError('真人档案不存在。')
      const occupied = (await db.get('xp_profile', { nickname }))[0]
      if (occupied && occupied.id !== profileId) {
        return { kind: 'association-required', profileId, targetProfileId: occupied.id, nickname }
      }
      if (profile.nickname === nickname && !profile.automatic) return { kind: 'unchanged', profileId, nickname }
      await db.set('xp_profile', { id: profileId }, { nickname, automatic: false, updatedAt: new Date() })
      await this.audit(db, operator, profileId, 'person-rename',
        { nickname: profile.nickname, automatic: profile.automatic }, { nickname, automatic: false })
      return { kind: profile.nickname === nickname ? 'unchanged' : 'renamed', profileId, nickname }
    })
  }

  setPrimary(actor: AccountActor, profileId: number, accountId: string): Promise<void> {
    const operator = { ...actor }
    return this.run(operator, profileId, false, async (db, scope) => {
      if (!scope.accountIds.includes(accountId)) throw new XpPointsUserError('主号必须是本人已关联账号。')
      const preference = (await db.get('xp_person_preference', { profileId }))[0]
      if (preference.primaryAccountId === accountId) return
      await db.set('xp_person_preference', { profileId }, { primaryAccountId: accountId })
      await this.audit(db, operator, profileId, 'account-primary', preference.primaryAccountId, accountId)
    })
  }

  setNickname(actor: AccountActor, profileId: number, accountId: string, rawNickname: string): Promise<void> {
    const operator = { ...actor }
    return this.run(operator, profileId, true, async (db, scope) => {
      if (!scope.accountIds.includes(accountId)) throw new XpPointsUserError('账号不属于该真人档案。')
      const nickname = rawNickname?.trim()
      if (!nickname || nickname.length > 255 || /[\r\n]/.test(nickname)) throw new XpPointsUserError('昵称不能为空、过长或包含换行。')
      const account = (await db.get('xp_account', { id: accountId }))[0]
      if (account.nickname === nickname && account.nicknameStatus === 'managed') return
      await db.set('xp_account', { id: accountId }, { nickname, nicknameStatus: 'managed' })
      await this.audit(db, operator, profileId, 'account-nickname',
        { accountId, nickname: account.nickname, nicknameStatus: account.nicknameStatus },
        { accountId, nickname, nicknameStatus: 'managed' })
    })
  }

  setLabel(actor: AccountActor, profileId: number, accountId: string, rawLabel: string): Promise<void> {
    const operator = { ...actor }
    return this.run(operator, profileId, false, async (db, scope) => {
      if (!scope.accountIds.includes(accountId)) throw new XpPointsUserError('只能设置本人已关联账号标签。')
      const label = rawLabel?.trim()
      if (!label || label.length > 64 || /[\r\n]/.test(label)) throw new XpPointsUserError('标签不能为空、过长或包含换行。')
      const accounts = await db.get('xp_account', { id: scope.accountIds })
      const account = accounts.find(row => row.id === accountId)!
      if (accounts.some(row => row.id !== accountId && row.label === label)) throw new XpPointsUserError('同一真人的账号标签不能重复。')
      if (account.label === label) return
      await db.set('xp_account', { id: accountId }, { label })
      await this.audit(db, operator, profileId, 'account-label', { accountId, label: account.label }, { accountId, label })
    })
  }
}
