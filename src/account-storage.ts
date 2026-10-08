import type { Context } from 'koishi'
import { XpPointsUserError } from './errors'

type Database = Context['database']

/** Current account/subject schema marker. The value is stable for existing installations. */
export const ACCOUNT_SCHEMA_VERSION = 1
export const ACCOUNT_SCHEMA_KEY = 'person-account-subject-v1'

export async function readAccountSchema(database: Database) {
  return (await database.get('xp_account_schema', { key: ACCOUNT_SCHEMA_KEY }))[0]
}

export async function requireAccountSchema(database: Database): Promise<void> {
  const marker = await readAccountSchema(database)
  if (marker?.version !== ACCOUNT_SCHEMA_VERSION) {
    throw new XpPointsUserError('账号数据结构尚未初始化或版本不兼容。')
  }
}

/**
 * Mark a fresh installation as ready for the current account/subject schema.
 * Existing current rows without a marker are treated as an incomplete setup;
 * This module only validates the current account schema; it never rewrites
 * account data during normal startup.
 */
export async function initializeAccountSchema(database: Database): Promise<void> {
  const marker = await readAccountSchema(database)
  if (marker) {
    if (marker.version !== ACCOUNT_SCHEMA_VERSION) throw new XpPointsUserError('账号数据结构版本不兼容。')
    return
  }
  const profiles = await database.get('xp_profile', {})
  const identities = await database.get('xp_identity', {})
  const accounts = await database.get('xp_account', {})
  const preferences = await database.get('xp_person_preference', {})
  const subjects = await database.get('xp_score_subject', {})
  const balances = await database.get('xp_subject_balance', {})
  if (profiles.length || identities.length || accounts.length || preferences.length || subjects.length || balances.length) {
    throw new XpPointsUserError('账号数据结构标记缺失；请使用当前版本初始化的数据库。')
  }
  await database.create('xp_account_schema', {
    key: ACCOUNT_SCHEMA_KEY,
    version: ACCOUNT_SCHEMA_VERSION,
    appliedAt: new Date(),
  })
}
