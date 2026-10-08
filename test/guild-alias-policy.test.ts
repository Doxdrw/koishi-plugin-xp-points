import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  combineGuildAliasValues,
  normalizeGuildAliasPolicy,
  normalizeGuildAliasStrategy,
  planGuildAliasValues,
} from '../src/guild-alias-policy'

describe('guild alias combine policy', () => {
  it('keeps maximum as the default and supports signed decimals', () => {
    assert.deepEqual(normalizeGuildAliasPolicy(), { balance: 'maximum', period: 'maximum' })
    assert.equal(combineGuildAliasValues([2.5, -4, 3], 'maximum'), 3)
    assert.equal(combineGuildAliasValues([2.5, -4, 3], 'sum'), 1.5)
  })

  it('normalizes and rejects invalid strategies', () => {
    assert.equal(normalizeGuildAliasStrategy('sum'), 'sum')
    assert.throws(() => normalizeGuildAliasStrategy('add'), /maximum.*sum/)
    assert.throws(() => combineGuildAliasValues([Number.POSITIVE_INFINITY], 'maximum'), /有限数值/)
  })

  it('returns deterministic source ordering without mutating the input', () => {
    const input = [{ key: 'z', value: 2 }, { key: 'a', value: 1 }]
    const plan = planGuildAliasValues(input, 'sum')
    assert.deepEqual(input, [{ key: 'z', value: 2 }, { key: 'a', value: 1 }])
    assert.deepEqual(plan.values, [{ key: 'a', value: 1 }, { key: 'z', value: 2 }])
    assert.equal(plan.before, 3)
    assert.equal(plan.after, 3)
  })
})
