import { Context } from 'koishi'
import { registerPeriodModels } from './period-model'

export interface XpProfile {
  id: number
  nickname: string
  automatic: boolean
  createdAt: Date
  updatedAt: Date
}

export interface XpIdentity {
  platform: string
  userId: string
  profileId: number
  createdAt: Date
  updatedAt: Date
}

export type XpScoreScope = 'global' | 'platform' | 'guild'

export interface XpScoreSystem {
  key: string
  name: string
  unit: string
  scope: XpScoreScope
  active: boolean
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface XpScoreJournal {
  id: number
  mutationId: string
  systemKey: string
  profileId: number
  platform: string
  guildId: string
  originPlatform: string
  originGuildId: string
  operation: string
  /** Original add/set input; null for historical and derived entries. */
  operand: number | null
  delta: number
  before: number
  after: number
  source: string
  reason: string
  actorPlatform: string
  actorUserId: string
  createdAt: Date
}

export interface XpScoreGuildAlias {
  systemKey: string
  platform: string
  sourceGuildId: string
  targetGuildId: string
  createdAt: Date
  updatedAt: Date
}

/** A reconstructible contribution of a source guild to a current target pool. */
export interface XpScoreGuildComponent {
  systemKey: string
  subjectId: string
  platform: string
  targetGuildId: string
  sourceGuildId: string
  value: number
  kind: 'source' | 'baseline' | 'adjustment' | 'override'
  updatedAt: Date
}

export interface XpScoreGuildAliasPolicy {
  systemKey: string
  platform: string
  balanceStrategy: 'maximum' | 'sum'
  periodStrategy: 'maximum' | 'sum'
  updatedAt: Date
}

export interface XpProfileMerge {
  sourceProfileId: number
  targetProfileId: number
  createdAt: Date
}

export type XpGuildPresenceState = 'active' | 'inactive'

export interface XpGuildPresence {
  platform: string
  guildId: string
  userId: string
  state: XpGuildPresenceState
  reason: string
  firstConfirmedAt: Date
  lastConfirmedAt: Date
  inactiveAt: Date | null
}

declare module 'koishi' {
  interface Tables {
    xp_profile: XpProfile
    xp_identity: XpIdentity
    xp_score_system: XpScoreSystem
    xp_score_journal: XpScoreJournal
    xp_score_guild_alias: XpScoreGuildAlias
    xp_score_guild_component: XpScoreGuildComponent
    xp_score_guild_alias_policy: XpScoreGuildAliasPolicy
    xp_profile_merge: XpProfileMerge
    xp_guild_presence: XpGuildPresence
  }
}

export function registerModels(ctx: Context): void {
  registerPeriodModels(ctx)
  ctx.model.extend('xp_profile', {
    id: 'unsigned',
    nickname: 'string',
    automatic: { type: 'boolean', initial: false },
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    autoInc: true,
    primary: 'id',
    unique: ['nickname'],
  })
  ctx.model.extend('xp_identity', {
    platform: 'string',
    userId: 'string',
    profileId: 'unsigned',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    primary: ['platform', 'userId'],
    indexes: ['profileId'],
    foreign: {
      profileId: ['xp_profile', 'id'],
    },
  })
  ctx.model.extend('xp_score_system', {
    key: 'string',
    name: 'string',
    unit: 'string',
    scope: 'string',
    active: { type: 'boolean', initial: true },
    createdBy: 'string',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    primary: 'key',
    unique: ['name'],
  })
  ctx.model.extend('xp_score_journal', {
    id: 'unsigned',
    mutationId: 'string',
    systemKey: 'string',
    profileId: 'unsigned',
    platform: 'string',
    guildId: 'string',
    originPlatform: 'string',
    originGuildId: 'string',
    operation: 'string',
    operand: { type: 'double', nullable: true, initial: null },
    delta: 'double',
    before: 'double',
    after: 'double',
    source: 'string',
    reason: 'text',
    actorPlatform: 'string',
    actorUserId: 'string',
    createdAt: 'timestamp',
  }, {
    autoInc: true,
    primary: 'id',
    unique: ['mutationId'],
    indexes: [['systemKey', 'platform', 'guildId'], ['profileId'], ['createdAt']],
  })
  ctx.model.extend('xp_score_guild_alias', {
    systemKey: 'string',
    platform: 'string',
    sourceGuildId: 'string',
    targetGuildId: 'string',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    primary: ['systemKey', 'platform', 'sourceGuildId'],
    indexes: [['systemKey', 'platform', 'targetGuildId']],
    foreign: {
      systemKey: ['xp_score_system', 'key'],
    },
  })
  ctx.model.extend('xp_score_guild_component', {
    systemKey: 'string',
    subjectId: 'string',
    platform: 'string',
    targetGuildId: 'string',
    sourceGuildId: 'string',
    value: 'double',
    kind: { type: 'string', initial: 'source' },
    updatedAt: 'timestamp',
  }, {
    primary: ['systemKey', 'subjectId', 'platform', 'targetGuildId', 'sourceGuildId'],
    indexes: [['systemKey', 'platform', 'targetGuildId'], ['subjectId']],
    foreign: {
      systemKey: ['xp_score_system', 'key'],
      subjectId: ['xp_score_subject', 'id'],
    },
  })
  ctx.model.extend('xp_score_guild_alias_policy', {
    systemKey: 'string',
    platform: 'string',
    balanceStrategy: { type: 'string', initial: 'maximum' },
    periodStrategy: { type: 'string', initial: 'maximum' },
    updatedAt: 'timestamp',
  }, {
    primary: ['systemKey', 'platform'],
    foreign: { systemKey: ['xp_score_system', 'key'] },
  })
  ctx.model.extend('xp_profile_merge', {
    sourceProfileId: 'unsigned',
    targetProfileId: 'unsigned',
    createdAt: 'timestamp',
  }, {
    primary: 'sourceProfileId',
    indexes: ['targetProfileId'],
  })
  ctx.model.extend('xp_guild_presence', {
    platform: 'string',
    guildId: 'string',
    userId: 'string',
    state: 'string',
    reason: 'string',
    firstConfirmedAt: 'timestamp',
    lastConfirmedAt: 'timestamp',
    inactiveAt: { type: 'timestamp', nullable: true },
  }, {
    primary: ['platform', 'guildId', 'userId'],
    indexes: [['platform', 'guildId'], ['platform', 'userId']],
  })
}
