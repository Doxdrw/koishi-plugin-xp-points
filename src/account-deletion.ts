import { $, type Context } from 'koishi'
import type { ProfileDeletionScope } from './deletion'
import { markErasedOperations } from './erased-operation'

type Database = Context['database']
const identityKey = (row: { platform: string, userId: string }) => JSON.stringify([row.platform, row.userId])
const sortRows = <T>(rows: T[]): T[] => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

/** Match structured identifiers, never a numeric score coincidentally equal to a person ID. */
function references(value: unknown, persons: Set<number>, accounts: Set<string>, key = ''): boolean {
  if (typeof value === 'string') return accounts.has(value)
  if (typeof value === 'number') return /(?:profile|person)Ids?$/i.test(key) && persons.has(value)
  if (Array.isArray(value)) return value.some(item => references(item, persons, accounts, key))
  if (value && typeof value === 'object') return Object.entries(value)
    .some(([field, item]) => references(item, persons, accounts, field))
  return false
}

/** Read only the erasure set plus relationship state needed for a stale-preview check. */
export async function readAccountDeletion(db: Database, scope: ProfileDeletionScope) {
  const identityKeys = new Set((scope.mode === 'identity' ? [scope.targetIdentity!] : scope.identities).map(identityKey))
  const family = new Set(scope.profileIds)
  const erasedPersons = scope.mode === 'profile' ? family : new Set<number>()
  const accounts = (await db.get('xp_account', {})).filter(row => identityKeys.has(identityKey(row)))
  const accountIds = new Set(accounts.map(row => row.id))
  const allSubjects = await db.get('xp_score_subject', {})
  const subjects = allSubjects.filter(row =>
    erasedPersons.has(row.profileId) || (row.accountId !== null && accountIds.has(row.accountId)))
  const subjectIds = new Set(subjects.map(row => row.id))
  const relatedSubjects = allSubjects.filter(row => family.has(row.profileId))
  const relatedIds = new Set(relatedSubjects.map(row => row.id))
  const allLinks = await db.get('xp_journal_subject', {})
  const linkedJournals = new Set(allLinks.filter(row => subjectIds.has(row.subjectId)
    || (row.accountId !== null && accountIds.has(row.accountId))).map(row => row.journalId))
  const allJournals = await db.get('xp_score_journal', {})
  const journals = allJournals.filter(row =>
    erasedPersons.has(row.profileId) || linkedJournals.has(row.id)
      || identityKeys.has(identityKey({ platform: row.actorPlatform, userId: row.actorUserId })))
  const journalIds = new Set(journals.map(row => row.id))
  const operations = (await db.get('xp_account_operation', {})).filter(row => {
    return identityKeys.has(identityKey({ platform: row.actorPlatform, userId: row.actorUserId }))
      || references(JSON.parse(row.snapshot), erasedPersons, accountIds)
  })
  const periodAdjustments = (await db.get('xp_period_adjustment', {})).filter(row => operations.some(o => o.id === row.operationId)
    || references(JSON.parse(row.snapshot), erasedPersons, new Set([...accountIds, ...subjectIds])))
  return {
    profiles: sortRows((await db.get('xp_profile', {})).filter(row => family.has(row.id))),
    relatedSubjects: sortRows(relatedSubjects),
    relatedBalances: sortRows((await db.get('xp_subject_balance', {})).filter(row => relatedIds.has(row.subjectId))),
    relatedPeriodScores: sortRows((await db.get('xp_period_score', {})).filter(row => relatedIds.has(row.subjectId))),
    periodScores: sortRows((await db.get('xp_period_score', {})).filter(row => subjectIds.has(row.subjectId))),
    periodJournals: sortRows((await db.get('xp_period_journal', {})).filter(row => journalIds.has(row.journalId))),
    periodAdjustments: sortRows(periodAdjustments),
    relatedJournals: sortRows(allJournals.filter(row => family.has(row.profileId))),
    identities: sortRows(scope.identities), accounts: sortRows(accounts), subjects: sortRows(subjects),
    preferences: sortRows((await db.get('xp_person_preference', {})).filter(row => family.has(row.profileId))),
    policies: sortRows((await db.get('xp_account_policy', {})).filter(row => family.has(row.profileId))),
    scores: sortRows((await db.get('xp_subject_balance', {})).filter(row => subjectIds.has(row.subjectId))),
    journals: sortRows(journals),
    journalLinks: sortRows(allLinks.filter(row => journalIds.has(row.journalId))),
    operations: sortRows(operations),
    presences: sortRows((await db.get('xp_guild_presence', {})).filter(row => identityKeys.has(identityKey(row)))),
    merges: sortRows((await db.get('xp_profile_merge', {})).filter(row =>
      erasedPersons.has(row.sourceProfileId) || erasedPersons.has(row.targetProfileId))),
  }
}

