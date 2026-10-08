import assert from 'node:assert/strict'
import { it } from 'node:test'
import { planPersonAssociation, type PersonAssociationInput } from '../src/account-association-policy'

function fixture(): PersonAssociationInput {
  return { kind: 'merge-persons', nextMode: 'shared', strategy: 'maximum',
    source: { profileId: 1, mode: 'shared', accounts: ['a', 'b'], subjects: [
      { id: 's1', accountId: null, active: true }, { id: 'old', accountId: 'a', active: false }],
    balances: [{ subjectId: 's1', platform: 'onebot', guildId: 'g', value: 10.5 }] },
    target: { profileId: 2, mode: 'independent', accounts: ['c', 'd'], subjects: [
      { id: 's2', accountId: 'c', active: true }, { id: 's3', accountId: 'd', active: true }],
    balances: [{ subjectId: 's2', platform: 'onebot', guildId: 'g', value: 7 },
      { subjectId: 's3', platform: 'elsewhere', guildId: 'g', value: 13 }] },
    destinations: [{ id: 'new', accountId: null }] }
}
function independent(): PersonAssociationInput {
  const input = fixture()
  input.nextMode = 'independent'
  input.source.retainedAccountId = 'b'
  input.destinations = ['a', 'b', 'c', 'd'].map(accountId => ({ id: `new-${accountId}`, accountId }))
  return input
}

it('association maximum is per pool, uses each live subject once and leaves inputs unchanged', () => {
  const input = fixture(), before = structuredClone(input)
  const result = planPersonAssociation(input)
  assert.deepEqual(result.retire, ['s1', 's2', 's3'])
  assert.deepEqual(result.balances.map(row => row.value), [13, 10.5])
  assert.deepEqual(result.accountIds, ['a', 'b', 'c', 'd'])
  assert.deepEqual(result.pools[0].sources.map(row => row.value), [0, 0, 13])
  assert.deepEqual(input, before)
})

it('explicit sum combines shared subjects once rather than once per associated account', () => {
  const result = planPersonAssociation({ ...fixture(), strategy: 'sum' })
  assert.deepEqual(result.balances.map(row => row.value), [13, 17.5])
  assert.equal(result.targetProfileId, 2)
})

it('independent association preserves each account score and transfers shared pools only to its chosen owner', () => {
  for (const strategy of ['maximum', 'sum'] as const) {
    const result = planPersonAssociation({ ...independent(), strategy })
    assert.deepEqual(result.balances, [
      { subjectId: 'new-d', platform: 'elsewhere', guildId: 'g', value: 13 },
      { subjectId: 'new-b', platform: 'onebot', guildId: 'g', value: 10.5 },
      { subjectId: 'new-c', platform: 'onebot', guildId: 'g', value: 7 },
    ])
  }
})

it('each shared person requires its own recipient even with no points; no guessing another group owner', () => {
  const input = independent()
  input.source.balances = []
  delete input.source.retainedAccountId
  assert.throws(() => planPersonAssociation(input), /承接/)
  input.source.retainedAccountId = 'c'
  assert.throws(() => planPersonAssociation(input), /承接/)
  input.source.retainedAccountId = 'a'
  input.target.mode = 'shared'
  input.target.subjects = [{ id: 's2', accountId: null, active: true }]
  input.target.balances = []
  assert.throws(() => planPersonAssociation(input), /承接/)
  input.target.retainedAccountId = 'd'
  assert.deepEqual(planPersonAssociation(input).balances, [])
})

it('negative losses are explicit for maximum and retained for independent association', () => {
  const input = fixture()
  input.source.balances = [{ subjectId: 's1', platform: '', guildId: '', value: -9 }]
  input.target.balances = []
  const result = planPersonAssociation(input)
  assert.deepEqual(result.balances, [])
  assert.deepEqual(result.pools[0].discardedNegativeSources, [{ subjectId: 's1', value: -9 }])
  const split = independent()
  split.source.balances = input.source.balances
  split.target.balances = []
  assert.equal(planPersonAssociation(split).balances[0].value, -9)
})

it('refuses partial, overlapping, retired or malformed source and destination ownership', () => {
  const input = fixture()
  assert.throws(() => planPersonAssociation({ ...input, kind: 'move-account' as any }), /明确/)
  assert.throws(() => planPersonAssociation({ ...input, target: { ...input.target, profileId: 1 } }), /不同/)
  assert.throws(() => planPersonAssociation({ ...input, target: { ...input.target, accounts: ['a', 'd'] } }), /重复/)
  assert.throws(() => planPersonAssociation({ ...input, source: { ...input.source, accounts: [] } }), /没有账号/)
  assert.throws(() => planPersonAssociation({ ...input, target: { ...input.target, subjects: input.target.subjects.slice(1) } }), /一一对应/)
  assert.throws(() => planPersonAssociation({ ...input, source: { ...input.source, balances: [
    { subjectId: 'old', platform: '', guildId: '', value: 1000 }] } }), /退休/)
  assert.throws(() => planPersonAssociation({ ...input, destinations: [{ id: 'old', accountId: null }] }), /复用/)
  const split = independent()
  split.destinations = split.destinations.slice(1)
  assert.throws(() => planPersonAssociation(split), /全部账号/)
})

it('refuses duplicate pools, unknown modes, nonfinite balances and overflowing sums or audit differences', () => {
  const input = fixture()
  assert.throws(() => planPersonAssociation({ ...input, nextMode: 'other' as any }), /未知/)
  assert.throws(() => planPersonAssociation({ ...input, source: { ...input.source,
    balances: [...input.source.balances, ...input.source.balances] } }), /重复/)
  for (const value of [Infinity, NaN]) assert.throws(() => planPersonAssociation({ ...input,
    source: { ...input.source, balances: [{ subjectId: 's1', platform: '', guildId: '', value }] } }), /有限/)
  input.source.balances = [{ subjectId: 's1', platform: '', guildId: '', value: Number.MAX_VALUE }]
  input.target.balances = [{ subjectId: 's2', platform: '', guildId: '', value: Number.MAX_VALUE }]
  assert.throws(() => planPersonAssociation({ ...input, strategy: 'sum' }), /有限/)
  input.target.balances[0].value = -Number.MAX_VALUE
  assert.throws(() => planPersonAssociation(input), /有限/)
})

it('input row order cannot alter preview or floating-point reduction order', () => {
  const input = independent()
  const expected = planPersonAssociation(input)
  input.source.accounts = [...input.source.accounts].reverse()
  input.target.accounts = [...input.target.accounts].reverse()
  input.target.subjects = [...input.target.subjects].reverse()
  input.target.balances = [...input.target.balances].reverse()
  input.destinations = [...input.destinations].reverse()
  assert.deepEqual(planPersonAssociation(input), expected)
})
