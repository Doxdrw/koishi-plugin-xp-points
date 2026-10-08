import type { Context } from 'koishi'
import type { AccountScoreMode } from './account-policy'

// xp_profile remains the authoritative person and xp_identity the authoritative
// ownership relation. Do not copy their nickname/owner into a second live store.
export interface XpAccount {
  id: string
  platform: string
  userId: string
  label: string
  nickname: string
  nicknameStatus: 'automatic' | 'managed' | 'unknown'
  createdAt: Date
}

export interface XpPersonPreference {
  profileId: number
  /** Null only while a freshly created person is being initialized. */
  defaultScoreMode?: AccountScoreMode | null
  primaryAccountId: string | null
  revision: number
}

export interface XpAccountPolicy {
  systemKey: string
  profileId: number
  mode: AccountScoreMode
  revision: number
}

export interface XpScoreSubject {
  id: string
  systemKey: string
  profileId: number
  accountId: string | null
  active: boolean
  createdAt: Date
  retiredAt: Date | null
}

export interface XpSubjectBalance {
  subjectId: string
  platform: string
  guildId: string
  value: number
  updatedAt: Date
}

export interface XpAccountOperation {
  id: string
  kind: string
  actorPlatform: string
  actorUserId: string
  createdAt: Date
  /** Versioned immutable JSON: policies, subjects, pool values and strategy. */
  snapshot: string
}

export interface XpJournalSubject {
  journalId: number
  subjectId: string
  /** Null for a historical reward whose actual account is unknown. */
  accountId: string | null
}

export interface XpAccountSchema {
  key: string
  version: number
  appliedAt: Date
}

declare module 'koishi' {
  interface Tables {
    xp_account: XpAccount
    xp_person_preference: XpPersonPreference
    xp_account_policy: XpAccountPolicy
    xp_score_subject: XpScoreSubject
    xp_subject_balance: XpSubjectBalance
    xp_account_operation: XpAccountOperation
    xp_journal_subject: XpJournalSubject
    xp_account_schema: XpAccountSchema
    /** Irreversible operation digests only; no user, target, score or timestamp. */
    xp_erased_operation: { digest: string }
  }
}

/** Account/subject schema used by the current plugin. */
export function registerAccountModels(ctx: Context): void {
  ctx.model.extend('xp_erased_operation', { digest: 'string' }, { primary: 'digest' })
  ctx.model.extend('xp_account', {
    id: 'string', platform: 'string', userId: 'string', label: 'string', nickname: 'string',
    nicknameStatus: 'string', createdAt: 'timestamp',
  }, { primary: 'id', unique: [['platform', 'userId']] })
  ctx.model.extend('xp_person_preference', {
    defaultScoreMode: { type: 'string', nullable: true },
    profileId: 'unsigned', primaryAccountId: { type: 'string', nullable: true }, revision: 'unsigned',
  }, { primary: 'profileId' })
  ctx.model.extend('xp_account_policy', {
    systemKey: 'string', profileId: 'unsigned', mode: 'string', revision: 'unsigned',
  }, { primary: ['systemKey', 'profileId'] })
  ctx.model.extend('xp_score_subject', {
    id: 'string', systemKey: 'string', profileId: 'unsigned',
    accountId: { type: 'string', nullable: true }, active: 'boolean',
    createdAt: 'timestamp', retiredAt: { type: 'timestamp', nullable: true },
  }, { primary: 'id', indexes: [['systemKey', 'profileId'], ['accountId']] })
  ctx.model.extend('xp_subject_balance', {
    subjectId: 'string', platform: 'string', guildId: 'string', value: 'double', updatedAt: 'timestamp',
  }, { primary: ['subjectId', 'platform', 'guildId'] })
  ctx.model.extend('xp_account_operation', {
    id: 'string', kind: 'string', actorPlatform: 'string', actorUserId: 'string',
    createdAt: 'timestamp', snapshot: 'text',
  }, { primary: 'id', indexes: ['createdAt'] })
  ctx.model.extend('xp_journal_subject', {
    journalId: 'unsigned', subjectId: 'string', accountId: { type: 'string', nullable: true },
  }, { primary: 'journalId', indexes: ['subjectId'] })
  ctx.model.extend('xp_account_schema', {
    key: 'string', version: 'unsigned', appliedAt: 'timestamp',
  }, { primary: 'key' })
}
