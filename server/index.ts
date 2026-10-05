import express from 'express';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { db, id, now, snapshotItem, dataDir } from './db.js';
import { answerAuthPrompt, authEvents, beginOpenAILogin, completeJSON, disconnectOpenAI, getAIStatus, isLoginRunning, setSelectedModel } from './ai.js';
import { dailyProposalSchema, dailyReplanSchema, dailyTaskSchema, growthProposalSchema } from './schema.js';

const app = express();
const port = Number(process.env.PORT ?? 4178);
app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => {
  if (req.hostname !== '127.0.0.1' && req.hostname !== 'localhost' && req.hostname !== '[::1]') return res.sendStatus(403);
  next();
});

function route(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    const report = (error: unknown) => {
      if (res.headersSent) return next(error);
      const message = error instanceof Error ? error.message : '操作失败，请重试。';
      res.status(400).json({ error: message });
    };
    try { Promise.resolve(handler(req, res, next)).catch(report); }
    catch (error) { report(error); }
  };
}

function ensurePlan(date: string) {
  db.prepare('INSERT OR IGNORE INTO daily_plans(date,budget_minutes,created_at,updated_at) VALUES(?,720,?,?)').run(date, now(), now());
}

const growthRows = `SELECT i.*, c.name AS category, g.title AS goalTitle,
  EXISTS(SELECT 1 FROM item_history latest WHERE latest.item_id=i.id AND latest.id=(SELECT id FROM item_history h WHERE h.item_id=i.id AND h.action NOT LIKE 'undo:%' ORDER BY h.created_at DESC, h.rowid DESC LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM item_history u WHERE u.action='undo:'||latest.id)) AS canUndo,
  (SELECT action FROM item_history h WHERE h.item_id=i.id AND h.action NOT LIKE 'undo:%' ORDER BY h.created_at DESC,h.rowid DESC LIMIT 1) AS lastAction
  FROM growth_items i LEFT JOIN categories c ON c.id=i.category_id LEFT JOIN goals g ON g.id=i.goal_id`;
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/state', (req, res) => {
  const date = String(req.query.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
  ensurePlan(date);
  const plan = db.prepare('SELECT * FROM daily_plans WHERE date=?').get(date);
  const tasks = db.prepare('SELECT t.*, i.title AS itemTitle FROM daily_tasks t LEFT JOIN growth_items i ON i.id=t.item_id WHERE plan_date=? ORDER BY CASE t.status WHEN \'open\' THEN 0 WHEN \'done\' THEN 1 ELSE 2 END, t.priority ASC, t.created_at ASC').all(date);
  const items = db.prepare(`${growthRows} WHERE i.archived_at IS NULL ORDER BY CASE i.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, i.due_on IS NULL, i.due_on ASC, i.updated_at DESC`).all();
  const archivedItems = db.prepare(`${growthRows} WHERE i.archived_at IS NOT NULL ORDER BY i.updated_at DESC`).all();
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  const goals = db.prepare('SELECT * FROM goals WHERE archived_at IS NULL ORDER BY created_at DESC').all();
  const pendingDrafts = db.prepare("SELECT id,section,raw_input,proposal,status,created_at FROM ai_drafts WHERE status='pending' ORDER BY created_at DESC").all();
  res.json({ date, plan, tasks, items, archivedItems, categories, goals, pendingDrafts });
});

