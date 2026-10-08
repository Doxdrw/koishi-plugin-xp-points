import type { XpScoreJournal, XpScoreScope, XpScoreSystem } from './model'
import type { XpPointsService } from './service'
import type { ScoreAccountTarget } from './subject-ledger'
import type { CompetitiveContext } from './period-ledger'
import type { ScorePeriodKind } from './period-calendar'

export type ScoreScope = XpScoreScope

export interface ScoreSystemDefinition {
  key: string
  name: string
  unit?: string
  scope: ScoreScope
}

export interface ScoreConsumerRegistration {
  consumer: string
  systemKey: string
  defaultSystem?: ScoreSystemDefinition
}

export interface ScoreCommandBindingConfig {
  systemKey: string
  query: string[]
  leaderboard: string[]
  setSelf: string[]
  addSelf: string[]
  setTarget: string[]
  addTarget: string[]
}

export interface ScoreOperationContext extends CompetitiveContext {
  platform?: string
  guildId?: string
  reason: string
  idempotencyKey?: string
  actor?: {
    platform: string
    userId: string
  }
}

export interface ScoreMutationResult {
  before: number
  after: number
  delta: number
  journalId: number
  deduplicated: boolean
}

export interface ScoreLeaderboardEntry {
  profileId: number
  nickname: string
  value: number
  inactive?: true
}

export interface ScoreLeaderboardPage {
  entries: ScoreLeaderboardEntry[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface ScoreJournalPage {
  entries: XpScoreJournal[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export class ScoreLedgerHandle {
  private disposed = false

  constructor(
    private readonly service: XpPointsService,
    readonly consumer: string,
    readonly systemKey: string,
    private readonly unregister: () => void,
  ) {}

  private assertActive(): void {
    if (this.disposed) throw new Error(`积分消费方 ${this.consumer} 已注销。`)
  }

  getSystem(): Promise<XpScoreSystem> {
    this.assertActive()
    return this.service.requireScoreSystem(this.systemKey)
  }

  getAccount(target: ScoreAccountTarget, context: Omit<ScoreOperationContext, 'reason'>): Promise<number> {
    this.assertActive()
    return this.service.getAccountScore(this.systemKey, target, context)
  }

  addAccount(target: ScoreAccountTarget, amount: number, context: ScoreOperationContext): Promise<ScoreMutationResult> {
    this.assertActive()
    return this.service.addAccountScore(this.systemKey, target, amount, { ...context, source: this.consumer })
  }

  setAccount(target: ScoreAccountTarget, value: number, context: ScoreOperationContext): Promise<ScoreMutationResult> {
    this.assertActive()
    return this.service.setAccountScore(this.systemKey, target, value, { ...context, source: this.consumer })
  }

  leaderboard(context: Omit<ScoreOperationContext, 'reason'>): Promise<ScoreLeaderboardEntry[]> {
    this.assertActive()
    return this.service.getScoreLeaderboard(this.systemKey, context)
  }

  periodLeaderboard(context: Omit<ScoreOperationContext, 'reason'>, options: { kind: ScorePeriodKind; at?: number; season?: string; page?: number; pageSize?: number }) {
    this.assertActive()
    return this.service.getPeriodLeaderboard(this.systemKey, context, options)
  }

  leaderboardPage(
    context: Omit<ScoreOperationContext, 'reason'>,
    options: { page?: number, pageSize?: number } = {},
  ): Promise<ScoreLeaderboardPage> {
    this.assertActive()
    return this.service.getScoreLeaderboardPage(this.systemKey, context, options)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unregister()
  }
}

export interface InternalScoreMutationContext extends ScoreOperationContext {
  source: string
}
