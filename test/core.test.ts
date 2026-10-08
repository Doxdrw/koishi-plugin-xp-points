import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chooseChatLunaMessageName,
  consumerApplies,
  rewriteCharacterMessageNames,
} from '../src/core'

describe('optional nickname consumers', () => {
  const enabled = { enabled: true, guilds: ['g1'], includePrivate: false }

  it('honors plugin switches, guild allowlists, and private fallback', () => {
    assert.equal(consumerApplies(enabled, { guildId: 'g1' }), true)
    assert.equal(consumerApplies(enabled, { guildId: 'g2' }), false)
    assert.equal(consumerApplies(enabled, { isDirect: true }), false)
    assert.equal(consumerApplies({ ...enabled, guilds: [] }, { guildId: 'g2' }), true)
  })

  it('protects explicit ChatLuna names and task invocations', () => {
    assert.equal(chooseChatLunaMessageName('explicit', 'command', 'Alice'), 'explicit')
    assert.equal(chooseChatLunaMessageName(undefined, 'agent-task', 'Alice'), undefined)
    assert.equal(chooseChatLunaMessageName(undefined, 'command', 'Alice'), 'Alice')
    assert.equal(chooseChatLunaMessageName(undefined, 'command', undefined), undefined)
  })

  it('rewrites mapped human history while preserving tasks, bots, and unknown users', () => {
    const messages = [
      { id: '1001', name: 'platform-name' },
      { id: '1002', name: 'unknown' },
      { id: 'bot', name: 'assistant' },
      { id: 'task', name: 'task' },
    ]
    rewriteCharacterMessageNames(
      messages,
      'onebot',
      (_platform, id) => id === '1001' ? 'Alice' : id === 'bot' ? 'Wrong' : undefined,
      new Set(['bot']),
    )
    assert.deepEqual(messages.map(item => item.name), ['Alice', 'unknown', 'assistant', 'task'])
  })
})
