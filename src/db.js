const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('node:path');
const { getDataDir } = require('./dataDir');

let db;

function getDbFile() {
  return path.join(getDataDir(), 'data.db');
}

const TARGET_AI_FIELDS = [
  'ai_scenario',
  'ai_goal',
  'reply_strategy',
  'ai_mood',
  'ai_personality',
  'ai_bio',
];

function rowToItem(row) {
  if (!row) return null;
  const item = {
    id: row.id,
    groupid: row.groupid ?? '',
    comment: row.comment ?? '',
    edition: row.edition ?? '',
    reaction: row.reaction ?? '',
    prompt: row.prompt ?? '',
    target: row.target ?? '',
    messages_sent: row.messages_sent ?? null,
  };
  for (const field of TARGET_AI_FIELDS) {
    item[field] = row[field] ?? '';
  }
  return item;
}

function normalizeMessagesSent(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

function insertItem(item) {
  db.prepare(
    `INSERT INTO targets (
       id, groupid, comment, edition, reaction, prompt, target, messages_sent,
       ai_scenario, ai_goal, reply_strategy, ai_mood, ai_personality, ai_bio
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    item.id,
    item.groupid ?? '',
    item.comment ?? '',
    item.edition ?? '',
    item.reaction ?? '',
    item.prompt ?? '',
    item.target ?? '',
    normalizeMessagesSent(item.messages_sent),
    item.ai_scenario ?? '',
    item.ai_goal ?? '',
    item.reply_strategy ?? '',
    item.ai_mood ?? '',
    item.ai_personality ?? '',
    item.ai_bio ?? ''
  );
}

function ensureAiColumns() {
  const existing = new Set(
    db.prepare('PRAGMA table_info(targets)').all().map((col) => col.name)
  );
  for (const field of TARGET_AI_FIELDS) {
    if (!existing.has(field)) {
      db.exec(`ALTER TABLE targets ADD COLUMN ${field} TEXT`);
    }
  }
}

function initDb() {
  if (db) return db;

  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(getDbFile());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY,
      groupid TEXT NOT NULL,
      comment TEXT,
      edition TEXT,
      reaction TEXT,
      prompt TEXT,
      target TEXT,
      messages_sent INTEGER,
      ai_scenario TEXT,
      ai_goal TEXT,
      reply_strategy TEXT,
      ai_mood TEXT,
      ai_personality TEXT,
      ai_bio TEXT
    );
  `);

  ensureAiColumns();
  return db;
}

function withTransaction(fn) {
  initDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    throw err;
  }
}

function readData() {
  initDb();
  return db.prepare('SELECT * FROM targets ORDER BY rowid').all().map(rowToItem);
}

function getTarget(id) {
  initDb();
  return rowToItem(db.prepare('SELECT * FROM targets WHERE id = ?').get(id));
}

function addTarget(item) {
  initDb();
  insertItem(item);
  return readData();
}

function updateTarget(id, item) {
  initDb();
  db.prepare(
    `UPDATE targets
     SET groupid = ?, comment = ?, edition = ?, reaction = ?, prompt = ?, target = ?,
         ai_scenario = ?, ai_goal = ?, reply_strategy = ?, ai_mood = ?,
         ai_personality = ?, ai_bio = ?
     WHERE id = ?`
  ).run(
    item.groupid ?? '',
    item.comment ?? '',
    item.edition ?? '',
    item.reaction ?? '',
    item.prompt ?? '',
    item.target ?? '',
    item.ai_scenario ?? '',
    item.ai_goal ?? '',
    item.reply_strategy ?? '',
    item.ai_mood ?? '',
    item.ai_personality ?? '',
    item.ai_bio ?? '',
    id
  );

  if (Object.prototype.hasOwnProperty.call(item, 'messages_sent')) {
    db.prepare('UPDATE targets SET messages_sent = ? WHERE id = ?').run(
      normalizeMessagesSent(item.messages_sent),
      id
    );
  }

  return readData();
}

function deleteTarget(id) {
  initDb();
  db.prepare('DELETE FROM targets WHERE id = ?').run(id);
  return readData();
}

function writeData(data) {
  const items = Array.isArray(data) ? data : [];
  withTransaction(() => {
    db.exec('DELETE FROM targets');
    for (const item of items) {
      if (!item?.id) continue;
      insertItem(item);
    }
  });
  return readData();
}

function incrementMessagesSent(id) {
  if (!id) return;
  initDb();
  db.prepare(
    'UPDATE targets SET messages_sent = COALESCE(messages_sent, 0) + 1 WHERE id = ?'
  ).run(id);
}

function getSentCounts() {
  initDb();
  const map = {};
  for (const row of db.prepare('SELECT id, messages_sent FROM targets').all()) {
    map[row.id] = row.messages_sent ?? null;
  }
  return map;
}

function getPersistedTotalSent() {
  initDb();
  const row = db.prepare('SELECT SUM(messages_sent) AS total FROM targets').get();
  const total = row?.total;
  if (total == null) return 0;
  return Number(total);
}

module.exports = {
  initDb,
  readData,
  writeData,
  getTarget,
  addTarget,
  updateTarget,
  deleteTarget,
  incrementMessagesSent,
  getSentCounts,
  getPersistedTotalSent,
};
