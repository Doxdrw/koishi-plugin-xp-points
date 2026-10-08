import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SCORE_GUILD_REMAP_CONFIRMATION = 'REMAP-XP-SCORE-ALIASES'
export const SCORE_GUILD_REMAP_DEFAULT_STRATEGY = 'maximum'
export const SCORE_GUILD_REMAP_BASELINE_SOURCE = '__offline_remap_baseline__'

const tableExists = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))

function finiteNumber(value, label, errors) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    errors.push(label + ' 不是有限数值。')
    return 0
  }
  return number
}

function normalizeStrategy(value, label) {
  const strategy = value ?? SCORE_GUILD_REMAP_DEFAULT_STRATEGY
  if (strategy !== 'maximum' && strategy !== 'sum') throw new Error(`${label} 必须是 maximum 或 sum。`)
  return strategy
}

function combine(values, strategy, label, errors) {
  const numbers = values.map(value => finiteNumber(value, label, errors))
  if (!numbers.length) return 0
  const result = strategy === 'sum' ? numbers.reduce((total, value) => total + value, 0) : Math.max(...numbers)
  finiteNumber(result, label + '合并结果', errors)
  return result
}

function normalizeDesiredAliases(rawConfig, errors) {
  const systems = []
  for (const [rawSystemKey, platforms] of Object.entries(rawConfig ?? {})) {
    const systemKey = rawSystemKey.trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(systemKey)) {
      errors.push('非法积分系统 key：' + rawSystemKey)
      continue
    }
    const aliases = []
    for (const [rawPlatform, mapping] of Object.entries(platforms ?? {})) {
      const platform = rawPlatform.trim()
      const sources = new Set(Object.keys(mapping ?? {}).map(value => value.trim()))
      for (const [rawSource, rawTarget] of Object.entries(mapping ?? {})) {
        const sourceGuildId = rawSource.trim()
        const targetGuildId = String(rawTarget).trim()
        if (!platform || !sourceGuildId || !targetGuildId) {
          errors.push(`积分系统 ${systemKey} 的挂靠平台和群号不能为空。`)
        } else if (sourceGuildId === targetGuildId) {
          errors.push(`积分系统 ${systemKey} 不允许群号挂靠自身：${sourceGuildId}`)
        } else if (sources.has(targetGuildId)) {
          errors.push(`积分系统 ${systemKey} 不允许链式或循环挂靠：${sourceGuildId} -> ${targetGuildId}`)
        } else {
          aliases.push({ systemKey, platform, sourceGuildId, targetGuildId })
        }
      }
    }
    systems.push({ key: systemKey, aliases })
  }
  return systems
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function createVerifiedBackup(databasePath, backupPath, copyFile) {
  if (databasePath === backupPath || existsSync(backupPath)) throw new Error('备份路径必须是不存在的新文件。')
  for (const suffix of ['-wal', '-journal']) {
    if (existsSync(databasePath + suffix) && statSync(databasePath + suffix).size > 0) {
      throw new Error('检测到非空 SQLite WAL/事务日志；请确认 Koishi 已停止并完成检查点后再执行。')
    }
  }
  mkdirSync(dirname(backupPath), { recursive: true })
  copyFile(databasePath, backupPath, constants.COPYFILE_EXCL)
  const sourceSha256 = sha256File(databasePath)
  const backupSha256 = sha256File(backupPath)
  if (sourceSha256 !== backupSha256) {
    throw new Error('数据库备份 SHA-256 与源文件不一致，已拒绝重映射。')
  }
  const backup = new DatabaseSync(backupPath, { readOnly: true })
  try {
    if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('备份数据库完整性校验失败。')
  } finally { backup.close() }
  return backupSha256
}

