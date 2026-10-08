import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  executeScoreGuildRemap,
  preflightScoreGuildRemap,
  SCORE_GUILD_REMAP_CONFIRMATION,
} from '../scripts/score-guild-remap-core.mjs'

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'xp-guild-remap-')), 'koishi.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE xp_score_system (
      key TEXT PRIMARY KEY,name TEXT,unit TEXT,scope TEXT,active INTEGER,
      createdBy TEXT,createdAt INTEGER,updatedAt INTEGER
    );
    CREATE TABLE xp_account_schema (key TEXT PRIMARY KEY,version INTEGER);
    INSERT INTO xp_account_schema VALUES ('person-account-subject-v1',1);
    CREATE TABLE xp_score_subject (id TEXT PRIMARY KEY,systemKey TEXT,profileId INTEGER,accountId TEXT,active INTEGER,createdAt INTEGER,retiredAt INTEGER);
    CREATE TABLE xp_subject_balance (subjectId TEXT,platform TEXT,guildId TEXT,value REAL,updatedAt INTEGER,
      PRIMARY KEY(subjectId,platform,guildId));
    CREATE TABLE xp_journal_subject (journalId INTEGER PRIMARY KEY,subjectId TEXT,accountId TEXT);
    CREATE TABLE xp_score_guild_component (systemKey TEXT,subjectId TEXT,platform TEXT,targetGuildId TEXT,sourceGuildId TEXT,value REAL,kind TEXT,updatedAt INTEGER);
    CREATE TABLE xp_score_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,mutationId TEXT UNIQUE,systemKey TEXT,profileId INTEGER,
      platform TEXT,guildId TEXT,originPlatform TEXT,originGuildId TEXT,operation TEXT,
      delta REAL,before REAL,after REAL,source TEXT,reason TEXT,actorPlatform TEXT,actorUserId TEXT,createdAt INTEGER
    );
    CREATE TABLE xp_score_guild_alias (
      systemKey TEXT,platform TEXT,sourceGuildId TEXT,targetGuildId TEXT,createdAt INTEGER,updatedAt INTEGER,
      PRIMARY KEY(systemKey,platform,sourceGuildId)
    );
    INSERT INTO xp_score_system VALUES ('event','活动积分','星','guild',1,'test',1,1);
    INSERT INTO xp_score_subject VALUES ('main','event',1,'account-main',1,1,NULL);
    INSERT INTO xp_subject_balance VALUES ('main','onebot','old-pool',7,1);
    INSERT INTO xp_subject_balance VALUES ('main','onebot','new-pool',5,1);
    INSERT INTO xp_score_guild_alias VALUES ('event','onebot','source','old-pool',1,1);
  `)
  db.close()
  return path
}

const scoreGuildAliases = { event: { onebot: { source: 'new-pool' } } }

describe('generic score guild remap', () => {
  it('reassigns every period by subject maximum without treating pool remap as competitive reward', () => {
    const path = fixture(), db = new DatabaseSync(path)
    db.exec(`INSERT INTO xp_score_subject VALUES ('alt','event',1,'account-alt',1,1,NULL);
      CREATE TABLE xp_period_definition(id TEXT PRIMARY KEY,systemKey TEXT,revisedAt REAL);
      INSERT INTO xp_period_definition VALUES ('day','event',0),('month','event',0);
      CREATE TABLE xp_period_score(periodId TEXT,subjectId TEXT,platform TEXT,guildId TEXT,value REAL,updatedAt REAL,PRIMARY KEY(periodId,subjectId,platform,guildId));
      INSERT INTO xp_period_score VALUES ('day','main','onebot','old-pool',2,1),('day','main','onebot','new-pool',1,1),
        ('month','main','onebot','old-pool',5,1),('month','main','onebot','new-pool',9,1),('day','alt','onebot','old-pool',-2,1);
      CREATE TABLE xp_period_adjustment(id INTEGER PRIMARY KEY AUTOINCREMENT,operationId TEXT,snapshot TEXT,createdAt REAL);`)
    db.close()
    const preview = preflightScoreGuildRemap(path, { scoreGuildAliases })
    assert.equal(preview.ok, true); assert.equal(preview.periodUpdates.length, 2)
    const result = executeScoreGuildRemap(path, { scoreGuildAliases, confirmation: SCORE_GUILD_REMAP_CONFIRMATION })
    assert.equal(result.executed, true)
    const read = new DatabaseSync(path, { readOnly: true })
    assert.deepEqual(read.prepare("SELECT periodId,subjectId,value FROM xp_period_score WHERE guildId='new-pool' ORDER BY periodId,subjectId").all().map(r => ({ ...r })),
      [{ periodId: 'day', subjectId: 'alt', value: -2 }, { periodId: 'day', subjectId: 'main', value: 2 }, { periodId: 'month', subjectId: 'main', value: 9 }])
    assert.equal(read.prepare('SELECT count(*) AS n FROM xp_score_journal').get().n, 1)
    assert.equal(read.prepare('SELECT count(*) AS n FROM xp_period_adjustment').get().n, 2)
    read.close()
    assert.equal(executeScoreGuildRemap(path, { scoreGuildAliases, confirmation: SCORE_GUILD_REMAP_CONFIRMATION }).alreadyRemapped, true)
  })
  it('max-merges independent subjects separately and records subject-linked audit', () => {
    const path = fixture(), db = new DatabaseSync(path)
    db.exec(`
      INSERT INTO xp_score_subject VALUES ('alt','event',1,'account-alt',1,1,NULL);
      UPDATE xp_subject_balance SET value=20 WHERE subjectId='main' AND guildId='old-pool';
      INSERT INTO xp_subject_balance VALUES
        ('alt','onebot','old-pool',3,1),('alt','onebot','new-pool',9,1);
    `)
    db.close()
    const preview = preflightScoreGuildRemap(path, { scoreGuildAliases })
    assert.equal(preview.subjectMode, true)
    assert.equal(preview.updates.length, 1)
    assert.equal(preview.updates[0].subjectId, 'main')
    executeScoreGuildRemap(path, { scoreGuildAliases, confirmation: SCORE_GUILD_REMAP_CONFIRMATION })
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      assert.deepEqual(check.prepare("SELECT subjectId,value FROM xp_subject_balance WHERE guildId='new-pool' ORDER BY subjectId").all()
        .map(row => ({ ...row })), [{ subjectId: 'alt', value: 9 }, { subjectId: 'main', value: 20 }])
      assert.equal(check.prepare('SELECT subjectId FROM xp_journal_subject').get().subjectId, 'main')
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM xp_score_journal').get().count, 1)
    } finally { check.close() }
    assert.equal(executeScoreGuildRemap(path, { scoreGuildAliases, confirmation: SCORE_GUILD_REMAP_CONFIRMATION }).alreadyRemapped, true)
  })

  it('never writes aliases or balances when the backup fails', () => {
    const path = fixture()
    assert.throws(() => executeScoreGuildRemap(path, { scoreGuildAliases, confirmation: SCORE_GUILD_REMAP_CONFIRMATION,
      copyFile() { throw new Error('backup refused') } }), /backup refused/)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal(check.prepare("SELECT value FROM xp_subject_balance WHERE guildId='new-pool'").get().value, 5)
      assert.equal(check.prepare('SELECT targetGuildId FROM xp_score_guild_alias').get().targetGuildId, 'old-pool')
      assert.equal(check.prepare('SELECT COUNT(*) AS count FROM xp_score_journal').get().count, 0)
    } finally { check.close() }
  })

  it('rejects an overflowing audit delta before remap writes', () => {
    const path = fixture()
    const db = new DatabaseSync(path)
    db.prepare("UPDATE xp_subject_balance SET value=? WHERE guildId='old-pool'").run(Number.MAX_VALUE)
    db.prepare("UPDATE xp_subject_balance SET value=? WHERE guildId='new-pool'").run(-Number.MAX_VALUE)
    const before = db.prepare('SELECT * FROM xp_subject_balance').all()
    db.close()
    assert.equal(preflightScoreGuildRemap(path, { scoreGuildAliases }).ok, false)
    assert.throws(() => executeScoreGuildRemap(path, { scoreGuildAliases, confirmation: SCORE_GUILD_REMAP_CONFIRMATION }), /有限数值/)
    const check = new DatabaseSync(path, { readOnly: true })
    try { assert.deepEqual(check.prepare('SELECT * FROM xp_subject_balance').all(), before) }
    finally { check.close() }
  })

  it('previews, backs up, max-merges, applies, and verifies one neutral system', () => {
    const path = fixture()
    const preview = preflightScoreGuildRemap(path, { scoreGuildAliases })
    assert.equal(preview.ok, true)
    assert.equal(preview.changes.length, 1)
    assert.equal(preview.updates[0].after, 7)

    const result = executeScoreGuildRemap(path, {
      scoreGuildAliases,
      confirmation: SCORE_GUILD_REMAP_CONFIRMATION,
      now: new Date('2026-09-01T00:00:00Z'),
    })
    assert.equal(result.executed, true)
    assert.ok(existsSync(result.backupPath))
    assert.equal(preflightScoreGuildRemap(path, { scoreGuildAliases }).alreadyRemapped, true)

    const db = new DatabaseSync(path, { readOnly: true })
    assert.equal(db.prepare(
      "SELECT value FROM xp_subject_balance WHERE guildId='new-pool'",
    ).get().value, 7)
    assert.equal(db.prepare(
      "SELECT targetGuildId FROM xp_score_guild_alias WHERE systemKey='event' AND sourceGuildId='source'",
    ).get().targetGuildId, 'new-pool')
    assert.ok(db.prepare(
      "SELECT 1 FROM xp_score_journal WHERE source='xp-points-guild-remap'",
    ).get())
    db.close()
  })

  it('supports signed sum when two previously separate source pools converge', () => {
    const path = fixture(), db = new DatabaseSync(path)
    db.exec(`DELETE FROM xp_subject_balance;
      DELETE FROM xp_score_guild_alias;
      INSERT INTO xp_subject_balance VALUES ('main','onebot','pool-a',4,1),('main','onebot','pool-b',7,1);
      INSERT INTO xp_score_guild_alias VALUES
        ('event','onebot','a','pool-a',1,1),('event','onebot','b','pool-b',1,1);`)
    db.close()
    const scoreGuildAliases = { event: { onebot: { a: 'pool', b: 'pool' } } }
    const preview = preflightScoreGuildRemap(path, { scoreGuildAliases, balanceStrategy: 'sum' })
    assert.equal(preview.ok, true)
    assert.deepEqual(preview.updates.map(row => [row.guildId, row.after]), [['pool', 11]])
    executeScoreGuildRemap(path, { scoreGuildAliases, balanceStrategy: 'sum', confirmation: SCORE_GUILD_REMAP_CONFIRMATION })
    const check = new DatabaseSync(path, { readOnly: true })
    try { assert.equal(check.prepare("SELECT value FROM xp_subject_balance WHERE guildId='pool'").get().value, 11) }
    finally { check.close() }
  })

  it('rejects chains, unknown systems, non-guild systems, and missing confirmation', () => {
    const path = fixture()
    assert.equal(preflightScoreGuildRemap(path, {
      scoreGuildAliases: { event: { onebot: { a: 'b', b: 'c' } } },
    }).ok, false)
    assert.equal(preflightScoreGuildRemap(path, {
      scoreGuildAliases: { missing: { onebot: {} } },
    }).ok, false)
    const db = new DatabaseSync(path)
    db.prepare("UPDATE xp_score_system SET scope='global' WHERE key='event'").run()
    db.close()
    assert.equal(preflightScoreGuildRemap(path, { scoreGuildAliases }).ok, false)
    assert.throws(() => executeScoreGuildRemap(path, { scoreGuildAliases }), /确认文本/)
  })
})
