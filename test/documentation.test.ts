import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'
import SQLiteDriver from '@koishijs/plugin-database-sqlite'
import { App, type Context } from 'koishi'
import ts from 'typescript'
import * as plugin from '../src/plugin'
import { consumerApplies, chooseChatLunaMessageName, rewriteCharacterMessageNames } from '../src/core'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (file: string) => readFileSync(join(root, file), 'utf8')
const snippets = (file: string, language: string) => [...read(file).matchAll(
  new RegExp('```' + language + '\\r?\\n([\\s\\S]*?)```', 'g'),
)].map(match => match[1])

it('validates every README configuration example with the real plugin schema', () => {
  const examples = snippets('README.md', 'json').map(source => plugin.Config(JSON.parse(source)))
  assert.ok(examples.length >= 4)
  const names = examples.find(config => config.nicknameConsumers.chatluna.enabled)!
  assert.ok(names.nicknameConsumers.chatlunaCharacter.enabled)
  assert.equal(consumerApplies(names.nicknameConsumers.chatluna, { guildId: 'example' }), true)
  assert.equal(consumerApplies(names.nicknameConsumers.chatluna, { isDirect: true }), false)
  assert.equal(chooseChatLunaMessageName('explicit', 'chat', 'managed'), 'explicit')
  const messages = [{ id: 'human', name: 'native' }, { id: 'bot', name: 'assistant' }]
  rewriteCharacterMessageNames(messages, 'onebot', () => 'managed', new Set(['bot']))
  assert.deepEqual(messages.map(message => message.name), ['managed', 'assistant'])
  const bindings = examples.find(config => config.scoreCommandBindings.length)!
  assert.deepEqual(bindings.scoreCommandBindings[0].leaderboard, ['积分榜'])
  const periods = examples.find(config => config.scorePeriods.event?.season?.length === 3)!
  assert.equal(periods.scorePeriods.event.season.unit, 'month')
})

it('typechecks the documented consumer against the current public API', () => {
  const [source] = snippets('docs/INTEGRATION.md', 'ts')
  assert.ok(source)
  const filename = join(root, '__documentation_example__.ts').replaceAll('\\', '/')
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, noEmit: true, skipLibCheck: true,
    esModuleInterop: true, baseUrl: root, paths: { 'koishi-plugin-xp-points': ['src/plugin.ts'] } }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, language, onError, create) => file === filename
    ? ts.createSourceFile(file, source, language, true) : original(file, language, onError, create)
  const program = ts.createProgram([filename], options, host)
  const errors = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error)
  assert.deepEqual(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [])
})

it('loads, retries and unloads the documented consumer with a non-default system key', async () => {
  const source = snippets('docs/INTEGRATION.md', 'ts')[0]
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: Record<string, any> = {}
  new Function('exports', 'require', output)(exports, createRequire(join(root, 'package.json')))
  const app = new App()
  app.plugin(SQLiteDriver, { path: ':memory:' })
  app.plugin(plugin, plugin.Config({}))
  await app.start()
  try {
    let award: any
    const example = { inject: ['xpPoints'], apply(ctx: Context) {
      award = exports.registerActivityScores(ctx, 'custom-event')
    } }
    const fork = app.plugin(example)
    const session = { platform: 'onebot', userId: 'participant', guildId: 'guild', username: 'Player' }
    const first = await award(session, 'completed-event-1')
    const retry = await award(session, 'completed-event-1')
    assert.equal(first.after, 1)
    assert.equal(retry.deduplicated, true)
    assert.equal(retry.journalId, first.journalId)
    assert.equal((await app.xpPoints.requireScoreSystem('custom-event')).scope, 'guild')
    const identity = await app.xpPoints.ensureManagedGuildIdentity('onebot', 'participant', 'guild')
    await app.database.createUser('onebot', 'admin', { authority: 5 })
    await app.xpPoints.setManagedNicknameTarget('onebot:participant', 'Updated', { platform: 'onebot', userId: 'admin' })
    assert.equal(app.xpPoints.resolveNickname('onebot', 'participant'), 'Updated')
    assert.equal(await app.xpPoints.getAccountScore('custom-event', { accountId: identity.accountId }, session), 1)
    await fork.dispose()
    const replacement = app.plugin(example)
    assert.equal((await award(session, 'completed-event-2')).after, 2)
    await replacement.dispose()
  } finally { await app.stop() }
})

it('releases the documented account occupancy even when score delivery rejects', async () => {
  const source = snippets('docs/INTEGRATION.md', 'ts')[0]
  const exports: Record<string, any> = {}
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('exports', 'require', output)(exports, createRequire(join(root, 'package.json')))
  let released = 0
  const award = exports.registerActivityScores({
    on() {},
    xpPoints: {
      registerScoreConsumer: () => ({ addAccount: async () => { throw new Error('injected failure') }, dispose() {} }),
      registerAccountConsumer: () => ({ acquire: async () => ({ release() { released++ } }), dispose() {} }),
      ensureManagedGuildIdentity: async () => ({ accountId: 'account' }),
    },
  }, 'example')
  await assert.rejects(award({ platform: 'onebot', userId: 'player', guildId: 'guild' }, 'event'), /injected failure/)
  assert.equal(released, 1)
})
