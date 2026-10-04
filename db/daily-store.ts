import { env } from "cloudflare:workers";
import type { GrowthRecord } from "@/lib/growth";
import { GrowthError } from "@/db/growth-store";

type Row = Record<string, unknown>;
const db = () => {
  if (!env.DB) throw new GrowthError("数据库暂时不可用", 503);
  return env.DB;
};
const stamp = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const text = (value: unknown, max = 400) => String(value ?? "").trim().slice(0, max);
const amount = (value: unknown, label: string) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new GrowthError(`${label}必须大于 0`);
  return n;
};
export const beijingToday = () => new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

function planRow(row: Row) {
  return { id: String(row.id), ownerId: String(row.owner_id), date: String(row.task_date),
    availableMinutes: Number(row.available_minutes), focus: String(row.focus), status: String(row.status),
    revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function taskRow(row: Row) {
  return { id: String(row.id), ownerId: String(row.owner_id), planId: String(row.plan_id), title: String(row.title),
    kind: String(row.kind) as "project" | "habit", recordId: row.record_id ? String(row.record_id) : null,
    habitId: row.habit_id ? String(row.habit_id) : null, unit: String(row.unit), targetAmount: Number(row.target_amount),
    completedAmount: Number(row.completed_amount), estimatedMinutes: Number(row.estimated_minutes), reason: String(row.reason),
    carryoverKey: String(row.carryover_key), sourceTaskId: row.source_task_id ? String(row.source_task_id) : null,
    position: Number(row.position), status: String(row.status), revision: Number(row.revision),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function habitRow(row: Row) {
  return { id: String(row.id), ownerId: String(row.owner_id), title: String(row.title), targetAmount: Number(row.target_amount),
    unit: String(row.unit), estimatedMinutes: Number(row.estimated_minutes), archived: Boolean(row.archived),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

export async function dailyOverview(ownerId: string, date = beijingToday()) {
  const current = await db().prepare("SELECT * FROM daily_plans WHERE owner_id=? AND task_date=?").bind(ownerId, date).first<Row>();
  const plans = await db().prepare("SELECT * FROM daily_plans WHERE owner_id=? ORDER BY task_date DESC LIMIT 30").bind(ownerId).all<Row>();
  const tasks = plans.results.length ? await db().prepare(`SELECT * FROM daily_tasks WHERE owner_id=? AND plan_id IN (${plans.results.map(() => "?").join(",")}) ORDER BY position,id`)
    .bind(ownerId, ...plans.results.map((row) => String(row.id))).all<Row>() : { results: [] as Row[] };
  const habits = await db().prepare("SELECT * FROM daily_habits WHERE owner_id=? ORDER BY archived,title").bind(ownerId).all<Row>();
  const progressRows = await db().prepare("SELECT record_id,COALESCE(SUM(completed_amount),0) AS amount FROM daily_tasks WHERE owner_id=? AND kind='project' AND status='active' AND record_id IS NOT NULL GROUP BY record_id")
    .bind(ownerId).all<Row>();
  const carryovers = await db().prepare(`SELECT t.* FROM daily_tasks t JOIN daily_plans p ON p.id=t.plan_id
    WHERE t.owner_id=? AND p.task_date<? AND t.status='active' AND t.kind='project'
    AND NOT EXISTS (SELECT 1 FROM daily_tasks n JOIN daily_plans np ON np.id=n.plan_id
      WHERE n.owner_id=t.owner_id AND n.carryover_key=t.carryover_key AND n.status='active'
      AND np.task_date>p.task_date AND np.task_date<?)
    ORDER BY p.task_date DESC,t.position`).bind(ownerId, date, date).all<Row>();
  return { today: date, currentPlan: current ? planRow(current) : null,
    plans: plans.results.map(planRow), tasks: tasks.results.map(taskRow), habits: habits.results.map(habitRow),
    recordProgress: Object.fromEntries(progressRows.results.map((row) => [String(row.record_id), Number(row.amount)])),
    carryovers: carryovers.results.map(taskRow).filter((task) => task.completedAmount < task.targetAmount) };
}

export async function savePlanDraft(ownerId: string, input: Record<string, unknown>, records: GrowthRecord[]) {
  const date = text(input.date, 10);
  if (date !== beijingToday()) throw new GrowthError("每日任务只能为北京时间今天生成或确认");
  const minutes = Number(input.availableMinutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) throw new GrowthError("可用时间应为 0 至 1440 分钟");
  const focus = text(input.focus, 1200);
  if (!Array.isArray(input.tasks) || input.tasks.length > 30) throw new GrowthError("每日任务最多 30 项");
  const existing = await db().prepare("SELECT * FROM daily_plans WHERE owner_id=? AND task_date=?").bind(ownerId, date).first<Row>();
  if (existing && existing.status !== "draft") throw new GrowthError("今天的任务已经确认，不能重新生成覆盖", 409);
  if (existing && Number(existing.revision) !== Number(input.expectedRevision)) throw new GrowthError("每日建议已有更新，请刷新后重试", 409);
  const planId = existing ? String(existing.id) : id();
  const revision = existing ? Number(existing.revision) + 1 : 1;
  const now = stamp();
  const plan = db().prepare(existing
    ? "UPDATE daily_plans SET available_minutes=?,focus=?,revision=?,updated_at=? WHERE id=? AND owner_id=? AND status='draft' AND revision=?"
    : "INSERT INTO daily_plans (id,owner_id,task_date,available_minutes,focus,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,'draft',1,?,?)");
  const statements = [existing ? plan.bind(minutes, focus, revision, now, planId, ownerId, Number(existing.revision))
    : plan.bind(planId, ownerId, date, minutes, focus, now, now)];
  const guardId = id();
  if (existing) statements.push(db().prepare("INSERT INTO commit_checks (id,ok) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)").bind(guardId));
  if (existing) statements.push(db().prepare("DELETE FROM daily_tasks WHERE owner_id=? AND plan_id=? AND status='suggested'").bind(ownerId, planId));
  const byRecord = new Map(records.map((record) => [record.id, record]));
  const carryovers = await dailyOverview(ownerId, date).then((snapshot) => new Map(snapshot.carryovers.map((task) => [task.id, task])));
  const progressRows = await db().prepare("SELECT record_id,COALESCE(SUM(completed_amount),0) AS amount FROM daily_tasks WHERE owner_id=? AND kind='project' AND status='active' AND record_id IS NOT NULL GROUP BY record_id")
    .bind(ownerId).all<Row>();
  const progressByRecord = new Map(progressRows.results.map((row) => [String(row.record_id), Number(row.amount)]));
  const habits = await db().prepare("SELECT * FROM daily_habits WHERE owner_id=? AND archived=0").bind(ownerId).all<Row>();
  const byHabit = new Map(habits.results.map((row) => [String(row.id), habitRow(row)]));
  const carryoverKeys = new Set<string>();
  const plannedByRecord = new Map<string, number>();
  const plannedByHabit = new Map<string, number>();
  const totalMinutes = (input.tasks as Row[]).reduce((sum, task) => sum + Math.max(0, Number(task.estimatedMinutes) || 0), 0);
  for (let position = 0; position < (input.tasks as Row[]).length; position++) {
    const raw = (input.tasks as Row[])[position];
    const kind = raw.kind === "habit" ? "habit" : raw.kind === "project" ? "project" : null;
    if (!kind) throw new GrowthError("每日任务类型无效");
    const title = text(raw.title, 160);
    if (!title) throw new GrowthError("每日任务名称不能为空");
    const target = amount(raw.targetAmount, "任务量");
    const estimated = Number(raw.estimatedMinutes ?? 0);
    if (!Number.isInteger(estimated) || estimated < 0 || estimated > 24 * 60) throw new GrowthError("任务预计时间无效");
    let recordId: string | null = null, habitId: string | null = null, unit = text(raw.unit, 30) || "次";
    if (kind === "project") {
      recordId = text(raw.recordId, 100);
      const record = byRecord.get(recordId);
      if (!record || record.status !== "ongoing" || record.archived || record.paused || record.targetAmount === null)
        throw new GrowthError(`「${title}」关联的事项不可安排，或尚未设置量化进度`);
      if (records.some((child) => child.parentId === record.id && !child.archived))
        throw new GrowthError(`「${title}」应安排到最末级步骤；上级进度会按子步骤权重汇总`);
      if (record.progressUnit !== unit) throw new GrowthError(`「${title}」的单位必须与事项一致：${record.progressUnit}`);
      const remaining = Math.max(0, record.targetAmount - record.initialAmount - (progressByRecord.get(record.id) ?? 0));
      const allocated = plannedByRecord.get(record.id) ?? 0;
      if (target + allocated > remaining + 0.000001) throw new GrowthError(`「${title}」的任务量超过事项剩余工作量（${Math.max(0, remaining - allocated)} ${unit}）`);
      plannedByRecord.set(record.id, allocated + target);
    } else {
      habitId = text(raw.habitId, 100);
      const habit = byHabit.get(habitId);
      if (!habit) throw new GrowthError(`「${title}」关联的习惯不存在`);
      const allocated = plannedByHabit.get(habitId) ?? 0;
      if (target + allocated > habit.targetAmount + 0.000001) throw new GrowthError(`「${title}」的任务量不能超过每日习惯剩余目标（${Math.max(0, habit.targetAmount - allocated)} ${habit.unit}）`);
      plannedByHabit.set(habitId, allocated + target);
      unit = habit.unit;
    }
    const sourceTaskId = text(raw.sourceTaskId, 100);
    const sourceTask = sourceTaskId ? carryovers.get(sourceTaskId) : undefined;
    if (sourceTaskId && (!sourceTask || kind !== "project" || sourceTask.kind !== "project" || sourceTask.recordId !== recordId ||
      sourceTask.unit !== unit || target > sourceTask.targetAmount - sourceTask.completedAmount + 0.000001))
      throw new GrowthError(`「${title}」的顺延来源已变化或任务量超出剩余工作，请重新生成建议`);
    const carryoverKey = (sourceTask?.carryoverKey ?? text(raw.carryoverKey, 80)) || id();
    if (carryoverKeys.has(carryoverKey)) throw new GrowthError("同一天不能重复安排同一份顺延任务");
    carryoverKeys.add(carryoverKey);
    statements.push(db().prepare(`INSERT INTO daily_tasks (id,owner_id,plan_id,title,kind,record_id,habit_id,unit,target_amount,
      completed_amount,estimated_minutes,reason,carryover_key,source_task_id,position,status,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,'suggested',1,?,?)`).bind(id(), ownerId, planId, title, kind, recordId, habitId,
        unit, target, estimated, text(raw.reason, 500), carryoverKey, sourceTask?.id ?? null, position, now, now));
  }
  if (existing) statements.push(db().prepare("DELETE FROM commit_checks WHERE id=?").bind(guardId));
  try { await db().batch(statements); } catch { throw new GrowthError("保存每日建议失败，请刷新后重试", 409); }
  return { ...(await dailyOverview(ownerId, date)).currentPlan, minutesWarning: totalMinutes > minutes };
}

export async function confirmPlan(ownerId: string, planId: string, revision: number) {
  const current = await db().prepare("SELECT * FROM daily_plans WHERE owner_id=? AND id=?").bind(ownerId, planId).first<Row>();
  if (!current || current.status !== "draft" || Number(current.revision) !== revision) throw new GrowthError("每日建议已更新，请刷新后核对", 409);
  const guardId = id();
  try { await db().batch([
    db().prepare("UPDATE daily_plans SET status='confirmed',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND status='draft' AND revision=?")
      .bind(stamp(), planId, ownerId, revision),
    db().prepare("INSERT INTO commit_checks (id,ok) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)").bind(guardId),
    db().prepare("UPDATE daily_tasks SET status='active',revision=revision+1,updated_at=? WHERE owner_id=? AND plan_id=? AND status='suggested'")
      .bind(stamp(), ownerId, planId),
    db().prepare("DELETE FROM commit_checks WHERE id=?").bind(guardId),
  ]); } catch { throw new GrowthError("确认失败，请刷新后重试", 409); }
  return dailyOverview(ownerId, String(current.task_date));
}

export async function setTaskProgress(ownerId: string, input: Record<string, unknown>) {
  const taskId = text(input.taskId, 100), key = text(input.idempotencyKey, 100);
  if (!taskId || !key) throw new GrowthError("打卡请求缺少编号");
  const prior = await db().prepare("SELECT id FROM daily_task_events WHERE owner_id=? AND idempotency_key=?").bind(ownerId, key).first<Row>();
  if (prior) return { duplicate: true };
  const task = await db().prepare("SELECT t.*,p.task_date,p.status AS plan_status FROM daily_tasks t JOIN daily_plans p ON p.id=t.plan_id WHERE t.owner_id=? AND t.id=?")
    .bind(ownerId, taskId).first<Row>();
  if (!task || task.status !== "active" || task.plan_status !== "confirmed") throw new GrowthError("任务不存在或尚未确认", 404);
  const next = Number(input.completedAmount);
  if (!Number.isFinite(next) || next < 0 || next > Number(task.target_amount)) throw new GrowthError("实际完成量必须在 0 到任务目标量之间");
  const expected = Number(input.expectedRevision);
  if (!Number.isInteger(expected) || expected !== Number(task.revision)) throw new GrowthError("任务打卡已在其他窗口更新，请刷新后再改", 409);
  const now = stamp(), checkId = id();
  const check = db().prepare("INSERT INTO commit_checks (id,ok) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)").bind(checkId);
  try {
    await db().batch([
      db().prepare("UPDATE daily_tasks SET completed_amount=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND status='active' AND revision=?")
        .bind(next, now, taskId, ownerId, expected),
      check,
      db().prepare("INSERT INTO daily_task_events (id,owner_id,task_id,idempotency_key,previous_amount,new_amount,note,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(id(), ownerId, taskId, key, Number(task.completed_amount), next, text(input.note, 500), now),
      db().prepare("DELETE FROM commit_checks WHERE id=?").bind(checkId),
    ]);
  } catch {
    const duplicate = await db().prepare("SELECT id FROM daily_task_events WHERE owner_id=? AND idempotency_key=?").bind(ownerId, key).first<Row>();
    if (duplicate) return { duplicate: true };
    throw new GrowthError("打卡未保存，任务可能已更新；请刷新查看", 409);
  }
  return { duplicate: false, task: taskRow({ ...task, completed_amount: next, revision: expected + 1, updated_at: now }) };
}

export async function saveHabit(ownerId: string, input: Record<string, unknown>) {
  const title = text(input.title, 120), unit = text(input.unit, 30) || "次";
  if (!title) throw new GrowthError("请填写习惯名称");
  const target = amount(input.targetAmount, "每日目标");
  const minutes = Number(input.estimatedMinutes ?? 0);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) throw new GrowthError("习惯预计时间无效");
  const habitId = text(input.id, 100), now = stamp();
  if (habitId) {
    const result = await db().prepare("UPDATE daily_habits SET title=?,target_amount=?,unit=?,estimated_minutes=?,archived=?,updated_at=? WHERE id=? AND owner_id=?")
      .bind(title, target, unit, minutes, Number(Boolean(input.archived)), now, habitId, ownerId).run();
    if (result.meta.changes !== 1) throw new GrowthError("习惯不存在", 404);
  } else await db().prepare("INSERT INTO daily_habits (id,owner_id,title,target_amount,unit,estimated_minutes,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)")
    .bind(id(), ownerId, title, target, unit, minutes, now, now).run();
  return dailyOverview(ownerId);
}

export async function exportDailyData(ownerId: string) {
  const plans = await db().prepare("SELECT * FROM daily_plans WHERE owner_id=? ORDER BY task_date").bind(ownerId).all<Row>();
  const habits = await db().prepare("SELECT * FROM daily_habits WHERE owner_id=? ORDER BY created_at").bind(ownerId).all<Row>();
  const tasks = await db().prepare("SELECT * FROM daily_tasks WHERE owner_id=? ORDER BY created_at").bind(ownerId).all<Row>();
  const events = await db().prepare("SELECT * FROM daily_task_events WHERE owner_id=? ORDER BY created_at").bind(ownerId).all<Row>();
  return { dailyPlans: plans.results.map(planRow), dailyHabits: habits.results.map(habitRow), dailyTasks: tasks.results.map(taskRow),
    dailyTaskEvents: events.results.map((row) => ({ id: String(row.id), ownerId: ownerId, taskId: String(row.task_id),
      idempotencyKey: String(row.idempotency_key), previousAmount: Number(row.previous_amount), newAmount: Number(row.new_amount),
      note: String(row.note), createdAt: String(row.created_at) })) };
}

export async function restoreDailyStatements(ownerId: string, data: Record<string, unknown>, recordIds: Set<string>) {
  const statements: D1PreparedStatement[] = [];
  const plans = (Array.isArray(data.dailyPlans) ? data.dailyPlans : []) as Row[];
  const habits = (Array.isArray(data.dailyHabits) ? data.dailyHabits : []) as Row[];
  const tasks = (Array.isArray(data.dailyTasks) ? data.dailyTasks : []) as Row[];
  const events = (Array.isArray(data.dailyTaskEvents) ? data.dailyTaskEvents : []) as Row[];
  if (Number(data.version) >= 2 && [data.dailyPlans, data.dailyHabits, data.dailyTasks, data.dailyTaskEvents].some((list) => !Array.isArray(list)))
    throw new GrowthError("备份缺少每日任务数据");
  const planIds = new Set(plans.map((row) => String(row?.id ?? "")));
  const habitIds = new Set(habits.map((row) => String(row?.id ?? "")));
  const taskIds = new Set(tasks.map((row) => String(row?.id ?? "")));
  const isStamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const isDay = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  for (const raw of plans) {
    const minutes = Number(raw.availableMinutes), revision = Number(raw.revision);
    if (typeof raw?.id !== "string" || !isDay(raw.date) || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440 ||
      !["draft", "confirmed"].includes(String(raw.status)) || !Number.isInteger(revision) || revision < 1 ||
      !isStamp(raw.createdAt) || !isStamp(raw.updatedAt)) throw new GrowthError("备份中的每日计划无效");
    statements.push(db().prepare("INSERT INTO daily_plans (id,owner_id,task_date,available_minutes,focus,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(raw.id, ownerId, raw.date, Number(raw.availableMinutes), text(raw.focus, 1200), String(raw.status), Number(raw.revision), String(raw.createdAt), String(raw.updatedAt)));
  }
  for (const raw of habits) {
    const estimate = Number(raw.estimatedMinutes);
    if (typeof raw?.id !== "string" || !text(raw.title, 120) || !Number.isInteger(estimate) || estimate < 0 || estimate > 1440 ||
      !isStamp(raw.createdAt) || !isStamp(raw.updatedAt)) throw new GrowthError("备份中的习惯无效");
    statements.push(db().prepare("INSERT INTO daily_habits (id,owner_id,title,target_amount,unit,estimated_minutes,archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(raw.id, ownerId, text(raw.title, 120), amount(raw.targetAmount, "习惯目标"), text(raw.unit, 30), Number(raw.estimatedMinutes), Number(Boolean(raw.archived)), String(raw.createdAt), String(raw.updatedAt)));
  }
  for (const raw of tasks) {
    const goal = Number(raw.targetAmount), completed = Number(raw.completedAmount), estimate = Number(raw.estimatedMinutes);
    if (typeof raw?.id !== "string" || !planIds.has(String(raw.planId)) || !["project", "habit"].includes(String(raw.kind)) ||
      !["suggested", "active"].includes(String(raw.status)) || !Number.isInteger(Number(raw.revision)) || Number(raw.revision) < 1 ||
      !Number.isInteger(estimate) || estimate < 0 || estimate > 1440 || !Number.isFinite(completed) || completed < 0 || completed > goal ||
      !Number.isInteger(Number(raw.position)) || !isStamp(raw.createdAt) || !isStamp(raw.updatedAt) || !text(raw.carryoverKey, 80))
      throw new GrowthError("备份中的每日任务无效");
    if (raw.kind === "project" && (!raw.recordId || !recordIds.has(String(raw.recordId)))) throw new GrowthError("备份中的项目任务关联不存在");
    if (raw.kind === "habit" && (!raw.habitId || !habitIds.has(String(raw.habitId)))) throw new GrowthError("备份中的习惯任务关联不存在");
    if (raw.sourceTaskId && !taskIds.has(String(raw.sourceTaskId))) throw new GrowthError("备份中的顺延来源不存在");
    statements.push(db().prepare(`INSERT INTO daily_tasks (id,owner_id,plan_id,title,kind,record_id,habit_id,unit,target_amount,completed_amount,
      estimated_minutes,reason,carryover_key,source_task_id,position,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(raw.id, ownerId, String(raw.planId), text(raw.title, 160), String(raw.kind), raw.recordId ?? null, raw.habitId ?? null,
        text(raw.unit, 30), amount(raw.targetAmount, "任务目标"), Number(raw.completedAmount), Number(raw.estimatedMinutes),
        text(raw.reason, 500), text(raw.carryoverKey, 80), raw.sourceTaskId ?? null, Number(raw.position), String(raw.status),
        Number(raw.revision), String(raw.createdAt), String(raw.updatedAt)));
  }
  for (const raw of events) {
    const previous = Number(raw.previousAmount), next = Number(raw.newAmount);
    if (typeof raw?.id !== "string" || !taskIds.has(String(raw.taskId)) || !raw.idempotencyKey || !Number.isFinite(previous) || previous < 0 ||
      !Number.isFinite(next) || next < 0 || !isStamp(raw.createdAt)) throw new GrowthError("备份中的打卡历史无效");
    statements.push(db().prepare("INSERT INTO daily_task_events (id,owner_id,task_id,idempotency_key,previous_amount,new_amount,note,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(raw.id, ownerId, String(raw.taskId), text(raw.idempotencyKey, 100), Number(raw.previousAmount), Number(raw.newAmount), text(raw.note, 500), String(raw.createdAt)));
  }
  return statements;
}
