import { maintainFixtureIdentity } from './managed-account-fixture'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { App } from 'koishi'
import * as xpPointsPlugin from '../src/plugin'
import type { LeaderboardInactivePolicy } from '../src/service'

const apps: App[] = []

async function createApp(policy: LeaderboardInactivePolicy = 'hide'): Promise<App> {
  const app = new App({ autoAssign: true, autoAuthorize: 1 })
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(xpPointsPlugin, {
    scoreSystems: [{ key: 'primary', name: '测试积分', unit: '分', scope: 'guild' }],
    scoreCommandBindings: [],
    scoreGuildAliases: { primary: { onebot: { source: 'shared' } } },
    leaderboardInactivePolicy: policy,
    nicknameConsumers: {
      chatluna: { enabled: false, guilds: [], includePrivate: false },
      chatlunaCharacter: { enabled: false, guilds: [], includePrivate: false },
    },
  })
  await app.start()
  apps.push(app)
  return app
}

afterEach(async () => {
  while (apps.length) await apps.pop()!.stop()
})

async function makeScoredIdentity(app: App, userId: string, nickname: string) {
  const identity = await app.xpPoints.ensureManagedGuildIdentity('onebot', userId, 'source', nickname)
  await setScore(app, identity.accountId, 'source', 5)
  return identity
}

function scoreContext(guildId: string) {
  return { platform: 'onebot', guildId }
}

function setScore(app: App, accountId: string, guildId: string, value: number) {
  return app.xpPoints.setAccountScore('primary', { accountId }, value, {
    ...scoreContext(guildId), source: 'test', reason: 'seed',
  })
}

function getScore(app: App, accountId: string, guildId: string) {
  return app.xpPoints.getAccountScore('primary', { accountId }, scoreContext(guildId))
}

function getLeaderboard(app: App, guildId: string) {
  return app.xpPoints.getScoreLeaderboard('primary', scoreContext(guildId))
}

