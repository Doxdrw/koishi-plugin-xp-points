import { maintainFixtureIdentity } from './managed-account-fixture'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { App, Context, Service, Logger } from 'koishi'
import * as xpPointsPlugin from '../src/plugin'

type ChatMiddleware = (session: any, context: any) => Promise<number>
type PromptFunction = (
  args: string[],
  variables: Record<string, unknown>,
  configurable: any,
) => string | Promise<string>

let registeredChatMiddleware: ChatMiddleware | undefined
const registeredPromptFunctions = new Map<string, PromptFunction>()
const activeChatMiddleware = new Set<ChatMiddleware>()

class ChatLunaStub extends Service {
  chatChain = {
    middleware: (_name: string, callback: ChatMiddleware, ctx: Context) => {
      registeredChatMiddleware = callback
      activeChatMiddleware.add(callback)
      ctx.on('dispose', () => {
        activeChatMiddleware.delete(callback)
        if (registeredChatMiddleware === callback) registeredChatMiddleware = undefined
      })
      const registration = {
        after: () => registration,
        before: () => registration,
      }
      return registration
    },
  }
  promptRenderer = {
    registerFunctionProvider: (name: string, callback: PromptFunction) => {
      registeredPromptFunctions.set(name, callback)
      return () => registeredPromptFunctions.delete(name)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'chatluna', true)
  }
}

class CharacterStub extends Service {
  collect() {}

  constructor(ctx: Context) {
    super(ctx, 'chatluna_character', true)
  }
}

const apps: App[] = []

afterEach(async () => {
  registeredChatMiddleware = undefined
  registeredPromptFunctions.clear()
  while (apps.length) await apps.pop()!.stop()
  activeChatMiddleware.clear()
})

async function createConsumerApp(): Promise<App> {
  const app = new App({ autoAssign: true, autoAuthorize: 1 })
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(ChatLunaStub)
  app.plugin(CharacterStub)
  app.plugin(xpPointsPlugin, {
    scoreSystems: [],
    scoreCommandBindings: [],
    scoreGuildAliases: {},
    nicknameConsumers: {
      chatluna: { enabled: true, guilds: ['g1'], includePrivate: false },
      chatlunaCharacter: { enabled: true, guilds: ['g1'], includePrivate: false },
    },
  })
  await app.start()
  apps.push(app)
  await maintainFixtureIdentity(app, 'onebot', '1001', 'Alice')
  return app
}

describe('nickname consumer hooks', () => {
  it('waits silently for late services and disposes/reconnects each hook exactly once', async () => {
    const records: Logger.Record[] = []
    const loggerTarget = { record: (record: Logger.Record) => records.push(record), levels: { base: 3 } }
    Logger.targets.push(loggerTarget)
    const app = new App()
    apps.push(app)
    app.plugin(SQLiteDriver, { path: ':memory:' })
    app.plugin(xpPointsPlugin, {
      nicknameConsumers: {
        chatluna: { enabled: true, guilds: [], includePrivate: false },
        chatlunaCharacter: { enabled: true, guilds: [], includePrivate: false },
      },
    })
    try {
      await app.start()
      assert.equal(records.some(record => record.type === 'warn' && /昵称适配/.test(record.content)), false)
      assert.ok(records.some(record => /等待 chatluna 服务/.test(record.content)))
      assert.ok(records.some(record => /等待 chatluna_character 服务/.test(record.content)))
      await maintainFixtureIdentity(app, 'onebot', '1001', 'Alice')
      const session = { platform: 'onebot', userId: '1001', guildId: 'g', selfId: 'bot', bot: { selfId: 'bot' } }
      for (let pass = 0; pass < 2; pass++) {
        const chat = app.plugin(ChatLunaStub)!
        const character = app.plugin(CharacterStub)!
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(activeChatMiddleware.size, 1)
        assert.equal(registeredPromptFunctions.size, 1)
        const context = { options: {} as any }
        await registeredChatMiddleware!(session, context)
        assert.equal(context.options.messageName, 'Alice')
        let writes = 0
        const message = { id: '1001', get name() { return 'native' }, set name(_name: string) { writes++ } }
        await (app as any).parallel('chatluna_character/message_collect', session, [message])
        assert.equal(writes, 1)
        await chat.dispose()
        await character.dispose()
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(activeChatMiddleware.size, 0)
        assert.equal(registeredPromptFunctions.size, 0)
        await (app as any).parallel('chatluna_character/message_collect', session, [message])
        assert.equal(writes, 1)
      }
      assert.equal(records.some(record => record.type === 'warn' && /昵称适配/.test(record.content)), false)
    } finally { Logger.targets.splice(Logger.targets.indexOf(loggerTarget), 1) }
  })

  it('reports missing third-party hooks instead of silently assuming compatibility', () => {
    assert.deepEqual(xpPointsPlugin.chatLunaCompatibilityIssues({}), [
      '缺少 promptRenderer.registerFunctionProvider，{sender_name} 不会生效。',
      '缺少 chatChain.middleware，普通对话 messageName 不会生效。',
    ])
    assert.deepEqual(xpPointsPlugin.characterCompatibilityIssues({}), [
      '缺少 MessageCollector.collect，message_collect 事件契约可能已经变化。',
    ])
    assert.deepEqual(xpPointsPlugin.chatLunaCompatibilityIssues({
      promptRenderer: { registerFunctionProvider() {} },
      chatChain: { middleware() {} },
    }), [])
  })

  it('sets ChatLuna messageName without overriding explicit or task names', async () => {
    const app = await createConsumerApp()
    assert.ok(registeredChatMiddleware)
    const session = {
      platform: 'onebot',
      userId: '1001',
      guildId: 'g1',
      isDirect: false,
    }

    const managed = { options: {} }
    assert.equal(await registeredChatMiddleware!(session, managed), 2)
    assert.equal(managed.options.messageName, 'Alice')

    const explicit = { options: { messageName: 'Explicit' } }
    await registeredChatMiddleware!(session, explicit)
    assert.equal(explicit.options.messageName, 'Explicit')

    const task = { options: { invocation: { source: { kind: 'agent-task' } } } }
    await registeredChatMiddleware!(session, task)
    assert.equal(task.options.messageName, undefined)
  })

  it('provides a managed sender_name template symbol with native fallback', async () => {
    await createConsumerApp()
    const senderName = registeredPromptFunctions.get('sender_name')
    assert.ok(senderName)

    const managedSession = {
      platform: 'onebot',
      userId: '1001',
      guildId: 'g1',
      isDirect: false,
      author: { nick: 'platform-card', name: 'platform-name' },
    }
    assert.equal(await senderName!([], {}, { session: managedSession }), 'Alice')

    const outsideWhitelist = { ...managedSession, guildId: 'g2' }
    assert.equal(await senderName!([], {}, { session: outsideWhitelist }), 'platform-name')

    const unknownUser = { ...managedSession, userId: '1002' }
    assert.equal(await senderName!([], {}, { session: unknownUser }), 'platform-name')
  })

  it('rewrites Character live/history names but preserves bot identities', async () => {
    const app = await createConsumerApp()
    const session = {
      platform: 'onebot',
      userId: '1001',
      guildId: 'g1',
      isDirect: false,
      selfId: 'bot',
      bot: { selfId: 'bot' },
    }
    const messages = [
      { id: '1001', name: 'platform-name' },
      { id: 'bot', name: 'assistant' },
    ]
    await (app as any).parallel('chatluna_character/message_collect', session, messages)
    assert.deepEqual(messages.map(message => message.name), ['Alice', 'assistant'])
  })
})