app.post('/api/items/:id/undo', route((req, res) => {
  const current = db.prepare('SELECT * FROM growth_items WHERE id=?').get(String(req.params.id)) as Record<string, unknown> | undefined;
  if (!current) throw new Error('找不到这条成长记录。');
  const history = db.prepare("SELECT * FROM item_history WHERE item_id=? AND action NOT LIKE 'undo:%' ORDER BY created_at DESC,rowid DESC").all(String(req.params.id)) as { id: string; snapshot: string; action: string }[];
  const undone = new Set((db.prepare("SELECT action FROM item_history WHERE item_id=? AND action LIKE 'undo:%'").all(String(req.params.id)) as { action: string }[]).map((entry) => entry.action.slice(5)));
  const target = history.find((entry) => !undone.has(entry.id));
  if (!target) throw new Error('没有可撤销的变更。');
  snapshotItem(String(req.params.id), `undo:${target.id}`);
  if (target.action === 'created') db.prepare('UPDATE growth_items SET archived_at=?,updated_at=? WHERE id=?').run(now(), now(), req.params.id);
  else {
    const previous = JSON.parse(target.snapshot) as Record<string, unknown>;
    db.prepare('UPDATE growth_items SET title=?,category_id=?,status=?,description=?,priority=?,started_on=?,due_on=?,completed_on=?,next_action=?,link=?,goal_id=?,updated_at=?,archived_at=? WHERE id=?')
      .run(previous.title, previous.category_id, previous.status, previous.description, previous.priority, previous.started_on, previous.due_on, previous.completed_on, previous.next_action, previous.link, previous.goal_id, now(), previous.archived_at, req.params.id);
  }
  res.json({ ok: true });
}));

app.patch('/api/plan/:date', route((req, res) => {
  const budget = Number(req.body?.budgetMinutes);
  if (!Number.isInteger(budget) || budget < 60 || budget > 720) throw new Error('每日预算需在 1 到 12 小时之间。');
  ensurePlan(String(req.params.date));
  db.prepare('UPDATE daily_plans SET budget_minutes=?,updated_at=? WHERE date=?').run(budget, now(), String(req.params.date));
  res.json({ plan: db.prepare('SELECT * FROM daily_plans WHERE date=?').get(String(req.params.date)) });
}));

