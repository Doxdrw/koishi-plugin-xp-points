import { createHash } from 'node:crypto'
import type { Context } from 'koishi'
import './account-model'

type Database = Context['database']
type Domain = 'score' | 'account'

// Domain-separated one-way digests retain no account, person, system, amount,
// request body or erasure time. Never use them to return an old result.
function digest(domain: Domain, id: string): string {
  return createHash('sha256').update(JSON.stringify(['xp-erased-v1', domain, id])).digest('hex')
}

export async function markErasedOperations(db: Database, domain: Domain, ids: readonly string[]) {
  const rows = [...new Set(ids)].map(id => ({ digest: digest(domain, id) }))
  if (rows.length) await db.upsert('xp_erased_operation', rows)
}

export async function assertOperationNotErased(db: Database, domain: Domain, id: string) {
  if ((await db.get('xp_erased_operation', { digest: digest(domain, id) })).length) {
    throw new Error('该操作的详细记录已经删除，禁止重试或再次计分。')
  }
}