export async function eraseAccountData(db: Database, scope: ProfileDeletionScope,
  snapshot: Awaited<ReturnType<typeof readAccountDeletion>>) {
  // Tombstones and all detailed deletions commit together. A failed consumer or
  // driver write must not leave a marker for an operation whose detail survived.
  await markErasedOperations(db, 'score', snapshot.journals.map(row => row.mutationId))
  await markErasedOperations(db, 'account', snapshot.operations.map(row => row.id))
  for (const row of snapshot.journals) {
    await db.remove('xp_period_journal', { journalId: row.id })
    await db.remove('xp_journal_subject', { journalId: row.id })
    await db.remove('xp_score_journal', { id: row.id })
  }
  for (const row of snapshot.operations) await db.remove('xp_account_operation', { id: row.id })
  for (const row of snapshot.periodAdjustments) await db.remove('xp_period_adjustment', { id: row.id })
  for (const row of snapshot.subjects) {
    await db.remove('xp_period_score', { subjectId: row.id })
    await db.remove('xp_period_guild_component', { subjectId: row.id })
    await db.remove('xp_subject_balance', { subjectId: row.id })
    await db.remove('xp_score_guild_component', { subjectId: row.id })
    await db.remove('xp_score_subject', { id: row.id })
  }
  for (const identity of scope.mode === 'identity' ? [scope.targetIdentity!] : scope.identities) {
    const key = { platform: identity.platform, userId: identity.userId }
    await db.remove('xp_guild_presence', key)
    await db.remove('xp_identity', key)
    await db.remove('xp_account', key)
  }
  if (scope.mode === 'identity') {
    const deletedIds = new Set(snapshot.accounts.map(row => row.id))
    for (const row of snapshot.preferences) await db.set('xp_person_preference', { profileId: row.profileId }, old => ({
      primaryAccountId: row.primaryAccountId && deletedIds.has(row.primaryAccountId) ? null : row.primaryAccountId,
      revision: $.add(old.revision, 1),
    }))
    await db.set('xp_account_policy', { profileId: scope.profileIds }, row => ({ revision: $.add(row.revision, 1) }))
    return
  }
  for (const profileId of scope.profileIds) {
    await db.remove('xp_account_policy', { profileId })
    await db.remove('xp_person_preference', { profileId })
    await db.remove('xp_profile_merge', { sourceProfileId: profileId })
    await db.remove('xp_profile_merge', { targetProfileId: profileId })
    await db.remove('xp_profile', { id: profileId })
  }
}

function referencesSystem(value: unknown, systemKey: string, key = ''): boolean {
  if (typeof value === 'string') return /systemKey$/i.test(key) && value === systemKey
  if (Array.isArray(value)) return value.some(item => referencesSystem(item, systemKey, key))
  if (value && typeof value === 'object') return Object.entries(value)
    .some(([field, item]) => referencesSystem(item, systemKey, field))
  return false
}

export async function readSystemAccountDeletion(db: Database, systemKey: string) {
  const subjects = await db.get('xp_score_subject', { systemKey })
  const ids = new Set(subjects.map(row => row.id))
  const journals = await db.get('xp_score_journal', { systemKey })
  const journalIds = new Set(journals.map(row => row.id))
  const periods = await db.get('xp_period_definition', { systemKey })
  const periodIds = new Set(periods.map(p => p.id))
  return {
    subjects: sortRows(subjects),
    periodDefinitions: sortRows(periods),
    periodPolicy: sortRows(await db.get('xp_period_policy', { systemKey })),
    periodScores: sortRows((await db.get('xp_period_score', {})).filter(row => ids.has(row.subjectId) || periodIds.has(row.periodId))),
    periodJournals: sortRows((await db.get('xp_period_journal', {})).filter(row => journalIds.has(row.journalId))),
    periodAdjustments: sortRows((await db.get('xp_period_adjustment', {})).filter(row => references(JSON.parse(row.snapshot), new Set(), new Set([...ids, ...periodIds])))),
    balances: sortRows((await db.get('xp_subject_balance', {})).filter(row => ids.has(row.subjectId))),
    policies: sortRows(await db.get('xp_account_policy', { systemKey })),
    journals: sortRows(journals),
    links: sortRows((await db.get('xp_journal_subject', {})).filter(row => journalIds.has(row.journalId))),
    operations: sortRows((await db.get('xp_account_operation', {})).filter(row => referencesSystem(JSON.parse(row.snapshot), systemKey))),
  }
}

export async function eraseSystemAccountData(db: Database, systemKey: string,
  snapshot: Awaited<ReturnType<typeof readSystemAccountDeletion>>) {
  await markErasedOperations(db, 'score', snapshot.journals.map(row => row.mutationId))
  await markErasedOperations(db, 'account', snapshot.operations.map(row => row.id))
  for (const row of snapshot.periodAdjustments) await db.remove('xp_period_adjustment', { id: row.id })
  for (const row of snapshot.periodScores) await db.remove('xp_period_score', { periodId: row.periodId, subjectId: row.subjectId, platform: row.platform, guildId: row.guildId })
  for (const row of snapshot.subjects) {
    await db.remove('xp_period_guild_component', { subjectId: row.id })
    await db.remove('xp_score_guild_component', { subjectId: row.id })
  }
  for (const row of snapshot.periodJournals) await db.remove('xp_period_journal', { journalId: row.journalId })
  await db.remove('xp_period_definition', { systemKey })
  await db.remove('xp_period_policy', { systemKey })
  for (const row of snapshot.operations) await db.remove('xp_account_operation', { id: row.id })
  for (const row of snapshot.journals) await db.remove('xp_journal_subject', { journalId: row.id })
  for (const row of snapshot.subjects) await db.remove('xp_subject_balance', { subjectId: row.id })
  await db.remove('xp_score_subject', { systemKey })
  await db.remove('xp_account_policy', { systemKey })
  await db.remove('xp_score_journal', { systemKey })
  await db.remove('xp_score_guild_component', { systemKey })
  await db.remove('xp_score_guild_alias_policy', { systemKey })
  for (const period of snapshot.periodDefinitions) await db.remove('xp_period_guild_component', { periodId: period.id })
}
