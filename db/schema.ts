import { integer, sqliteTable, text, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const records = sqliteTable("records", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  title: text("title").notNull(), level: text("level").notNull(),
  category: text("category").notNull(), status: text("status").notNull(),
  parentId: text("parent_id"), notes: text("notes").notNull().default(""),
  outcome: text("outcome").notNull().default(""), linksJson: text("links_json").notNull().default("[]"),
  startText: text("start_text").notNull().default(""), dueDate: text("due_date").notNull().default(""),
  completedText: text("completed_text").notNull().default(""),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [index("idx_records_owner_status").on(t.ownerId, t.status), index("idx_records_owner_parent").on(t.ownerId, t.parentId)]);

export const drafts = sqliteTable("drafts", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  source: text("source").notNull(), sourceText: text("source_text").notNull(),
  changesJson: text("changes_json").notNull(), questionsJson: text("questions_json").notNull().default("[]"),
  status: text("status").notNull().default("pending"), revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [index("idx_drafts_owner_status").on(t.ownerId, t.status)]);

export const history = sqliteTable("history", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  draftId: text("draft_id").notNull(), recordId: text("record_id").notNull(),
  action: text("action").notNull(), occurredText: text("occurred_text").notNull().default(""),
  beforeJson: text("before_json"), afterJson: text("after_json").notNull(), createdAt: text("created_at").notNull(),
}, (t) => [index("idx_history_owner_record").on(t.ownerId, t.recordId), index("idx_history_owner_created").on(t.ownerId, t.createdAt)]);

// If an optimistic lock fails, this CHECK aborts the entire D1 batch.
export const commitChecks = sqliteTable("commit_checks", {
  id: text("id").primaryKey(), ok: integer("ok").notNull(),
}, (t) => [check("commit_checks_ok", sql`${t.ok} = 1`)]);

export const browserTokens = sqliteTable("browser_tokens", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  expiresAt: text("expires_at").notNull(),
});
