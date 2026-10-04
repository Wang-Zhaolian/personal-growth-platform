import { env } from "cloudflare:workers";
import {
  normalizeChanges, normalizeFields, type DraftChange, type GrowthDraft,
  type GrowthFields, type GrowthHistory, type GrowthRecord,
} from "@/lib/growth";

type Row = Record<string, unknown>;
type D1 = D1Database;
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

export class GrowthError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function db(): D1 {
  if (!env.DB) throw new GrowthError("数据库暂时不可用", 503);
  return env.DB;
}

function recordFrom(row: Row): GrowthRecord {
  return {
    id: String(row.id), ownerId: String(row.owner_id), title: String(row.title),
    level: row.level as GrowthRecord["level"], category: String(row.category),
    status: row.status as GrowthRecord["status"], parentId: row.parent_id ? String(row.parent_id) : null,
    notes: String(row.notes), outcome: String(row.outcome), links: JSON.parse(String(row.links_json)) as string[],
    startText: String(row.start_text), dueDate: String(row.due_date), completedText: String(row.completed_text),
    priority: Number(row.priority ?? 3), progressUnit: String(row.progress_unit ?? ""),
    targetAmount: row.target_amount === null || row.target_amount === undefined ? null : Number(row.target_amount),
    initialAmount: Number(row.initial_amount ?? 0), progressWeight: Number(row.progress_weight ?? 1),
    estimatedMinutes: row.estimated_minutes === null || row.estimated_minutes === undefined ? null : Number(row.estimated_minutes),
    paused: Boolean(row.paused), archived: Boolean(row.archived), version: Number(row.version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function draftFrom(row: Row): GrowthDraft {
  return {
    id: String(row.id), ownerId: String(row.owner_id), source: row.source as GrowthDraft["source"],
    sourceText: String(row.source_text), changes: JSON.parse(String(row.changes_json)) as DraftChange[],
    questions: JSON.parse(String(row.questions_json)) as string[], status: row.status as GrowthDraft["status"],
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function historyFrom(row: Row): GrowthHistory {
  return {
    id: String(row.id), ownerId: String(row.owner_id), draftId: String(row.draft_id),
    recordId: String(row.record_id), action: String(row.action), occurredText: String(row.occurred_text),
    beforeJson: row.before_json === null ? null : String(row.before_json),
    afterJson: String(row.after_json), createdAt: String(row.created_at),
  };
}

export async function listRecords(ownerId: string): Promise<GrowthRecord[]> {
  const rows = await db().prepare("SELECT * FROM records WHERE owner_id = ? ORDER BY updated_at DESC").bind(ownerId).all<Row>();
  return rows.results.map(recordFrom);
}

export async function listDrafts(ownerId: string): Promise<GrowthDraft[]> {
  const rows = await db().prepare("SELECT * FROM drafts WHERE owner_id = ? ORDER BY updated_at DESC").bind(ownerId).all<Row>();
  return rows.results.map(draftFrom);
}

export async function listHistory(ownerId: string): Promise<GrowthHistory[]> {
  const rows = await db().prepare("SELECT * FROM history WHERE owner_id = ? ORDER BY created_at DESC").bind(ownerId).all<Row>();
  return rows.results.map(historyFrom);
}

export async function getDraft(ownerId: string, id: string): Promise<GrowthDraft | null> {
  const row = await db().prepare("SELECT * FROM drafts WHERE owner_id = ? AND id = ?").bind(ownerId, id).first<Row>();
  return row ? draftFrom(row) : null;
}

export async function getRecord(ownerId: string, id: string): Promise<GrowthRecord | null> {
  const row = await db().prepare("SELECT * FROM records WHERE owner_id = ? AND id = ?").bind(ownerId, id).first<Row>();
  return row ? recordFrom(row) : null;
}

export async function overview(ownerId: string) {
  const [records, drafts, history] = await Promise.all([listRecords(ownerId), listDrafts(ownerId), listHistory(ownerId)]);
  return { records, drafts, history };
}

export async function issueBrowserToken(ownerId: string) {
  const token = uuid();
  const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db().prepare("INSERT INTO browser_tokens (id, owner_id, expires_at) VALUES (?, ?, ?)").bind(token, ownerId, expiry).run();
  return token;
}

export async function verifyBrowserToken(ownerId: string, token: string) {
  const row = await db().prepare("SELECT id FROM browser_tokens WHERE id = ? AND owner_id = ? AND expires_at > ?")
    .bind(token, ownerId, now()).first<Row>();
  if (!row) throw new GrowthError("页面会话已过期，请刷新后重试", 403);
}

export async function saveDraft(input: {
  ownerId: string; source: "chatgpt" | "manual"; sourceText: string;
  changes: unknown; questions?: unknown; id?: string; expectedRevision?: number;
}): Promise<GrowthDraft> {
  const sourceText = String(input.sourceText ?? "").trim().slice(0, 10000);
  const changes = normalizeChanges(input.changes);
  const questions = Array.isArray(input.questions)
    ? input.questions.map((q) => String(q ?? "").trim().slice(0, 500)).filter(Boolean).slice(0, 10) : [];
  if (!sourceText) throw new GrowthError("请填写原始叙述");
  const stamp = now();
  if (input.id) {
    const previous = await getDraft(input.ownerId, input.id);
    if (!previous) throw new GrowthError("草稿不存在", 404);
    if (previous.status !== "pending" || previous.revision !== input.expectedRevision) throw new GrowthError("草稿已有更新，请刷新后核对", 409);
    const result = await db().prepare("UPDATE drafts SET source_text=?, changes_json=?, questions_json=?, revision=revision+1, updated_at=? WHERE id=? AND owner_id=? AND status='pending' AND revision=?")
      .bind(sourceText, JSON.stringify(changes), JSON.stringify(questions), stamp, input.id, input.ownerId, input.expectedRevision).run();
    if (result.meta.changes !== 1) throw new GrowthError("草稿已有更新，请刷新后核对", 409);
    return (await getDraft(input.ownerId, input.id))!;
  }
  const id = uuid();
  await db().prepare("INSERT INTO drafts (id,owner_id,source,source_text,changes_json,questions_json,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',1,?,?)")
    .bind(id, input.ownerId, input.source, sourceText, JSON.stringify(changes), JSON.stringify(questions), stamp, stamp).run();
  return (await getDraft(input.ownerId, id))!;
}

export async function cancelDraft(ownerId: string, id: string, revision: number) {
  const result = await db().prepare("UPDATE drafts SET status='cancelled', revision=revision+1, updated_at=? WHERE id=? AND owner_id=? AND status='pending' AND revision=?")
    .bind(now(), id, ownerId, revision).run();
  if (result.meta.changes !== 1) throw new GrowthError("草稿已有更新，请刷新后核对", 409);
}

function validateHierarchy(record: GrowthRecord, byId: Map<string, GrowthRecord>) {
  if (!record.parentId) return;
  const parent = byId.get(record.parentId);
  if (!parent) throw new GrowthError(`「${record.title}」的上级事项不存在`);
  if (parent.ownerId !== record.ownerId || parent.id === record.id) throw new GrowthError("上级事项无效");
  if (record.level === "project" && parent.level !== "goal") throw new GrowthError("项目的上级必须是目标");
  if (record.level === "step" && parent.level !== "project") throw new GrowthError("步骤的上级必须是项目");
  if (record.level === "goal") throw new GrowthError("目标不能有上级事项");
}

const insertRecordSql = "INSERT INTO records (id,owner_id,title,level,category,status,parent_id,notes,outcome,links_json,start_text,due_date,completed_text,priority,progress_unit,target_amount,initial_amount,progress_weight,estimated_minutes,paused,archived,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const updateRecordSql = "UPDATE records SET title=?,level=?,category=?,status=?,parent_id=?,notes=?,outcome=?,links_json=?,start_text=?,due_date=?,completed_text=?,priority=?,progress_unit=?,target_amount=?,initial_amount=?,progress_weight=?,estimated_minutes=?,paused=?,archived=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND version=?";
const insertHistorySql = "INSERT INTO history (id,owner_id,draft_id,record_id,action,occurred_text,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)";

export async function commitDraft(ownerId: string, id: string, revision: number, browserToken: string) {
  await verifyBrowserToken(ownerId, browserToken);
  const draft = await getDraft(ownerId, id);
  if (!draft) throw new GrowthError("草稿不存在", 404);
  if (draft.status !== "pending" || draft.revision !== revision) throw new GrowthError("草稿已有更新，请刷新后核对", 409);
  if (draft.questions.length) throw new GrowthError("请先解决草稿中的待确认问题");
  const current = await listRecords(ownerId);
  const byId = new Map(current.map((record) => [record.id, record]));
  const tempIds = new Map<string, string>();
  for (const change of draft.changes) {
    if (change.kind === "create" && change.clientKey) {
      if (tempIds.has(change.clientKey)) throw new GrowthError("草稿中的临时编号重复");
      tempIds.set(change.clientKey, uuid());
    }
  }
  const resolveParent = (value: string | null) => value?.startsWith("temp:") ? tempIds.get(value.slice(5)) ?? null : value;
  const stamp = now();
  const mutations: { change: DraftChange; before: GrowthRecord | null; after: GrowthRecord }[] = [];
  const touched = new Set<string>();
  for (const change of draft.changes) {
    const before = change.kind === "create" ? null : byId.get(change.recordId ?? "") ?? null;
    if (change.kind !== "create" && (!before || before.version !== change.baseVersion)) throw new GrowthError("事项已在其他地方更新，请刷新草稿后重新核对", 409);
    const key = before?.id ?? change.clientKey ?? uuid();
    if (touched.has(key)) throw new GrowthError("一份草稿不能多次修改同一事项");
    touched.add(key);
    const raw = change.kind === "progress" ? {} : change.fields ?? {};
    const fields = normalizeFields(raw, before ?? undefined);
    if (fields.parentId?.startsWith("temp:") && !tempIds.has(fields.parentId.slice(5))) throw new GrowthError("草稿引用了不存在的上级事项");
    fields.parentId = resolveParent(fields.parentId) ?? null;
    const after: GrowthRecord = {
      ...fields, id: before?.id ?? tempIds.get(change.clientKey ?? "") ?? uuid(), ownerId,
      version: before ? before.version + 1 : 1, createdAt: before?.createdAt ?? stamp, updatedAt: stamp,
    };
    byId.set(after.id, after);
    mutations.push({ change, before, after });
  }
  for (const record of byId.values()) validateHierarchy(record, byId);
  const sql: D1PreparedStatement[] = [];
  const checks: string[] = [];
  const addCheck = () => {
    const checkId = uuid(); checks.push(checkId);
    sql.push(db().prepare("INSERT INTO commit_checks (id,ok) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)").bind(checkId));
  };
  sql.push(db().prepare("DELETE FROM browser_tokens WHERE id=? AND owner_id=? AND expires_at>?").bind(browserToken, ownerId, stamp));
  addCheck();
  for (const { change, before, after } of mutations) {
    if (!before) {
      sql.push(db().prepare(insertRecordSql).bind(after.id, ownerId, after.title, after.level, after.category, after.status,
        after.parentId, after.notes, after.outcome, JSON.stringify(after.links), after.startText, after.dueDate,
        after.completedText, after.priority, after.progressUnit, after.targetAmount, after.initialAmount, after.progressWeight,
        after.estimatedMinutes, Number(after.paused), Number(after.archived), 1, stamp, stamp));
    } else {
      sql.push(db().prepare(updateRecordSql).bind(after.title, after.level, after.category, after.status, after.parentId,
        after.notes, after.outcome, JSON.stringify(after.links), after.startText, after.dueDate, after.completedText,
        after.priority, after.progressUnit, after.targetAmount, after.initialAmount, after.progressWeight, after.estimatedMinutes,
        Number(after.paused), Number(after.archived), stamp, after.id, ownerId, before.version));
      addCheck();
    }
    sql.push(db().prepare(insertHistorySql).bind(uuid(), ownerId, id, after.id, change.kind,
      change.occurredText ?? "", before ? JSON.stringify(before) : null,
      JSON.stringify({ record: after, progressText: change.progressText ?? "" }), stamp));
  }
  sql.push(db().prepare("UPDATE drafts SET status='applied', revision=revision+1, updated_at=? WHERE id=? AND owner_id=? AND status='pending' AND revision=?")
    .bind(stamp, id, ownerId, revision));
  addCheck();
  sql.push(db().prepare(`DELETE FROM commit_checks WHERE id IN (${checks.map(() => "?").join(",")})`).bind(...checks));
  try { await db().batch(sql); }
  catch { throw new GrowthError("提交失败，可能有记录或草稿已更新；请刷新并核对", 409); }
  return { applied: mutations.length };
}

export async function exportData(ownerId: string) {
  const data = await overview(ownerId);
  const daily = await import("@/db/daily-store").then(({ exportDailyData }) => exportDailyData(ownerId));
  return { format: "personal-growth-platform", version: 2, exportedAt: now(), ...data, ...daily };
}

export async function restoreData(ownerId: string, backup: unknown) {
  if (!backup || typeof backup !== "object") throw new GrowthError("备份文件无效");
  const data = backup as Record<string, unknown>;
  if (data.format !== "personal-growth-platform" || ![1, 2].includes(Number(data.version)) ||
      !Array.isArray(data.records) || !Array.isArray(data.drafts) || !Array.isArray(data.history)) throw new GrowthError("备份格式不受支持");
  if (data.records.length > 10000 || data.drafts.length > 20000 || data.history.length > 50000 ||
      [data.dailyPlans, data.dailyHabits, data.dailyTasks, data.dailyTaskEvents].some((list) => Array.isArray(list) && list.length > 100000)) throw new GrowthError("备份过大");
  const existing = await overview(ownerId);
  const dailyExisting = await import("@/db/daily-store").then(({ exportDailyData }) => exportDailyData(ownerId));
  if (existing.records.length || existing.drafts.length || existing.history.length || dailyExisting.dailyPlans.length ||
      dailyExisting.dailyHabits.length || dailyExisting.dailyTasks.length || dailyExisting.dailyTaskEvents.length)
    throw new GrowthError("只能恢复到空数据库", 409);
  const sql: D1PreparedStatement[] = [];
  const checkId = uuid();
  sql.push(db().prepare("INSERT INTO commit_checks (id,ok) VALUES (?, CASE WHEN (SELECT COUNT(*) FROM records WHERE owner_id=?) + (SELECT COUNT(*) FROM drafts WHERE owner_id=?) + (SELECT COUNT(*) FROM history WHERE owner_id=?) + (SELECT COUNT(*) FROM daily_plans WHERE owner_id=?) + (SELECT COUNT(*) FROM daily_habits WHERE owner_id=?) + (SELECT COUNT(*) FROM daily_tasks WHERE owner_id=?) + (SELECT COUNT(*) FROM daily_task_events WHERE owner_id=?) = 0 THEN 1 ELSE 0 END)")
    .bind(checkId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId, ownerId));
  const ids = new Set<string>();
  const restoredRecords: GrowthRecord[] = [];
  for (const raw of data.records as Row[]) {
    if (typeof raw?.id !== "string" || ids.has(raw.id) || !Number.isInteger(raw.version)) throw new GrowthError("备份中的事项无效");
    ids.add(raw.id);
    const fields = normalizeFields(raw as Partial<GrowthFields>);
    const record: GrowthRecord = { ...fields, id: raw.id, ownerId,
      version: Number(raw.version), createdAt: String(raw.createdAt), updatedAt: String(raw.updatedAt) };
    restoredRecords.push(record);
    sql.push(db().prepare(insertRecordSql).bind(record.id, ownerId, record.title, record.level, record.category, record.status,
      record.parentId, record.notes, record.outcome, JSON.stringify(record.links), record.startText, record.dueDate,
      record.completedText, record.priority, record.progressUnit, record.targetAmount, record.initialAmount, record.progressWeight,
      record.estimatedMinutes, Number(record.paused), Number(record.archived), record.version, record.createdAt, record.updatedAt));
  }
  const byId = new Map(restoredRecords.map((r) => [r.id, r]));
  for (const record of restoredRecords) validateHierarchy(record, byId);
  for (const raw of data.drafts as Row[]) {
    if (typeof raw?.id !== "string" || !Array.isArray(raw.changes) || !["pending", "applied", "cancelled"].includes(String(raw.status)))
      throw new GrowthError("备份中的草稿无效");
    const changes = normalizeChanges(raw.changes);
    const questions = Array.isArray(raw.questions) ? raw.questions.map(String) : [];
    sql.push(db().prepare("INSERT INTO drafts (id,owner_id,source,source_text,changes_json,questions_json,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(raw.id, ownerId, raw.source === "chatgpt" ? "chatgpt" : "manual", String(raw.sourceText), JSON.stringify(changes),
        JSON.stringify(questions), String(raw.status), Number(raw.revision), String(raw.createdAt), String(raw.updatedAt)));
  }
  for (const raw of data.history as Row[]) {
    if (typeof raw?.id !== "string" || !ids.has(String(raw.recordId))) throw new GrowthError("备份中的历史记录无效");
    sql.push(db().prepare(insertHistorySql).bind(raw.id, ownerId, String(raw.draftId), String(raw.recordId),
      String(raw.action), String(raw.occurredText ?? ""), raw.beforeJson === null ? null : String(raw.beforeJson),
      String(raw.afterJson), String(raw.createdAt)));
  }
  const dailyStatements = await import("@/db/daily-store").then(({ restoreDailyStatements }) =>
    restoreDailyStatements(ownerId, data, new Set(restoredRecords.map((record) => record.id))));
  sql.push(...dailyStatements);
  sql.push(db().prepare("DELETE FROM commit_checks WHERE id=?").bind(checkId));
  try { await db().batch(sql); }
  catch { throw new GrowthError("恢复失败，原数据库没有被覆盖", 409); }
  return { records: data.records.length, drafts: data.drafts.length, history: data.history.length,
    dailyPlans: Array.isArray(data.dailyPlans) ? data.dailyPlans.length : 0,
    dailyHabits: Array.isArray(data.dailyHabits) ? data.dailyHabits.length : 0,
    dailyTasks: Array.isArray(data.dailyTasks) ? data.dailyTasks.length : 0,
    dailyTaskEvents: Array.isArray(data.dailyTaskEvents) ? data.dailyTaskEvents.length : 0 };
}
