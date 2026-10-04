import { integer, real, sqliteTable, text, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const records = sqliteTable("records", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  title: text("title").notNull(), level: text("level").notNull(),
  category: text("category").notNull(), status: text("status").notNull(),
  parentId: text("parent_id"), notes: text("notes").notNull().default(""),
  outcome: text("outcome").notNull().default(""), linksJson: text("links_json").notNull().default("[]"),
  startText: text("start_text").notNull().default(""), dueDate: text("due_date").notNull().default(""),
  completedText: text("completed_text").notNull().default(""),
  priority: integer("priority").notNull().default(3),
  progressUnit: text("progress_unit").notNull().default(""),
  targetAmount: real("target_amount"), initialAmount: real("initial_amount").notNull().default(0),
  progressWeight: real("progress_weight").notNull().default(1), estimatedMinutes: integer("estimated_minutes"),
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

export const modelConnections = sqliteTable("model_connections", {
  ownerId: text("owner_id").notNull(), providerId: text("provider_id").notNull(),
  encryptedToken: text("encrypted_token").notNull(), selectedModel: text("selected_model").notNull(),
  verifiedAt: text("verified_at"), isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("idx_model_connections_owner_provider").on(t.ownerId, t.providerId)]);

export const dailyPlans = sqliteTable("daily_plans", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), taskDate: text("task_date").notNull(),
  availableMinutes: integer("available_minutes").notNull(), focus: text("focus").notNull().default(""),
  status: text("status").notNull().default("draft"), revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [index("idx_daily_plans_owner_date").on(t.ownerId, t.taskDate), uniqueIndex("idx_daily_plans_unique_day").on(t.ownerId, t.taskDate)]);

export const dailyHabits = sqliteTable("daily_habits", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), title: text("title").notNull(),
  targetAmount: real("target_amount").notNull(), unit: text("unit").notNull(), estimatedMinutes: integer("estimated_minutes").notNull().default(0),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false), createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [index("idx_daily_habits_owner").on(t.ownerId, t.archived)]);

export const dailyTasks = sqliteTable("daily_tasks", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), planId: text("plan_id").notNull(),
  title: text("title").notNull(), kind: text("kind").notNull(), recordId: text("record_id"), habitId: text("habit_id"),
  unit: text("unit").notNull().default("次"), targetAmount: real("target_amount").notNull(),
  completedAmount: real("completed_amount").notNull().default(0), estimatedMinutes: integer("estimated_minutes").notNull().default(0),
  reason: text("reason").notNull().default(""), carryoverKey: text("carryover_key").notNull(),
  sourceTaskId: text("source_task_id"), position: integer("position").notNull().default(0),
  status: text("status").notNull().default("suggested"), revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [index("idx_daily_tasks_owner_plan").on(t.ownerId, t.planId), index("idx_daily_tasks_owner_carryover").on(t.ownerId, t.carryoverKey)]);

export const dailyTaskEvents = sqliteTable("daily_task_events", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), taskId: text("task_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), previousAmount: real("previous_amount").notNull(),
  newAmount: real("new_amount").notNull(), note: text("note").notNull().default(""), createdAt: text("created_at").notNull(),
}, (t) => [index("idx_daily_task_events_owner_task").on(t.ownerId, t.taskId), uniqueIndex("idx_daily_task_events_idempotency").on(t.ownerId, t.idempotencyKey)]);