app.post('/api/tasks', route((req, res) => {
  const input = dailyTaskSchema.parse(req.body);
  const date = String(req.body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
  ensurePlan(date);
  const idValue = id();
  db.prepare('INSERT INTO daily_tasks(id,plan_date,title,estimate_minutes,priority,completion_criteria,item_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(idValue, date, input.title, input.estimateMinutes, input.priority, input.completionCriteria, input.itemId, now(), now());
  res.status(201).json({ task: db.prepare('SELECT * FROM daily_tasks WHERE id=?').get(idValue) });
}));

app.patch('/api/tasks/:id', route((req, res) => {
  const current = db.prepare('SELECT * FROM daily_tasks WHERE id=?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!current) throw new Error('找不到这项任务。');
  const next = {
    title: req.body.title === undefined ? current.title : String(req.body.title).trim(),
    estimate: req.body.estimateMinutes === undefined ? Number(current.estimate_minutes) : Number(req.body.estimateMinutes),
    actual: req.body.actualMinutes === undefined ? current.actual_minutes as number | null : req.body.actualMinutes === null ? null : Number(req.body.actualMinutes),
    priority: req.body.priority === undefined ? Number(current.priority) : Number(req.body.priority),
    criteria: req.body.completionCriteria === undefined ? String(current.completion_criteria) : String(req.body.completionCriteria),
    status: req.body.status === undefined ? String(current.status) : String(req.body.status),
  };
  if (!next.title || !Number.isInteger(next.estimate) || next.estimate < 5 || next.estimate > 720 || (next.actual !== null && (!Number.isInteger(next.actual) || next.actual < 0)) || !['open','done','cancelled'].includes(String(next.status))) throw new Error('请检查任务标题、时长或状态。');
  db.prepare('UPDATE daily_tasks SET title=?,estimate_minutes=?,actual_minutes=?,priority=?,completion_criteria=?,status=?,updated_at=? WHERE id=?')
    .run(next.title, next.estimate, next.actual, next.priority, next.criteria, next.status, now(), req.params.id);
  res.json({ task: db.prepare('SELECT * FROM daily_tasks WHERE id=?').get(req.params.id) });
}));

app.get('/api/ai/status', route(async (_req, res) => res.json(await getAIStatus())));
app.get('/api/ai/events', (req, res) => res.json({ events: authEvents(Number(req.query.after ?? 0)), running: isLoginRunning() }));
app.post('/api/ai/login', route(async (_req, res) => { await beginOpenAILogin(); res.json({ started: true }); }));
app.post('/api/ai/reply', route((req, res) => {
  if (!answerAuthPrompt(String(req.body.promptId ?? ''), String(req.body.value ?? ''))) throw new Error('登录输入已过期，请重新开始授权。');
  res.json({ ok: true });
}));
app.post('/api/ai/logout', route(async (_req, res) => { await disconnectOpenAI(); res.json({ ok: true }); }));
app.patch('/api/ai/model', route(async (req, res) => { await setSelectedModel(String(req.body.modelId ?? '')); res.json(await getAIStatus()); }));
app.post('/api/ai/test', route(async (_req, res) => {
  const result = await completeJSON('Return only the JSON object {"ok":true}. Do not add other keys.', 'Connection test', (raw) => JSON.parse(raw) as { ok: boolean });
  if (result.ok !== true) throw new Error('模型连接测试没有返回预期结果。');
  res.json({ ok: true, message: '连接成功' });
}));

const growthInstructions = `你是个人成长记录整理助手。用户从${'{section}'}板块输入经历、进展或计划。结合当前事项判断需要新增、修改、归档、恢复或跨状态移动。不要编造日期、成绩、成果或期限。信息不明确或冲突时，简短提出澄清问题并减少危险变更。只输出一个合法 JSON 对象，结构为 {"clarification":"可为空","suggestions":[{"id":null,"op":"create|update|archive|restore|move","title":"","category":"课程|技能|科研|竞赛|实习|其他","status":"completed|in_progress|planned","description":"","priority":1,"startedOn":null,"dueOn":null,"completedOn":null,"nextAction":"","link":"","goalTitle":""}]}。update/move/archive/restore 必须使用现有事项 id；新增时 id 为 null。priority:1高2中3低。日期用 YYYY-MM-DD 或 null。`;

app.post('/api/ai/propose', route(async (req, res) => {
  const section = String(req.body.section ?? '');
  const input = String(req.body.input ?? '').trim();
  if (!input) throw new Error('先写下一些内容再交给 AI 整理。');
  if (input.length > 8000) throw new Error('单次输入请控制在 8000 字以内。');
  let proposal: unknown;
  if (section === 'daily') {
    const date = String(req.body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
    ensurePlan(date);
    const plan = db.prepare('SELECT * FROM daily_plans WHERE date=?').get(date) as { budget_minutes: number };
    const active = db.prepare(`${growthRows} WHERE i.status IN ('in_progress','planned') AND i.archived_at IS NULL`).all();
    const existing = db.prepare("SELECT * FROM daily_tasks WHERE plan_date=? AND status='open'").all(date);
    const prompt = `为 ${date} 安排任务。预算 ${plan.budget_minutes} 分钟。相关成长事项：${JSON.stringify(active)}。当日已有未完成任务：${JSON.stringify(existing)}。用户补充：${input}\n只输出 JSON：{"clarification":"","tasks":[{"title":"","estimateMinutes":45,"priority":1,"completionCriteria":"","itemId":null}]}。tasks 合计不能超过 ${plan.budget_minutes} 分钟；不要为了填满预算虚构任务。时长为 5 到 720 的整数，关联事项仅使用提供过的 id。`;
    proposal = await completeJSON('你是严谨的每日任务规划助手。只使用用户提供的信息，生成切实可执行的任务；每项任务写清可判断的完成标准。优先安排有期限和高优先级事项，不把休息算入时长。只返回合法 JSON。', prompt, (raw) => dailyProposalSchema.parse(JSON.parse(raw)));
    const validated = dailyProposalSchema.parse(proposal);
    if (validated.tasks.reduce((sum, task) => sum + task.estimateMinutes, 0) > plan.budget_minutes) throw new Error('AI 建议超过当天时间预算，请调整后重试。');
  } else if (section === 'daily_replan') {
    const date = String(req.body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
    ensurePlan(date);
    const plan = db.prepare('SELECT * FROM daily_plans WHERE date=?').get(date) as { budget_minutes: number };
    const tasks = db.prepare("SELECT id,title,estimate_minutes FROM daily_tasks WHERE plan_date=? AND status='open' ORDER BY priority ASC").all(date);
    const prompt = `当天预算为 ${plan.budget_minutes} 分钟；这些未完成任务的当前安排是：${JSON.stringify(tasks)}。请只在任务确实可缩短时降低预计用时，或在确认重复时把该项分钟数设为 5（不得删除任务或改标题）。调整后总时长应尽量不超过预算；无法做到时如实说明原因。用户补充：${input}\n只返回 JSON：{"clarification":"","tasks":[{"id":"现有任务id","estimateMinutes":45}]}，每项 id 必须从清单中选，任务数量和顺序保持一致。`;
    const result = await completeJSON('你是负责压缩超额日程的助手。保护任务本身，不删除、不取消、不篡改内容；仅建议降低预计投入时间，并解释必要的取舍。只返回合法 JSON。', prompt, (raw) => dailyReplanSchema.parse(JSON.parse(raw)));
    const currentIds = new Set((tasks as { id: string }[]).map((task) => task.id));
    if (result.tasks.length !== currentIds.size || result.tasks.some((task) => !currentIds.has(task.id)) || new Set(result.tasks.map((task) => task.id)).size !== currentIds.size) throw new Error('AI 返回了不完整的任务调整，请重试。');
    const revisedTotal = result.tasks.reduce((sum, task) => sum + task.estimateMinutes, 0);
    proposal = { ...result, totalMinutes: revisedTotal, overBudgetMinutes: Math.max(0, revisedTotal - plan.budget_minutes), currentTasks: tasks };
  } else if (['completed','in_progress','planned'].includes(section)) {
    const records = db.prepare(growthRows).all();
    const sectionName = section === 'completed' ? '已完成' : section === 'in_progress' ? '进行中' : '待进行';
    proposal = await completeJSON(`${growthInstructions.replace('${section}', sectionName)} archived_at 非空的事项属于已归档记录，若用户要恢复它们应使用 restore 操作。`, `当前板块：${sectionName}\n已有事项：${JSON.stringify(records)}\n用户输入：${input}`, (raw) => growthProposalSchema.parse(JSON.parse(raw)));
  } else throw new Error('未知的 AI 整理板块。');
  const draftId = id();
  db.prepare('INSERT INTO ai_drafts(id,section,raw_input,proposal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(draftId, section, input, JSON.stringify(proposal), 'pending', now(), now());
  res.json({ draft: { id: draftId, section, rawInput: input, proposal } });
}));

app.post('/api/drafts/:id/apply', route((req, res) => {
  const draft = db.prepare("SELECT * FROM ai_drafts WHERE id=? AND status='pending'").get(req.params.id) as { id: string; section: string; proposal: string } | undefined;
  if (!draft) throw new Error('这条 AI 建议已处理或已过期。');
  const trx = db.transaction(() => {
    const pending = req.body.accepted === false ? false : true;
    if (!pending) {
      db.prepare("UPDATE ai_drafts SET status='dismissed',updated_at=? WHERE id=?").run(now(), draft.id);
      return { dismissed: true };
    }
    if (draft.section === 'daily_replan') {
      const proposal = dailyReplanSchema.parse(JSON.parse(draft.proposal));
      const tasks = req.body.tasks === undefined ? proposal.tasks : dailyReplanSchema.shape.tasks.parse(req.body.tasks);
      const date = String(req.body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
      const plan = db.prepare('SELECT budget_minutes FROM daily_plans WHERE date=?').get(date) as { budget_minutes: number };
      const currentOpen = db.prepare("SELECT id,estimate_minutes FROM daily_tasks WHERE plan_date=? AND status='open'").all(date) as { id: string; estimate_minutes: number }[];
      if (tasks.length !== currentOpen.length || tasks.some((task) => !currentOpen.some((current) => current.id === task.id))) throw new Error('任务已发生变化，请重新生成调整建议。');
      if (tasks.reduce((sum, task) => sum + task.estimateMinutes, 0) > plan.budget_minutes) throw new Error('调整后的任务总时长仍超过预算。');
      for (const task of tasks) db.prepare('UPDATE daily_tasks SET estimate_minutes=?,updated_at=? WHERE id=? AND plan_date=? AND status=\'open\'').run(task.estimateMinutes, now(), task.id, date);
      db.prepare("UPDATE ai_drafts SET status='applied',updated_at=? WHERE id=?").run(now(), draft.id);
      return { applied: tasks.length };
    }
    if (draft.section === 'daily') {
      const date = String(req.body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
      ensurePlan(date);
      const proposal = dailyProposalSchema.parse(JSON.parse(draft.proposal));
      const tasks = req.body.tasks === undefined ? proposal.tasks : zodTasks(req.body.tasks);
      const plan = db.prepare('SELECT budget_minutes FROM daily_plans WHERE date=?').get(date) as { budget_minutes: number };
      const current = db.prepare("SELECT COALESCE(SUM(estimate_minutes),0) AS total FROM daily_tasks WHERE plan_date=? AND status='open'").get(date) as { total: number };
      const added = tasks.reduce((sum, task) => sum + task.estimateMinutes, 0);
      if (current.total + added > plan.budget_minutes) throw new Error('已有任务加上这批任务会超过当天预算，请先调整时长。');
      for (const task of tasks) db.prepare('INSERT INTO daily_tasks(id,plan_date,title,estimate_minutes,priority,completion_criteria,item_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id(), date, task.title, task.estimateMinutes, task.priority, task.completionCriteria, task.itemId, now(), now());
      db.prepare("UPDATE ai_drafts SET status='applied',updated_at=? WHERE id=?").run(now(), draft.id);
      return { applied: tasks.length };
    }
    const proposal = growthProposalSchema.parse(JSON.parse(draft.proposal));
    const suggestions = req.body.suggestions === undefined ? proposal.suggestions : zodSuggestions(req.body.suggestions);
    for (const item of suggestions) {
      let category = db.prepare('SELECT id FROM categories WHERE name=?').get(item.category) as { id: string } | undefined;
      if (!category) {
        const categoryId = id(); db.prepare('INSERT INTO categories(id,name,created_at) VALUES(?,?,?)').run(categoryId, item.category, now()); category = { id: categoryId };
      }
      let goalId: string | null = null;
      if (item.goalTitle) {
        const goal = db.prepare('SELECT id FROM goals WHERE title=? AND archived_at IS NULL').get(item.goalTitle) as { id: string } | undefined;
        goalId = goal?.id ?? id();
        if (!goal) db.prepare('INSERT INTO goals(id,title,created_at) VALUES(?,?,?)').run(goalId, item.goalTitle, now());
      }
      if (item.op === 'create') {
        const itemId = id();
        db.prepare('INSERT INTO growth_items(id,title,category_id,status,description,priority,started_on,due_on,completed_on,next_action,link,goal_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(itemId, item.title, category.id, item.status, item.description, item.priority, item.startedOn, item.dueOn, item.completedOn, item.nextAction, item.link, goalId, now(), now());
        snapshotItem(itemId, 'created');
        continue;
      }
      if (!item.id) throw new Error('更新事项缺少记录编号，请重新生成建议。');
      const current = db.prepare('SELECT * FROM growth_items WHERE id=?').get(item.id);
      if (!current) throw new Error('被修改的事项已不存在，请重新生成建议。');
      snapshotItem(item.id, item.op);
      if (item.op === 'archive') db.prepare('UPDATE growth_items SET archived_at=?,updated_at=? WHERE id=?').run(now(), now(), item.id);
      else if (item.op === 'restore') db.prepare('UPDATE growth_items SET archived_at=NULL,updated_at=? WHERE id=?').run(now(), item.id);
      else db.prepare('UPDATE growth_items SET title=?,category_id=?,status=?,description=?,priority=?,started_on=?,due_on=?,completed_on=?,next_action=?,link=?,goal_id=?,updated_at=?,archived_at=NULL WHERE id=?')
        .run(item.title, category.id, item.status, item.description, item.priority, item.startedOn, item.dueOn, item.completedOn, item.nextAction, item.link, goalId, now(), item.id);
    }
    db.prepare("UPDATE ai_drafts SET status='applied',updated_at=? WHERE id=?").run(now(), draft.id);
    return { applied: suggestions.length };
  });
  res.json(trx());
}));

function zodTasks(input: unknown) { return dailyProposalSchema.shape.tasks.parse(input); }
function zodSuggestions(input: unknown) { return growthProposalSchema.shape.suggestions.parse(input); }

app.get('/api/backup', (_req, res) => {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const tables = ['categories','goals','growth_items','item_history','daily_plans','daily_tasks','ai_drafts'];
  const backup = { format: 'personal-growth-platform', version: 1, createdAt: now(), tables: Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])) };
  res.setHeader('Content-Disposition', 'attachment; filename="personal-growth-backup.json"');
  res.json(backup);
});

app.post('/api/backup/restore', route((req, res) => {
  const backup = req.body?.backup;
  if (backup?.format !== 'personal-growth-platform' || backup?.version !== 1 || !backup?.tables) throw new Error('备份文件格式或版本不支持。');
  const tables = backup.tables;
  for (const name of ['categories','goals','growth_items','item_history','daily_plans','daily_tasks','ai_drafts']) if (!Array.isArray(tables[name])) throw new Error(`备份中缺少 ${name} 数据。`);
  const liveTables = ['categories','goals','growth_items','item_history','daily_plans','daily_tasks','ai_drafts'];
  const safetyBackup = { format: 'personal-growth-platform', version: 1, createdAt: now(), tables: Object.fromEntries(liveTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])) };
  writeFileSync(join(dataDir, `restore-safety-${Date.now()}.json`), JSON.stringify(safetyBackup, null, 2), 'utf8');
  const rollback = db.transaction(() => {
    db.exec('DELETE FROM item_history; DELETE FROM daily_tasks; DELETE FROM ai_drafts; DELETE FROM growth_items; DELETE FROM goals; DELETE FROM daily_plans; DELETE FROM categories;');
    const insertRows = (name: string, columns: string[]) => {
      const insert = db.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
      for (const row of tables[name] as Record<string, unknown>[]) insert.run(...columns.map((column) => row[column] ?? null));
    };
    insertRows('categories',['id','name','created_at']); insertRows('goals',['id','title','description','created_at','archived_at']);
    insertRows('growth_items',['id','title','category_id','status','description','priority','started_on','due_on','completed_on','next_action','link','goal_id','created_at','updated_at','archived_at']);
    insertRows('item_history',['id','item_id','snapshot','action','created_at']); insertRows('daily_plans',['date','budget_minutes','created_at','updated_at']);
    insertRows('daily_tasks',['id','plan_date','title','estimate_minutes','actual_minutes','priority','completion_criteria','item_id','status','created_at','updated_at']);
    insertRows('ai_drafts',['id','section','raw_input','proposal','status','created_at','updated_at']);
  });
  rollback(); res.json({ ok: true });
}));

if (process.env.NODE_ENV !== 'development') app.use(express.static(join(process.cwd(), 'dist/public')));
app.use((_req, res) => res.sendFile(join(process.cwd(), 'dist/public/index.html')));
app.listen(port, '127.0.0.1', () => console.log(`个人成长平台运行于 http://127.0.0.1:${port}，数据目录：${dataDir}`));
