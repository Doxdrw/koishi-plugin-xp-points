import type { Context } from 'koishi'

export interface ProfileIdentityKey {
  platform: string
  userId: string
}

export interface ProfileDeletionScope {
  mode: 'identity' | 'profile'
  rootProfileId: number
  profileIds: number[]
  identities: Array<ProfileIdentityKey & { profileId: number }>
  targetIdentity?: ProfileIdentityKey
}

export interface ProfileDataConsumerPreview {
  affectedRows: number
  summary: string[]
  snapshot: unknown
}

export interface ProfileDataConsumer {
  name: string
  preview(
    database: Context['database'],
    scope: ProfileDeletionScope,
  ): Promise<ProfileDataConsumerPreview>
  delete(
    database: Context['database'],
    scope: ProfileDeletionScope,
  ): Promise<void>
  /** Filesystem cleanup only after the shared DB transaction committed.
   * Failure is reported separately; it cannot roll back an already committed deletion. */
  afterDelete?(scope: ProfileDeletionScope): Promise<void>
}

export interface ProfileDeletionActor {
  platform: string
  userId: string
  selfId: string
  channelId: string
}

export interface ProfileDeletionPreview {
  token: string
  expiresAt: Date
  mode: ProfileDeletionScope['mode']
  summary: string[]
}

export interface ProfileDeletionResult {
  mode: ProfileDeletionScope['mode']
  rootProfileId: number
  deletedIdentities: number
  deletedProfiles: number
  consumerRows: number
  warnings?: string[]
}
