import type { ScoreCommandBindingConfig } from './score-ledger'

export type ScoreCommandAction = Exclude<keyof ScoreCommandBindingConfig, 'systemKey'>

export interface NormalizedScoreCommandBinding {
  systemKey: string
  action: ScoreCommandAction
  command: string
}

export const SCORE_COMMAND_ACTIONS: ScoreCommandAction[] = [
  'query',
  'leaderboard',
  'setSelf',
  'addSelf',
  'setTarget',
  'addTarget',
]

export function normalizeScoreCommandBindings(
  configs: ScoreCommandBindingConfig[] | undefined,
  reservedCommands: Iterable<string> = [],
): NormalizedScoreCommandBinding[] {
  const reserved = new Set([...reservedCommands].map(command => command.trim()))
  const systems = new Set<string>()
  const commands = new Map<string, string>()
  const result: NormalizedScoreCommandBinding[] = []

  for (const config of configs ?? []) {
    const systemKey = config.systemKey?.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(systemKey)) {
      throw new Error('积分指令绑定的 systemKey 格式无效：' + (config.systemKey ?? ''))
    }
    if (systems.has(systemKey)) throw new Error(`积分指令系统 ${systemKey} 被重复配置。`)
    systems.add(systemKey)

    for (const action of SCORE_COMMAND_ACTIONS) {
      for (const rawCommand of config[action] ?? []) {
        const command = rawCommand?.trim()
        if (!command || command.length > 64 || /[\s./<>\[\]]/u.test(command)) {
          throw new Error(`积分指令别名“${rawCommand ?? ''}”必须是不含空白和点号、斜杠或参数括号的 1～64 位命令名。`)
        }
        if (reserved.has(command)) throw new Error(`积分指令别名“${command}”与核心指令冲突。`)
        const owner = commands.get(command)
        if (owner) throw new Error(`积分指令别名“${command}”同时绑定到 ${owner} 和 ${systemKey}。`)
        commands.set(command, systemKey)
        result.push({ systemKey, action, command })
      }
    }
  }

  return result
}
