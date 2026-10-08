import type { Context } from 'koishi'
import type { ScorePeriodKind } from './period-calendar'
export interface PeriodPolicy {
  systemKey: string
  enabledAt: number
  /** Ordered effective configurations. The active season is never redefined. */
  revisions: string
  revision: number
}
export interface PeriodDefinition {
  id: string
  systemKey: string
  kind: ScorePeriodKind
  start: number
  end: number
  label: string
  timeZone: string
  incomplete: boolean
  revisedAt: number
}
export interface PeriodScore {
  periodId: string
  subjectId: string
  platform: string
  guildId: string
  value: number
  updatedAt: number
}
export interface PeriodJournal {
  journalId: number
  competitive: boolean
  effectiveAt: number
  businessId: string
  delta: number
}
export interface PeriodAdjustment { id: number; operationId: string; snapshot: string; createdAt: number }
export interface PeriodGuildComponent {
  periodId: string
  subjectId: string
  platform: string
  targetGuildId: string
  sourceGuildId: string
  value: number
  kind: 'source' | 'baseline' | 'adjustment' | 'override'
  updatedAt: number
}
declare module 'koishi' {
  interface Tables {
    xp_period_policy: PeriodPolicy
    xp_period_definition: PeriodDefinition
    xp_period_score: PeriodScore
    xp_period_journal: PeriodJournal
    xp_period_adjustment: PeriodAdjustment
    xp_period_guild_component: PeriodGuildComponent
  }
}
export function registerPeriodModels(ctx: Context) {
  ctx.model.extend('xp_period_policy', { systemKey: 'string', enabledAt: 'double', revisions: 'text', revision: 'unsigned' }, { primary: 'systemKey' })
  ctx.model.extend('xp_period_definition', { id: 'string', systemKey: 'string', kind: 'string', start: 'double', end: 'double', label: 'string',
    timeZone: 'string', incomplete: 'boolean', revisedAt: 'double' }, { primary: 'id', indexes: [['systemKey', 'kind', 'start']] })
  ctx.model.extend('xp_period_score', { periodId: 'string', subjectId: 'string', platform: 'string', guildId: 'string', value: 'double', updatedAt: 'double' },
    { primary: ['periodId', 'subjectId', 'platform', 'guildId'], indexes: ['subjectId'] })
  ctx.model.extend('xp_period_journal', { journalId: 'unsigned', competitive: 'boolean', effectiveAt: 'double', businessId: 'string', delta: 'double' }, { primary: 'journalId' })
  ctx.model.extend('xp_period_adjustment', { id: 'unsigned', operationId: 'string', snapshot: 'text', createdAt: 'double' }, { primary: 'id', autoInc: true, indexes: ['operationId'] })
  ctx.model.extend('xp_period_guild_component', {
    periodId: 'string', subjectId: 'string', platform: 'string', targetGuildId: 'string', sourceGuildId: 'string',
    value: 'double', kind: { type: 'string', initial: 'source' }, updatedAt: 'double',
  }, { primary: ['periodId', 'subjectId', 'platform', 'targetGuildId', 'sourceGuildId'], indexes: [['subjectId'], ['periodId', 'platform', 'targetGuildId']] })
}