describe('guild-scoped reversible xp presence', () => {
  it('soft-disables a leaver and restores the complete profile on rejoin', async () => {
    const app = await createApp()
    const identity = await makeScoredIdentity(app, '1001', 'Alice')
    assert.equal((await getLeaderboard(app, 'source')).length, 1)

    await app.xpPoints.markGuildPresence('onebot', 'source', '1001', 'inactive', 'member-removed')
    assert.deepEqual(await getLeaderboard(app, 'source'), [])
    assert.equal(await getScore(app, identity.accountId, 'source'), 5)
    assert.equal((await app.xpPoints.getManagedIdentity('onebot', '1001'))?.nickname, 'Alice')
    const inactive = await app.xpPoints.getGuildPresence('onebot', 'source', '1001')
    assert.equal(inactive?.state, 'inactive')
    assert.ok(inactive?.inactiveAt)

    await app.xpPoints.markGuildPresence('onebot', 'source', '1001', 'active', 'member-added')
    assert.equal((await getLeaderboard(app, 'source')).length, 1)
    const active = await app.xpPoints.getGuildPresence('onebot', 'source', '1001')
    assert.equal(active?.state, 'active')
    assert.equal(active?.inactiveAt, null)
    assert.deepEqual(await app.database.get('xp_subject_balance', {}), [{
      subjectId: (await app.database.get('xp_score_subject', { profileId: identity.profileId, active: true }))[0].id,
      platform: 'onebot',
      guildId: 'shared',
      value: 5,
      updatedAt: (await app.database.get('xp_subject_balance', {}))[0].updatedAt,
    }])
  })

  it('keeps a shared profile active while any alternate account is usable', async () => {
    const app = await createApp()
    const identity = await makeScoredIdentity(app, '1001', 'Alice')
    await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    await app.xpPoints.markGuildPresence('onebot', 'source', '1001', 'inactive', 'member-removed')
    assert.equal((await getLeaderboard(app, 'source')).length, 1)
    await app.xpPoints.markGuildPresence('onebot', 'source', '1002', 'inactive', 'member-removed')
    assert.deepEqual(await getLeaderboard(app, 'source'), [])
    assert.equal(await getScore(app, identity.accountId, 'source'), 5)
  })

  it('isolates raw guild presence even when scores share one alias target', async () => {
    const app = await createApp()
    await makeScoredIdentity(app, '1001', 'Alice')
    await app.xpPoints.markGuildPresence('onebot', 'source', '1001', 'inactive', 'member-removed')
    assert.deepEqual(await getLeaderboard(app, 'source'), [])
    assert.equal((await getLeaderboard(app, 'shared')).length, 1)
  })

  it('evaluates a global leaderboard against the actual query platform and guild', async () => {
    const app = await createApp()
    await app.xpPoints.createScoreSystem({ key: 'global-test', name: '全局分', scope: 'global' }, 'test')
    const identity = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    await maintainFixtureIdentity(app, 'discord', '2001', 'Alice')
    await app.xpPoints.setAccountScore('global-test', { accountId: identity.accountId }, 5, {
      source: 'test', reason: 'seed', platform: 'onebot', guildId: 'source',
    })
    await app.xpPoints.markGuildPresence('onebot', 'source', '1001', 'inactive', 'member-removed')

    assert.deepEqual(await app.xpPoints.getScoreLeaderboard('global-test', {
      platform: 'onebot', guildId: 'source',
    }), [])
    assert.equal((await app.xpPoints.getScoreLeaderboard('global-test', {
      platform: 'discord', guildId: 'discord-guild',
    })).length, 1)
  })

  it('treats authority zero as dynamically inactive and restores it at authority one', async () => {
    const app = await createApp()
    await app.database.createUser('onebot', '1001', { authority: 1 })
    await makeScoredIdentity(app, '1001', 'Alice')
    assert.equal((await getLeaderboard(app, 'source')).length, 1)
    await app.database.setUser('onebot', '1001', { authority: 0 })
    assert.deepEqual(await getLeaderboard(app, 'source'), [])
    await app.database.setUser('onebot', '1001', { authority: 1 })
    assert.equal((await getLeaderboard(app, 'source')).length, 1)
  })

  it('can show inactive profiles without changing stored points', async () => {
    const app = await createApp('show')
    await makeScoredIdentity(app, '1001', 'Alice')
    await app.xpPoints.markGuildPresence('onebot', 'source', '1001', 'inactive', 'member-removed')
    assert.deepEqual(await getLeaderboard(app, 'source'), [{
      profileId: 1,
      nickname: 'Alice',
      value: 5,
      inactive: true,
    }])
  })

  it('does not hide unknown upgraded data until absence is confirmed', async () => {
    const app = await createApp()
    const identity = await app.xpPoints.ensureManagedIdentity('onebot', '1001', 'Alice')
    await setScore(app, identity.accountId, 'source', 5)
    assert.equal(await app.xpPoints.getGuildPresence('onebot', 'source', '1001'), null)
    assert.equal((await getLeaderboard(app, 'source')).length, 1)
  })

  it('keeps scan failure and dry-run strictly read-only, then commits a complete scan', async () => {
    const app = await createApp()
    await makeScoredIdentity(app, '1001', 'Alice')
    await maintainFixtureIdentity(app, 'onebot', '1002', 'Alice')
    await assert.rejects(
      app.xpPoints.scanGuildMembers({
        async *getGuildMemberIter() {
          yield { user: { id: '1001' } } as any
          throw new Error('成员页读取失败：Authorization=Bearer synthetic-credential C:/fixture/private.json')
        },
      }, 'onebot', 'source', true),
      (error: Error) => {
        assert.match(error.message, /未修改任何状态/)
        assert.doesNotMatch(error.message, /synthetic-credential|private\.json|Authorization/)
        return true
      },
    )
    assert.equal((await app.database.get('xp_guild_presence', {})).length, 1)

    await app.database.remove('xp_guild_presence', {})
    const bot = {
      async *getGuildMemberIter() {
        yield { user: { id: '1001' } } as any
      },
    }
    const preview = await app.xpPoints.scanGuildMembers(bot, 'onebot', 'source')
    assert.equal(preview.executed, false)
    assert.deepEqual(preview.changes.map(change => [change.userId, change.next]), [
      ['1001', 'active'],
      ['1002', 'inactive'],
    ])
    assert.deepEqual(await app.database.get('xp_guild_presence', {}), [])

    const executed = await app.xpPoints.scanGuildMembers(bot, 'onebot', 'source', true)
    assert.equal(executed.executed, true)
    assert.deepEqual((await app.database.get('xp_guild_presence', {}))
      .map(row => [row.userId, row.state]), [
      ['1001', 'active'],
      ['1002', 'inactive'],
    ])
  })

  it('applies join and leave events without creating or deleting profiles', async () => {
    const app = await createApp()
    await makeScoredIdentity(app, '1001', 'Alice')
    app.emit('guild-member-removed', {
      platform: 'onebot',
      guildId: 'source',
      userId: '1001',
      selfId: 'koishi',
    } as any)
    await waitFor(async () => (await app.xpPoints.getGuildPresence('onebot', 'source', '1001'))?.state === 'inactive')
    assert.deepEqual(await getLeaderboard(app, 'source'), [])

    app.emit('guild-member-added', {
      platform: 'onebot',
      guildId: 'source',
      userId: '1001',
      selfId: 'koishi',
    } as any)
    await waitFor(async () => (await app.xpPoints.getGuildPresence('onebot', 'source', '1001'))?.state === 'active')
    assert.equal((await getLeaderboard(app, 'source')).length, 1)
    assert.equal((await app.database.get('xp_profile', {})).length, 1)
  })
})

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('等待成员事件状态更新超时')
}