export function preflightScoreGuildRemap(databasePath, options = {}, lockedDatabase) {
  const absolute = resolve(databasePath)
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error('数据库文件不存在：' + absolute)
  const errors = []
  const warnings = []
  const balanceStrategy = normalizeStrategy(options.balanceStrategy, '累计积分策略')
  const periodStrategy = normalizeStrategy(options.periodStrategy, '周期成绩策略')
  const db = lockedDatabase ?? new DatabaseSync(absolute, { readOnly: true })
  try {
    const desiredSystems = normalizeDesiredAliases(options.scoreGuildAliases, errors)
    if (!desiredSystems.length) errors.push('至少需要在配置中声明一个待核对的积分系统。')
    for (const table of ['xp_score_system', 'xp_score_journal', 'xp_score_guild_alias', 'xp_score_subject', 'xp_subject_balance', 'xp_journal_subject']) {
      if (!tableExists(db, table)) errors.push('缺少通用账本表 ' + table + '。')
    }
    if (errors.length) {
      return { ok: false, databasePath: absolute, errors, warnings, changes: [], updates: [], executed: false }
    }
    const subjectMode = tableExists(db, 'xp_account_schema')
      && db.prepare('SELECT version FROM xp_account_schema WHERE key=?').get('person-account-subject-v1')?.version === 1
    if (!subjectMode) errors.push('账号主体账本尚未初始化，拒绝重映射余额。')
    if (errors.length) return { ok: false, databasePath: absolute, errors, warnings, changes: [], updates: [], executed: false }
    const scopes = new Map(db.prepare('SELECT key,scope FROM xp_score_system').all()
      .map(row => [String(row.key), String(row.scope)]))
    const appliedRows = db.prepare(
      'SELECT systemKey,platform,sourceGuildId,targetGuildId FROM xp_score_guild_alias',
    ).all()
    const changes = []
    for (const desired of desiredSystems) {
      if (!scopes.has(desired.key)) {
        errors.push('积分系统不存在：' + desired.key)
        continue
      }
      if (scopes.get(desired.key) !== 'guild') {
        errors.push('只有 guild 作用域系统可以重映射群挂靠：' + desired.key)
        continue
      }
      const applied = new Map(appliedRows
        .filter(row => String(row.systemKey) === desired.key)
        .map(row => [[String(row.platform), String(row.sourceGuildId)].join('\0'), String(row.targetGuildId)]))
      const target = new Map(desired.aliases.map(row => [
        [row.platform, row.sourceGuildId].join('\0'), row.targetGuildId,
      ]))
      for (const key of new Set([...applied.keys(), ...target.keys()])) {
        const [platform, sourceGuildId] = key.split('\0')
        const oldTargetGuildId = applied.get(key) ?? sourceGuildId
        const newTargetGuildId = target.get(key) ?? sourceGuildId
        if (oldTargetGuildId === newTargetGuildId) continue
        changes.push({
          systemKey: desired.key,
          platform,
          sourceGuildId,
          oldTargetGuildId,
          newTargetGuildId,
        })
      }
    }
    const balances = db.prepare(`SELECT s.systemKey,s.profileId,s.id AS subjectId,b.platform,b.guildId,b.value
      FROM xp_subject_balance b JOIN xp_score_subject s ON s.id=b.subjectId WHERE s.active=1`).all()
    const ownerKey = row => String(row.subjectId)
    for (const row of balances) finiteNumber(row.value, '通用账本余额', errors)
    if (subjectMode && db.prepare(`SELECT 1 FROM xp_subject_balance b LEFT JOIN xp_score_subject s ON s.id=b.subjectId
      WHERE s.id IS NULL OR s.active<>1 LIMIT 1`).get()) errors.push('存在孤立或已退休的非空余额，拒绝重映射。')
    const updates = new Map()
    for (const change of changes) {
      const sourceRows = balances.filter(row => String(row.systemKey) === change.systemKey
        && String(row.platform) === change.platform
        && String(row.guildId) === change.oldTargetGuildId)
      for (const row of sourceRows) {
        const value = finiteNumber(row.value, '通用账本余额', errors)
        const key = [change.systemKey, ownerKey(row), change.platform, change.newTargetGuildId].join('\0')
        const existingRow = balances.find(candidate => String(candidate.systemKey) === change.systemKey
          && ownerKey(candidate) === ownerKey(row)
          && String(candidate.platform) === change.platform
          && String(candidate.guildId) === change.newTargetGuildId)
        const current = updates.get(key)
        const before = current?.before
          ?? (existingRow ? finiteNumber(existingRow.value, '通用账本余额', errors) : null)
        const candidates = [...(current?.candidates ?? []), value]
        updates.set(key, {
          systemKey: change.systemKey,
          profileId: Number(row.profileId),
          ...(subjectMode ? { subjectId: String(row.subjectId) } : {}),
          platform: change.platform,
          guildId: change.newTargetGuildId,
          before: before ?? 0,
          targetPreviouslyAbsent: before == null,
          after: combine(before == null ? candidates : [before, ...candidates], balanceStrategy, '重映射余额', errors),
          candidates,
        })
      }
    }
    const updateRows = [...updates.values()]
      .filter(row => row.targetPreviouslyAbsent || row.after !== row.before)
      .sort((left, right) => left.systemKey.localeCompare(right.systemKey)
        || left.profileId - right.profileId
        || left.platform.localeCompare(right.platform)
        || left.guildId.localeCompare(right.guildId))
    for (const row of updateRows) {
      finiteNumber(row.after - row.before, '重映射审计变化量', errors)
    }
    // An offline run may be the only available maintenance path while the
    // service is unavailable. Rebuild a conservative baseline for each
    // affected subject/pool while preserving the visible current result.
    const componentUpdates = []
    if (subjectMode && tableExists(db, 'xp_score_guild_component')) {
      const componentRows = db.prepare('SELECT systemKey,subjectId,platform,targetGuildId,sourceGuildId,value,kind FROM xp_score_guild_component').all()
      for (const pair of new Set(changes.map(row => [row.systemKey, row.platform].join('\0')))) {
        const [systemKey, platform] = pair.split('\0')
        for (const subject of db.prepare('SELECT id FROM xp_score_subject WHERE systemKey=? AND active=1').all(systemKey)) {
          const current = balances.filter(row => String(row.subjectId) === String(subject.id) && String(row.systemKey) === systemKey && String(row.platform) === platform)
          const next = new Map(current.map(row => [String(row.guildId), finiteNumber(row.value, '通用账本余额', errors)]))
          for (const row of updateRows.filter(row => String(row.subjectId) === String(subject.id) && row.systemKey === systemKey && row.platform === platform)) next.set(row.guildId, row.after)
          const oldComponents = componentRows.filter(row => String(row.subjectId) === String(subject.id) && String(row.systemKey) === systemKey && String(row.platform) === platform)
          if (!current.length && !oldComponents.length && !next.size) continue
          componentUpdates.push({ systemKey, subjectId: String(subject.id), platform,
            components: [...next.entries()].filter(([, value]) => value !== 0).map(([targetGuildId, value]) => ({
              targetGuildId, sourceGuildId: SCORE_GUILD_REMAP_BASELINE_SOURCE, value, kind: 'baseline',
            })).sort((a, b) => a.targetGuildId.localeCompare(b.targetGuildId)) })
        }
      }
    }
    const periodTables = ['xp_period_definition', 'xp_period_score', 'xp_period_adjustment']
    const periodEnabled = periodTables.some(table => tableExists(db, table))
    const periodUpdates = new Map()
    if (periodEnabled && (!subjectMode || periodTables.some(table => !tableExists(db, table)))) {
      errors.push('周期成绩表或账号主体结构不完整，拒绝只重映射累计余额。')
    } else if (periodEnabled) {
      if (db.prepare(`SELECT 1 FROM xp_period_score p LEFT JOIN xp_score_subject s ON s.id=p.subjectId
        LEFT JOIN xp_period_definition d ON d.id=p.periodId
        WHERE s.id IS NULL OR s.active<>1 OR d.id IS NULL OR d.systemKey<>s.systemKey LIMIT 1`).get()) errors.push('周期成绩存在孤立、退休或跨系统主体。')
      const scores = db.prepare(`SELECT p.*,s.systemKey FROM xp_period_score p JOIN xp_score_subject s ON s.id=p.subjectId`).all()
      for (const row of scores) finiteNumber(row.value, '周期成绩', errors)
      for (const change of changes) {
        for (const row of scores.filter(s => s.systemKey === change.systemKey && s.platform === change.platform && s.guildId === change.oldTargetGuildId)) {
          const key = JSON.stringify([row.periodId, row.subjectId, row.platform, change.newTargetGuildId])
          const previous = periodUpdates.get(key)
          const existing = scores.find(s => s.periodId === row.periodId && s.subjectId === row.subjectId && s.platform === row.platform && s.guildId === change.newTargetGuildId)
          const before = previous?.before ?? existing?.value ?? null
          const after = combine([before, previous?.after, row.value].filter(n => n !== null && n !== undefined), periodStrategy, '周期重映射结果', errors)
          finiteNumber(after, '周期重映射结果', errors)
          finiteNumber(after - (before ?? 0), '周期重映射差额', errors)
          periodUpdates.set(key, { periodId: row.periodId, subjectId: row.subjectId, systemKey: row.systemKey,
            platform: row.platform, guildId: change.newTargetGuildId, before, after })
        }
      }
    }
    const periodComponentUpdates = []
    if (subjectMode && tableExists(db, 'xp_period_guild_component') && periodEnabled && !errors.length) {
      const componentRows = db.prepare('SELECT periodId,subjectId,platform,targetGuildId,sourceGuildId,value,kind FROM xp_period_guild_component').all()
      for (const pair of new Set(changes.map(row => [row.systemKey, row.platform].join('\0')))) {
        const [systemKey, platform] = pair.split('\0')
        const periods = db.prepare('SELECT id FROM xp_period_definition WHERE systemKey=?').all(systemKey)
        for (const period of periods) {
          const scores = db.prepare(`SELECT p.* FROM xp_period_score p JOIN xp_score_subject s ON s.id=p.subjectId
            WHERE p.periodId=? AND p.platform=? AND s.systemKey=? AND s.active=1`).all(period.id, platform, systemKey)
          const subjects = new Set([...scores.map(row => String(row.subjectId)), ...componentRows
            .filter(row => String(row.periodId) === String(period.id) && String(row.platform) === platform).map(row => String(row.subjectId))])
          for (const subjectId of subjects) {
            const current = scores.filter(row => String(row.subjectId) === subjectId)
            const next = new Map(current.map(row => [String(row.guildId), finiteNumber(row.value, '周期成绩', errors)]))
            for (const row of periodUpdates.filter(row => String(row.periodId) === String(period.id) && String(row.subjectId) === subjectId
              && row.platform === platform)) next.set(row.guildId, row.after)
            periodComponentUpdates.push({ periodId: String(period.id), subjectId, platform,
              components: [...next.entries()].filter(([, value]) => value !== 0).map(([targetGuildId, value]) => ({
                targetGuildId, sourceGuildId: SCORE_GUILD_REMAP_BASELINE_SOURCE, value, kind: 'baseline',
              })).sort((a, b) => a.targetGuildId.localeCompare(b.targetGuildId)) })
          }
        }
      }
    }
    return {
      ok: errors.length === 0,
      databasePath: absolute,
      subjectMode,
      systems: desiredSystems,
      changes,
      updates: updateRows,
      componentUpdates,
      periodUpdates: [...periodUpdates.values()].filter(p => p.before === null || p.before !== p.after).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      periodComponentUpdates,
      alreadyRemapped: changes.length === 0,
      errors,
      warnings,
      executed: false,
    }
  } finally {
    if (!lockedDatabase) db.close()
  }
}

