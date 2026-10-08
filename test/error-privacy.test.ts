import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { Context } from 'koishi'
import { registerAccountCommands } from '../src/account-commands'
import { XpPointsUserError } from '../src/service'
import { safeErrorSummary } from '../src/errors'

const secret = 'synthetic-credential'
const failure = () => Object.assign(new Error(`请求失败：Authorization=Bearer ${secret} C:/fixture/private.json`),
  { code: 'ECONNRESET', config: { headers: { Authorization: secret } } })
function fixture(error: Error) {
  const actions = new Map<string, (...args: any[]) => any>(), logs: unknown[][] = []
  const ctx = { logger: { warn: (...args: unknown[]) => logs.push(args) }, middleware() {}, on() {},
    command: (declaration: string) => {
      let chain: any
      chain = new Proxy({}, { get: (_, key) => key === 'action'
        ? (fn: (...args: any[]) => any) => { actions.set(declaration.split(' ')[0], fn); return chain }
        : () => chain })
      return chain
    } } as unknown as Context
  registerAccountCommands(ctx, { operations: {} as any, queries: { person: async () => { throw error } } as any, refresh: async () => {} })
  return { action: actions.get('我的账号')!, logs }
}
const session = { platform: 'onebot', selfId: 'test-bot', userId: 'tester', channelId: 'test-group', isDirect: false }
it('hides unknown account errors and raw request properties', async () => {
  const { action, logs } = fixture(failure())
  assert.equal(await action({ session, options: {} }), '账号操作未完成，未报告成功；请联系管理员检查日志。')
  assert.doesNotMatch(JSON.stringify(logs), /synthetic-credential|private\.json|Authorization|headers|config/)
})
it('keeps explicit account domain errors visible', async () => {
  const { action } = fixture(new XpPointsUserError('存在负分，请联系管理员处理。'))
  assert.equal(await action({ session, options: {} }), '存在负分，请联系管理员处理。')
})
it('ordinary error summaries never serialize credentials or local paths', () => {
  assert.equal(safeErrorSummary(failure()), 'Error [ECONNRESET]')
  assert.equal(safeErrorSummary({ name: secret, code: secret, message: secret, status: 503 }), 'Error [HTTP 503]')
  assert.equal(safeErrorSummary({ get name() { throw failure() } }), 'UnknownError')
  let nameReads = 0, codeReads = 0
  assert.equal(safeErrorSummary({
    get name() { return ++nameReads < 3 ? 'Error' : secret },
    get code() { return ++codeReads < 3 ? 'ECONNRESET' : secret },
  }), 'Error [ECONNRESET]')
  assert.deepEqual([nameReads, codeReads], [1, 1])
})
