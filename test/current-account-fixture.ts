import { createHash, randomUUID } from 'node:crypto'
import type { Context } from 'koishi'
import type { ScoreSystemDefinition } from '../src/score-ledger'
import { registerModels } from '../src/model'
import { registerAccountModels } from '../src/account-model'
import { AccountLifecycleStore } from '../src/account-lifecycle'
import { SubjectWriteCoordinator } from '../src/subject-ledger'

export function currentModels(ctx: Context) {
  registerModels(ctx)
  registerAccountModels(ctx)
}

export namespace currentModels { export const inject = ['database'] }

export async function seedCurrentPerson(db: Context['database'], id: number, nickname: string,
  accounts: Array<[string, string]>, systems: readonly ScoreSystemDefinition[] = []) {
  const now = new Date('2026-01-01T00:00:00Z')
  await db.create('xp_profile', { id, nickname, automatic: false, createdAt: now, updatedAt: now })
  await db.create('xp_person_preference', { profileId: id, primaryAccountId: null, revision: 0, defaultScoreMode: 'shared' })
  for (const [index, [platform, userId]] of accounts.entries()) {
    const accountId = `XPA-fixture-${id}-${index + 1}`
    await db.create('xp_identity', { platform, userId, profileId: id, createdAt: now, updatedAt: now })
    await db.create('xp_account', { id: accountId, platform, userId, label: `账号${index + 1}`,
      nickname, nicknameStatus: 'automatic', createdAt: now })
  }
  for (const system of systems) {
    await db.create('xp_account_policy', { profileId: id, systemKey: system.key, mode: 'shared', revision: 0 })
    await db.create('xp_score_subject', { id: 'XPS-' + randomUUID(), profileId: id, systemKey: system.key,
      accountId: null, active: true, createdAt: now, retiredAt: null })
  }
  return { profileId: id, nickname }
}

export async function createCurrentSystem(db: Context['database'], system: ScoreSystemDefinition) {
  const now = new Date('2026-01-01T00:00:00Z')
  await db.create('xp_score_system', { ...system, unit: system.unit ?? '分', active: true,
    createdBy: 'fixture', createdAt: now, updatedAt: now })
}

export async function seedCurrentBalance(db: Context['database'], subjectId: string, value: number,
  platform = '', guildId = '') {
  await db.create('xp_subject_balance', { subjectId, value, platform, guildId,
    updatedAt: new Date('2026-01-01T00:00:00Z') })
}

export async function seedCurrentReward(db: Context['database'], subjectId: string, systemKey: string,
  amount: number, idempotencyKey: string, options: { platform?: string, guildId?: string, reason?: string } = {}) {
  const now = new Date('2026-01-01T00:00:00Z')
  const journal = await db.create('xp_score_journal', {
    mutationId: 'XPSCORE-IDEMP-' + createHash('sha256').update([systemKey, 'fixture', idempotencyKey].join('\0')).digest('hex'), systemKey, profileId: 1,
    platform: options.platform ?? '', guildId: options.guildId ?? '',
    originPlatform: options.platform ?? '', originGuildId: options.guildId ?? '',
    operation: 'add', operand: amount, delta: amount, before: 0, after: amount,
    source: 'fixture', reason: options.reason ?? 'game reward', actorPlatform: '', actorUserId: '', createdAt: now,
  })
  await db.create('xp_journal_subject', { journalId: journal.id, subjectId, accountId: null })
  return { journalId: journal.id, before: 0, after: amount, delta: amount, deduplicated: false }
}

export async function bootstrapCurrentSchema(db: Context['database']) {
  const writes = new SubjectWriteCoordinator()
  const lifecycle = new AccountLifecycleStore(db, writes)
  await lifecycle.bootstrap()
  return { writes, lifecycle }
}
