import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const dataDir = join(process.env.LOCALAPPDATA ?? process.cwd(), '个人成长平台');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, 'growth.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE IF NOT EXISTS growth_items (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category_id TEXT, status TEXT NOT NULL CHECK(status IN ('completed','in_progress','planned')),
  description TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 2, started_on TEXT, due_on TEXT, completed_on TEXT,
  next_action TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', goal_id TEXT,
  progress_percent INTEGER CHECK(progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100)),
  progress_note TEXT NOT NULL DEFAULT '', progress_source TEXT CHECK(progress_source IS NULL OR progress_source IN ('user_reported','ai_estimate')),
  progress_updated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived_at TEXT, FOREIGN KEY(category_id) REFERENCES categories(id), FOREIGN KEY(goal_id) REFERENCES goals(id)
);
CREATE TABLE IF NOT EXISTS item_history (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL, snapshot TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_plans (date TEXT PRIMARY KEY, budget_minutes INTEGER NOT NULL DEFAULT 720, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daily_tasks (
  id TEXT PRIMARY KEY, plan_date TEXT NOT NULL, title TEXT NOT NULL, estimate_minutes INTEGER NOT NULL,
  actual_minutes INTEGER, priority INTEGER NOT NULL DEFAULT 2, completion_criteria TEXT NOT NULL DEFAULT '',
  item_id TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(plan_date) REFERENCES daily_plans(date), FOREIGN KEY(item_id) REFERENCES growth_items(id)
);
CREATE TABLE IF NOT EXISTS ai_drafts (
  id TEXT PRIMARY KEY, section TEXT NOT NULL, raw_input TEXT NOT NULL, proposal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','dismissed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT OR IGNORE INTO categories(id,name,created_at) VALUES
('cat-course','课程',datetime('now')),('cat-skill','技能',datetime('now')),('cat-research','科研',datetime('now')),
('cat-competition','竞赛',datetime('now')),('cat-internship','实习',datetime('now')),('cat-other','其他',datetime('now'));
`);

const growthColumns = new Set((db.pragma('table_info(growth_items)') as { name: string }[]).map((column) => column.name));
const progressMigration = [
  { name: 'progress_percent', sql: 'ALTER TABLE growth_items ADD COLUMN progress_percent INTEGER CHECK(progress_percent IS NULL OR (progress_percent BETWEEN 0 AND 100))' },
  { name: 'progress_note', sql: "ALTER TABLE growth_items ADD COLUMN progress_note TEXT NOT NULL DEFAULT ''" },
  { name: 'progress_source', sql: "ALTER TABLE growth_items ADD COLUMN progress_source TEXT CHECK(progress_source IS NULL OR progress_source IN ('user_reported','ai_estimate'))" },
  { name: 'progress_updated_at', sql: 'ALTER TABLE growth_items ADD COLUMN progress_updated_at TEXT' },
].filter((column) => !growthColumns.has(column.name));

if (progressMigration.length) {
  const backupPath = join(dataDir, `before-progress-migration-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
  await db.backup(backupPath);
  db.transaction(() => {
    for (const column of progressMigration) db.exec(column.sql);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,?)').run(new Date().toISOString());
  }).immediate();
} else {
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,?)').run(new Date().toISOString());
}

export const now = () => new Date().toISOString();
if (!growthColumns.has('version')) {
  await db.backup(join(dataDir, `before-version-migration-${Date.now()}.sqlite`));
  db.exec('ALTER TABLE growth_items ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
}
db.exec(`CREATE TRIGGER IF NOT EXISTS growth_item_version AFTER UPDATE ON growth_items
WHEN NEW.version = OLD.version BEGIN UPDATE growth_items SET version = OLD.version + 1 WHERE id = NEW.id; END;`);
export const id = () => crypto.randomUUID();

export function snapshotItem(itemId: string, action: string) {
  const item = db.prepare('SELECT * FROM growth_items WHERE id=?').get(itemId);
  if (item) db.prepare('INSERT INTO item_history(id,item_id,snapshot,action,created_at) VALUES(?,?,?,?,?)')
    .run(id(), itemId, JSON.stringify(item), action, now());
}