export function executeScoreGuildRemap(databasePath, options = {}) {
  if (options.confirmation !== SCORE_GUILD_REMAP_CONFIRMATION) {
    throw new Error('执行重映射必须提供确认文本：' + SCORE_GUILD_REMAP_CONFIRMATION)
  }
  const preview = preflightScoreGuildRemap(databasePath, options)
  if (!preview.ok) throw new Error('群挂靠重映射预检失败：\n' + preview.errors.join('\n'))
  if (preview.alreadyRemapped) return preview
  const now = options.now ?? new Date()
  const backupPath = resolve(options.backupPath ?? defaultBackupPath(preview.databasePath, now))
  let backupSha256
  const db = new DatabaseSync(preview.databasePath)
  try {
    db.exec('BEGIN EXCLUSIVE')
    const lockedPreview = preflightScoreGuildRemap(preview.databasePath, options, db)
    if (JSON.stringify(lockedPreview) !== JSON.stringify(preview)) throw new Error('预检后数据发生变化，请重新预检。')
    backupSha256 = createVerifiedBackup(preview.databasePath, backupPath, options.copyFile ?? copyFileSync)
    const timestamp = now.getTime()
    for (const update of preview.updates) {
      db.prepare(`INSERT INTO xp_subject_balance
        (subjectId,platform,guildId,value,updatedAt) VALUES (?,?,?,?,?)
        ON CONFLICT(subjectId,platform,guildId) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`).run(
        update.subjectId, update.platform, update.guildId, update.after, timestamp)
      const mutationId = 'XPALIAS:' + createHash('sha256').update([
        update.systemKey, update.subjectId ?? update.profileId, update.platform, update.guildId,
        backupSha256,
        ...preview.changes.filter(change => change.systemKey === update.systemKey
          && change.platform === update.platform
          && change.newTargetGuildId === update.guildId)
          .map(change => change.sourceGuildId + ':' + change.oldTargetGuildId),
      ].join('\0')).digest('hex')
      db.prepare(`INSERT INTO xp_score_journal
        (mutationId,systemKey,profileId,platform,guildId,originPlatform,originGuildId,operation,
         delta,before,after,source,reason,actorPlatform,actorUserId,createdAt)
        VALUES (?,?,?,?,?,?,?,'guild-alias-remap',?,?,?,'xp-points-guild-remap',?,'','',?)
        ON CONFLICT(mutationId) DO NOTHING`).run(
        mutationId, update.systemKey, update.profileId, update.platform, update.guildId,
        update.platform, update.guildId, update.after - update.before, update.before, update.after,
        'apply configured guild alias change', timestamp,
      )
      const journal = db.prepare('SELECT id FROM xp_score_journal WHERE mutationId=?').get(mutationId)
      db.prepare('INSERT INTO xp_journal_subject(journalId,subjectId,accountId) VALUES (?,?,NULL)').run(journal.id, update.subjectId)
    }
    for (const update of preview.componentUpdates ?? []) {
      db.prepare('DELETE FROM xp_score_guild_component WHERE systemKey=? AND subjectId=? AND platform=?')
        .run(update.systemKey, update.subjectId, update.platform)
      for (const component of update.components) db.prepare(`INSERT INTO xp_score_guild_component
        (systemKey,subjectId,platform,targetGuildId,sourceGuildId,value,kind,updatedAt) VALUES (?,?,?,?,?,?,?,?)`).run(
        update.systemKey, update.subjectId, update.platform, component.targetGuildId, component.sourceGuildId,
        component.value, component.kind, timestamp)
    }
    for (const update of preview.periodUpdates) {
      db.prepare(`INSERT INTO xp_period_score(periodId,subjectId,platform,guildId,value,updatedAt) VALUES (?,?,?,?,?,?)
        ON CONFLICT(periodId,subjectId,platform,guildId) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`).run(
        update.periodId, update.subjectId, update.platform, update.guildId, update.after, timestamp)
      db.prepare('UPDATE xp_period_definition SET revisedAt=? WHERE id=?').run(timestamp, update.periodId)
      db.prepare('INSERT INTO xp_period_adjustment(operationId,snapshot,createdAt) VALUES (?,?,?)').run(
        'XPALIAS-PERIOD:' + createHash('sha256').update(JSON.stringify([backupSha256, update])).digest('hex'),
        JSON.stringify({ kind: 'guild-alias-remap', ...update }), timestamp)
    }
    for (const system of preview.systems) {
      db.prepare('DELETE FROM xp_score_guild_alias WHERE systemKey=?').run(system.key)
      for (const alias of system.aliases) {
        db.prepare(`INSERT INTO xp_score_guild_alias
          (systemKey,platform,sourceGuildId,targetGuildId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`).run(
          system.key, alias.platform, alias.sourceGuildId, alias.targetGuildId, timestamp, timestamp,
        )
      }
    for (const update of preview.periodComponentUpdates ?? []) {
      db.prepare('DELETE FROM xp_period_guild_component WHERE periodId=? AND subjectId=? AND platform=?')
        .run(update.periodId, update.subjectId, update.platform)
      for (const component of update.components) db.prepare(`INSERT INTO xp_period_guild_component
        (periodId,subjectId,platform,targetGuildId,sourceGuildId,value,kind,updatedAt) VALUES (?,?,?,?,?,?,?,?)`).run(
        update.periodId, update.subjectId, update.platform, component.targetGuildId, component.sourceGuildId,
        component.value, component.kind, timestamp)
    }
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    db.close()
  }
  const verification = preflightScoreGuildRemap(preview.databasePath, options)
  if (!verification.ok || !verification.alreadyRemapped) {
    throw new Error('群挂靠重映射后验证失败：\n' + verification.errors.join('\n'))
  }
  return {
    ...verification,
    executed: true,
    backupPath,
    backupSha256,
    copiedBalances: preview.updates.length,
  }
}

function defaultBackupPath(databasePath, now) {
  const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return databasePath + '.before-score-guild-remap-' + stamp + '.bak'
}
