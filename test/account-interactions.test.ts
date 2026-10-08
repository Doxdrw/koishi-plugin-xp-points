import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AccountConfirmationCoordinator, AccountOccupancyRegistry } from '../src/account-interactions'

const actor = { platform: 'onebot', userId: 'admin', selfId: 'bot', channelId: 'group', isDirect: false }

describe('staged account confirmations and occupancy', () => {
  it('binds exact tokens to the original account/bot/platform/channel and leaves unrelated input alone', async () => {
    const coordinator = new AccountConfirmationCoordinator<{ next: string }>()
    const request = { next: 'shared' }
    const { token } = coordinator.issue(actor, request, 'snapshot')
    request.next = 'changed'
    assert.equal(coordinator.matches('hello'), false)
    assert.equal(coordinator.matches(token + ' trailing text'), false)
    assert.equal(coordinator.matches(token), true)
    for (const other of [{ ...actor, userId: 'other' }, { ...actor, selfId: 'other' }, { ...actor, platform: 'other' },
      { ...actor, channelId: 'other' }, { ...actor, isDirect: true }]) {
      await assert.rejects(coordinator.confirm(token, other, async () => { throw new Error('must not run') }), /原操作者/)
    }
    assert.equal(await coordinator.confirm(token, actor, async (data, fingerprint, assertFresh) => {
      assertFresh()
      assert.equal(data.next, 'shared')
      assert.equal(fingerprint, 'snapshot')
      return 7
    }), 7)
    await assert.rejects(coordinator.confirm(token, actor, async () => 0), /已经使用/)
  })

  it('single-flights concurrent confirmations and does not replay a failed execution', async () => {
    const coordinator = new AccountConfirmationCoordinator<{}>()
    const { token } = coordinator.issue(actor, {}, 'snapshot')
    let calls = 0
    let release!: () => void
    const done = new Promise<void>(resolve => { release = resolve })
    const execute = async () => { calls++; await done; return 'ok' }
    const first = coordinator.confirm(token, actor, execute)
    const second = coordinator.confirm(token, actor, execute)
    release()
    assert.deepEqual(await Promise.all([first, second]), ['ok', 'ok'])
    assert.equal(calls, 1)
    const failure = coordinator.issue(actor, {}, 'snapshot')
    await assert.rejects(coordinator.confirm(failure.token, actor, async () => { throw new Error('rollback') }), /rollback/)
    await assert.rejects(coordinator.confirm(failure.token, actor, execute), /重新预览/)
  })

  it('expires at five minutes and provides a freshness guard for queued transactions and disposal', async () => {
    let now = 0
    const coordinator = new AccountConfirmationCoordinator<{}>(() => now)
    const expired = coordinator.issue(actor, {}, 'snapshot')
    assert.equal(expired.expiresAt.getTime(), 300_000)
    now = 300_000
    await assert.rejects(coordinator.confirm(expired.token, actor, async () => 0), /过期/)
    const queued = coordinator.issue(actor, {}, 'snapshot')
    await assert.rejects(coordinator.confirm(queued.token, actor, async (_r, _f, assertFresh) => {
      now += 300_000
      assertFresh()
    }), /过期/)
    const disposed = coordinator.issue(actor, {}, 'snapshot')
    await assert.rejects(coordinator.confirm(disposed.token, actor, async (_r, _f, assertFresh) => {
      coordinator.clear()
      assertFresh()
    }), /取消/)
  })

  it('retains independent consumer leases and blocks either an account or its whole person', () => {
    const registry = new AccountOccupancyRegistry()
    const scope = { profileIds: [1], accountIds: ['a'] }
    const first = registry.acquire('game-one', scope)
    scope.profileIds[0] = 99
    const second = registry.acquire('game-two', { profileIds: [1], accountIds: ['b'] })
    assert.throws(() => registry.assertMutable({ profileIds: [1], accountIds: ['alt'] }), /game-one.*game-two/)
    assert.throws(() => registry.assertMutable({ profileIds: [2], accountIds: ['a'] }), /game-one/)
    registry.assertMutable({ profileIds: [2], accountIds: ['unrelated'] })
    first(); first()
    assert.throws(() => registry.assertMutable({ profileIds: [1], accountIds: ['a'] }), /game-two/)
    second()
    registry.assertMutable({ profileIds: [1], accountIds: ['a'] })
  })

  it('releases only the unloaded consumer and validates registration identity', () => {
    const registry = new AccountOccupancyRegistry()
    assert.throws(() => registry.acquire('game', { profileIds: [], accountIds: [] }), /缺少/)
    registry.acquire('one', { profileIds: [1], accountIds: ['a'] })
    registry.acquire('two', { profileIds: [2], accountIds: ['b'] })
    registry.releaseConsumer('one')
    registry.assertMutable({ profileIds: [1], accountIds: ['a'] })
    assert.throws(() => registry.assertMutable({ profileIds: [2], accountIds: ['b'] }), /two/)
    registry.clear()
    registry.assertMutable({ profileIds: [2], accountIds: ['b'] })
  })
})
