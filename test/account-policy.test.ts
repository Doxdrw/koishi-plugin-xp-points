import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planScoreModeConversion, type ConversionInput } from '../src/account-policy'

const base = (): ConversionInput => ({
  mode: 'independent', nextMode: 'shared', accounts: ['main', 'alt'],
  subjects: [
    { id: 'first', accountId: 'main', active: true },
    { id: 'second', accountId: 'alt', active: true },
    { id: 'retired', accountId: null, active: false },
  ],
  balances: [
    { subjectId: 'first', platform: 'onebot', guildId: 'a', value: 10.5 },
    { subjectId: 'second', platform: 'onebot', guildId: 'a', value: 7 },
    { subjectId: 'second', platform: 'other', guildId: 'b', value: 12 },
  ],
  destinations: [{ id: 'new-shared', accountId: null }],
  strategy: 'maximum', actor: 'self',
})

describe('account score conversion policy', () => {
  it('takes maxima independently per platform/pool without mutating inputs', () => {
    const input = base()
    const before = structuredClone(input)
    const result = planScoreModeConversion(input)
    assert.deepEqual(input, before)
    assert.deepEqual(result.retire, ['first', 'second'])
    assert.deepEqual(result.balances.map(row => row.value), [10.5, 12])
    assert.equal(result.pools[1].sources.find(row => row.subjectId === 'first')?.value, 0)
  })

  it('permits administrator sum but never a self-service sum', () => {
    assert.throws(() => planScoreModeConversion({ ...base(), strategy: 'sum' }), /本人/)
    const result = planScoreModeConversion({ ...base(), strategy: 'sum', actor: 'administrator' })
    assert.deepEqual(result.balances.map(row => row.value), [17.5, 12])
  })

  it('assigns every shared pool only to the selected retained account', () => {
    const first = planScoreModeConversion(base())
    const result = planScoreModeConversion({
      ...base(), mode: 'shared', nextMode: 'independent',
      subjects: [{ id: 'new-shared', accountId: null, active: true }],
      balances: first.balances, retainedAccountId: 'alt',
      destinations: [{ id: 'new-main', accountId: 'main' }, { id: 'new-alt', accountId: 'alt' }],
    })
    assert.deepEqual(result.balances.map(row => row.subjectId), ['new-alt', 'new-alt'])
    assert.deepEqual(result.balances.map(row => row.value), [10.5, 12])
  })

  it('cannot increase nonnegative balances through repeated split and recombination', () => {
    let subjects = [{ id: 's0', accountId: null, active: true }]
    let balances = [{ subjectId: 's0', platform: '', guildId: '', value: 100 }]
    for (let step = 1; step <= 20; step++) {
      const destinations = [{ id: `a${step}`, accountId: 'main' }, { id: `b${step}`, accountId: 'alt' }]
      const split = planScoreModeConversion({ ...base(), mode: 'shared', nextMode: 'independent',
        subjects, balances, destinations, retainedAccountId: step % 2 ? 'alt' : 'main' })
      const merged = planScoreModeConversion({ ...base(), subjects: destinations.map(row => ({ ...row, active: true })),
        balances: split.balances, destinations: [{ id: `s${step}`, accountId: null }],
        // Even administrator sum cannot resurrect a discarded balance.
        actor: 'administrator', strategy: 'sum' })
      assert.equal(merged.balances[0].value, 100)
      subjects = [{ id: `s${step}`, accountId: null, active: true }]
      balances = merged.balances
    }
  })

  it('rejects self-service negative conversion and makes discarded negatives explicit to administrators', () => {
    const input = base()
    input.balances = [{ subjectId: 'first', platform: '', guildId: '', value: -10 }]
    assert.throws(() => planScoreModeConversion(input), /负分/)
    const result = planScoreModeConversion({ ...input, actor: 'administrator' })
    assert.deepEqual(result.balances, [])
    assert.equal(result.pools[0].value, 0)
    assert.deepEqual(result.pools[0].sources.map(row => row.value), [-10, 0])
  })

  it('refuses retired balances, reused destination IDs and malformed ownership', () => {
    assert.throws(() => planScoreModeConversion({ ...base(), balances: [
      { subjectId: 'retired', platform: '', guildId: '', value: 1000 },
    ] }), /退休/)
    assert.throws(() => planScoreModeConversion({ ...base(), destinations: [{ id: 'retired', accountId: null }] }), /复用/)
    assert.throws(() => planScoreModeConversion({ ...base(), accounts: ['main', 'main'] }), /重复/)
    assert.throws(() => planScoreModeConversion({ ...base(), subjects: [
      { id: 'first', accountId: 'main', active: true },
    ] }), /一一对应/)
  })

  it('refuses non-finite arithmetic, duplicate balances and invalid runtime enum values', () => {
    const input = base()
    assert.throws(() => planScoreModeConversion({ ...input, balances: [...input.balances, input.balances[0]] }), /重复/)
    assert.throws(() => planScoreModeConversion({ ...input, strategy: 'unknown' as any }), /未知/)
    assert.throws(() => planScoreModeConversion({ ...input, actor: 'administrator', strategy: 'sum', balances: [
      { subjectId: 'first', platform: '', guildId: '', value: Number.MAX_VALUE },
      { subjectId: 'second', platform: '', guildId: '', value: Number.MAX_VALUE },
    ] }), /有限/)
    assert.throws(() => planScoreModeConversion({ ...input, actor: 'administrator', balances: [
      { subjectId: 'first', platform: '', guildId: '', value: Number.MAX_VALUE },
      { subjectId: 'second', platform: '', guildId: '', value: -Number.MAX_VALUE },
    ] }), /有限/)
  })

  it('requires explicit recipient even for empty shared balances', () => {
    const input: ConversionInput = { ...base(), mode: 'shared', nextMode: 'independent',
      subjects: [{ id: 'shared', accountId: null, active: true }], balances: [],
      destinations: [{ id: 'main-new', accountId: 'main' }, { id: 'alt-new', accountId: 'alt' }] }
    assert.throws(() => planScoreModeConversion(input), /承接/)
    assert.deepEqual(planScoreModeConversion({ ...input, retainedAccountId: 'main' }).balances, [])
  })
})
