#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import {
  executeScoreGuildRemap,
  preflightScoreGuildRemap,
  SCORE_GUILD_REMAP_CONFIRMATION,
} from './score-guild-remap-core.mjs'

function help() {
  console.log(`用法：xp-points-guild-remap --database <sqlite> --config <json> [选项]

配置文件内容应为 scoreGuildAliases 对象：
{
  "event": { "onebot": { "来源群": "归属群" } }
}

选项：
  --execute                    执行重映射；默认仅预检
  --confirm ${SCORE_GUILD_REMAP_CONFIRMATION}
  --backup <path>              指定备份文件路径
  --balance maximum|sum        累计余额合并策略（默认 maximum）
  --period maximum|sum         周期成绩合并策略（默认 maximum）

仅配置文件中列出的积分系统会被核对。要移除某系统全部挂靠，请保留系统 key 并将其值设为空对象。`)
}

function parseArgs(argv) {
  const result = { execute: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const take = () => {
      const value = argv[++index]
      if (!value) throw new Error(arg + ' 缺少参数。')
      return value
    }
    if (arg === '--database') result.databasePath = take()
    else if (arg === '--config') result.configPath = take()
    else if (arg === '--backup') result.backupPath = take()
    else if (arg === '--balance') result.balanceStrategy = take()
    else if (arg === '--period') result.periodStrategy = take()
    else if (arg === '--confirm') result.confirmation = take()
    else if (arg === '--execute') result.execute = true
    else if (arg === '--help' || arg === '-h') result.help = true
    else throw new Error('未知参数：' + arg)
  }
  return result
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    help()
    process.exit(0)
  }
  if (!args.databasePath || !args.configPath) {
    help()
    throw new Error('必须提供 --database 和 --config。')
  }
  const scoreGuildAliases = JSON.parse(readFileSync(args.configPath, 'utf8'))
  const options = { scoreGuildAliases, backupPath: args.backupPath, confirmation: args.confirmation,
    balanceStrategy: args.balanceStrategy, periodStrategy: args.periodStrategy }
  const report = args.execute
    ? executeScoreGuildRemap(args.databasePath, options)
    : preflightScoreGuildRemap(args.databasePath, options)
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 2
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
