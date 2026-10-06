import './network.js';
import express from 'express';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { db, id, now, snapshotItem, dataDir } from './db.js';
import { attachToDraft, cleanupDraftAttachments, deleteUpload, draftAttachments, purgeAllAttachments, readAttachment, removeDraftAttachment, saveUploads, uploadAttachments, type SavedAttachment } from './attachments.js';
import { answerAuthPrompt, beginOpenAILogin, cancelOpenAILogin, completeJSON, disconnectOpenAI, getAIStatus, getLoginSnapshot, setSelectedModel, refreshModels, testConnection, selectAccount, recordDiagnostic } from './ai.js';
import { AIError, normalizeError } from './ai-errors.js';
import { dailyProposalSchema, dailyReplanSchema, dailyTaskSchema, growthProposalSchema, manualGrowthItemSchema } from './schema.js';

const app = express();
const port = Number(process.env.PORT ?? 4178);
app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => {
  if (req.hostname !== '127.0.0.1' && req.hostname !== 'localhost' && req.hostname !== '[::1]') return res.sendStatus(403);
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(process.env.NODE_ENV === 'development' || process.argv[1]?.endsWith('index.ts') ? ['http://127.0.0.1:5173'] : [])].includes(req.headers.origin)) return res.sendStatus(403);
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function route(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    const report = (error: unknown) => {
      if (res.headersSent) return next(error);
      const storage = /SQLITE|ENOENT|EACCES|ENOSPC/.test(String((error as { code?: string })?.code));
      const failure = error instanceof AIError ? error : storage ? normalizeError(error, '数据保存') : new AIError('业务校验', 'validation_failed', '本地业务校验未通过。', '检查输入或重新整理建议；原输入及建议保留。');
      recordDiagnostic(failure.diagnostic);
      const message = !(error instanceof AIError) && !storage && error instanceof Error ? error.message : failure.message;
      res.status(storage ? 500 : 400).json({ error: message, diagnostic: failure.diagnostic });
    };
    try { Promise.resolve(handler(req, res, next)).catch(report); }
    catch (error) { report(error); }
  };
}

function ensurePlan(date: string) {
  db.prepare('INSERT OR IGNORE INTO daily_plans(date,budget_minutes,created_at,updated_at) VALUES(?,720,?,?)').run(date, now(), now());
}

function isValidDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const growthRows = `SELECT i.*, c.name AS category, g.title AS goalTitle,
  EXISTS(SELECT 1 FROM item_history latest WHERE latest.item_id=i.id AND latest.id=(SELECT id FROM item_history h WHERE h.item_id=i.id AND h.action NOT LIKE 'undo:%' ORDER BY h.created_at DESC, h.rowid DESC LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM item_history u WHERE u.action='undo:'||latest.id)) AS canUndo,
  (SELECT action FROM item_history h WHERE h.item_id=i.id AND h.action NOT LIKE 'undo:%' ORDER BY h.created_at DESC,h.rowid DESC LIMIT 1) AS lastAction
  FROM growth_items i LEFT JOIN categories c ON c.id=i.category_id LEFT JOIN goals g ON g.id=i.goal_id`;

function persistGrowthItem(raw: Record<string, unknown>, source: 'manual'|'ai' = 'ai') {
  const op=String(raw.op ?? (raw.id ? 'update' : 'create'));
  const itemId=raw.id == null ? null : String(raw.id);
  const current=itemId ? db.prepare('SELECT * FROM growth_items WHERE id=?').get(itemId) as Record<string,unknown>|undefined : undefined;
  if(op==='create' && itemId) throw new Error('新增事项不能携带记录编号。');
  if(op!=='create' && !current) throw new Error('被修改的事项已不存在，请刷新后重试。');
  if(op!=='create' && Number(raw.expectedVersion)!==Number(current?.version)) throw new Error('事项已在其他位置修改，请刷新后重新编辑。');
  if(op==='archive') { snapshotItem(itemId!, 'archive'); db.prepare('UPDATE growth_items SET archived_at=?,updated_at=? WHERE id=?').run(now(),now(),itemId); return itemId!; }
  const item=manualGrowthItemSchema.parse({
    title:raw.title,category:raw.category ?? '其他',status:raw.status,description:raw.description ?? current?.description ?? '',priority:raw.priority ?? current?.priority ?? 2,
    startedOn:raw.startedOn === undefined ? current?.started_on ?? null : raw.startedOn,
    dueOn:raw.dueOn === undefined ? current?.due_on ?? null : raw.dueOn,
    completedOn:raw.completedOn === undefined ? current?.completed_on ?? null : raw.completedOn,
    progressPercent:raw.progressPercent === undefined ? current?.progress_percent ?? null : raw.progressPercent,
    progressNote:raw.progressNote === undefined ? current?.progress_note ?? '' : raw.progressNote,
    nextAction:raw.nextAction ?? current?.next_action ?? '',link:raw.link ?? current?.link ?? '',goalTitle:raw.goalTitle ?? ''
  });
  for(const value of [item.startedOn,item.dueOn,item.completedOn]) if(value && !isValidDateOnly(value)) throw new Error('日期无效，请使用有效的 YYYY-MM-DD 日期。');
  if(item.status==='in_progress' && (!item.dueOn || item.progressPercent===null)) throw new Error('进行中事项必须补齐截止日期和完成进度。');
  const progressChanged=!current || item.progressPercent!==(current.progress_percent ?? null) || item.progressNote!==String(current.progress_note ?? '');
  const progressSource=source==='manual' ? (progressChanged && item.progressPercent!==null ? 'user_reported' : current?.progress_source ?? null) : raw.progressSource ?? current?.progress_source ?? null;
  const progressUpdatedAt=progressChanged ? now() : current?.progress_updated_at ?? null;
  let category=db.prepare('SELECT id FROM categories WHERE name=?').get(item.category) as {id:string}|undefined;
  if(!category){const categoryId=id();db.prepare('INSERT INTO categories(id,name,created_at) VALUES(?,?,?)').run(categoryId,item.category,now());category={id:categoryId};}
  let goalId:string|null=null;
  if(item.goalTitle){const goal=db.prepare('SELECT id FROM goals WHERE title=? AND archived_at IS NULL').get(item.goalTitle) as {id:string}|undefined;goalId=goal?.id ?? id();if(!goal)db.prepare('INSERT INTO goals(id,title,created_at) VALUES(?,?,?)').run(goalId,item.goalTitle,now());}
  const action=op==='create'?'created':op==='restore'?'restore':current?.status!==item.status?'move':source;
  if(op==='create'){
    const createdId=id();
    db.prepare('INSERT INTO growth_items(id,title,category_id,status,description,priority,started_on,due_on,completed_on,next_action,link,goal_id,progress_percent,progress_note,progress_source,progress_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(createdId,item.title,category.id,item.status,item.description,item.priority,item.startedOn,item.dueOn,item.completedOn,item.nextAction,item.link,goalId,item.progressPercent,item.progressNote,progressSource,progressUpdatedAt,now(),now());
    snapshotItem(createdId,'created'); return createdId;
  }
  if(!itemId || !current) throw new Error('更新事项缺少有效编号。');
  snapshotItem(itemId,action);
  db.prepare('UPDATE growth_items SET title=?,category_id=?,status=?,description=?,priority=?,started_on=?,due_on=?,completed_on=?,next_action=?,link=?,goal_id=?,progress_percent=?,progress_note=?,progress_source=?,progress_updated_at=?,updated_at=?,archived_at=NULL WHERE id=?')
    .run(item.title,category.id,item.status,item.description,item.priority,item.startedOn,item.dueOn,item.completedOn,item.nextAction,item.link,goalId,item.progressPercent,item.progressNote,progressSource,progressUpdatedAt,now(),itemId);
  return itemId;
}

app.post('/api/items',route((req,res)=>{
  const parsed=manualGrowthItemSchema.parse(req.body);
  const createdId=db.transaction(()=>persistGrowthItem({...parsed,id:null,op:'create'},'manual')).immediate();
  res.status(201).json({item:db.prepare(`${growthRows} WHERE i.id=?`).get(createdId)});
}));
app.patch('/api/items/:id',route((req,res)=>{
  const itemId=String(req.params.id),version=Number(req.body.expectedVersion);
  if(!Number.isInteger(version)||version<0) throw new Error('修改请求缺少有效事项版本，请刷新后重试。');
  const updatedId=db.transaction(()=>persistGrowthItem({...req.body,id:itemId,expectedVersion:version,op:'update'},'manual')).immediate();
  res.json({item:db.prepare(`${growthRows} WHERE i.id=?`).get(updatedId)});
}));
for(const op of ['archive','restore'] as const) app.post(`/api/items/:id/${op}`,route((req,res)=>{
  const itemId=String(req.params.id),version=Number(req.body.expectedVersion);
  if(!Number.isInteger(version)||version<0) throw new Error('修改请求缺少有效事项版本，请刷新后重试。');
  db.transaction(()=>persistGrowthItem({...req.body,id:itemId,expectedVersion:version,op},'manual')).immediate();
  res.json({ok:true});
}));
let buildId = 'development';
try { buildId = JSON.parse(readFileSync(join(process.cwd(), 'dist/build-info.json'), 'utf8')).id; } catch { /* development */ }
app.get('/api/health', (_req, res) => res.json({ ok: true, integration: 'siwc-official-v2', buildId, startedAt: startedAt, dataDir }));
const startedAt = new Date().toISOString();
app.post('/api/attachments',(req,res,next)=>uploadAttachments(req,res,error=>{
  if(error){const code=(error as {code?:string}).code;const failure=new AIError('附件校验',code==='LIMIT_FILE_SIZE'?'attachment_too_large':code==='LIMIT_FILE_COUNT'?'too_many_attachments':'invalid_multipart','附件无法上传。',code==='LIMIT_FILE_SIZE'?'单个附件不能超过 10 MiB。':'一次最多添加 5 个附件。');recordDiagnostic(failure.diagnostic);res.status(400).json({error:failure.message,diagnostic:failure.diagnostic});return;}
  next();
}),route((req,res)=>res.status(201).json({attachments:saveUploads(req.files)})));
app.get('/api/attachments/:id',route((req,res)=>{const file=readAttachment(String(req.params.id));res.type(file.mimeType).set('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`).send(file.buffer);}));
app.delete('/api/attachments/:id',route((req,res)=>res.json({deleted:deleteUpload(String(req.params.id))})));
app.post('/api/drafts/:id/attachments',route((req,res)=>{
  const draftId=String(req.params.id),draft=db.prepare("SELECT attachment_ids FROM ai_drafts WHERE id=? AND status='pending'").get(draftId) as {attachment_ids:string}|undefined;
  if(!draft) throw new Error('这条草稿不存在或已经处理。');
  const added=Array.isArray(req.body.attachmentIds)?req.body.attachmentIds.map(String):[];
  if(!added.length||added.length>5||new Set(added).size!==added.length) throw new Error('请选择 1 到 5 个有效附件。');
  const current=JSON.parse(draft.attachment_ids||'[]') as string[],all=[...current,...added];
  if(all.length>5||new Set(all).size!==all.length) throw new Error('草稿附件最多 5 个，不能重复添加。');
  const attachments=attachToDraft(draftId,all),updated=db.prepare('SELECT attachment_meta FROM ai_drafts WHERE id=?').get(draftId) as {attachment_meta:string};
  res.json({attachments,attachmentMeta:JSON.parse(updated.attachment_meta||'[]')});
}));
app.delete('/api/drafts/:id/attachments/:attachmentId',route((req,res)=>{removeDraftAttachment(String(req.params.id),String(req.params.attachmentId));res.json({ok:true});}));
app.get('/api/state', (req, res) => {
  const date = String(req.query.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
  ensurePlan(date);
  const plan = db.prepare('SELECT * FROM daily_plans WHERE date=?').get(date);
  const tasks = db.prepare('SELECT t.*, i.title AS itemTitle, source.plan_date AS continued_from_date, successor.plan_date AS continued_to_date, successor.title AS continued_to_title FROM daily_tasks t LEFT JOIN growth_items i ON i.id=t.item_id LEFT JOIN daily_tasks source ON source.id=t.continued_from LEFT JOIN daily_tasks successor ON successor.continued_from=t.id WHERE t.plan_date=? ORDER BY CASE t.status WHEN \'open\' THEN 0 WHEN \'done\' THEN 1 ELSE 2 END, t.priority ASC, t.created_at ASC').all(date);
  const items = db.prepare(`${growthRows} WHERE i.archived_at IS NULL ORDER BY CASE i.status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, i.due_on IS NULL, i.due_on ASC, i.updated_at DESC`).all();
  const archivedItems = db.prepare(`${growthRows} WHERE i.archived_at IS NOT NULL ORDER BY i.updated_at DESC`).all();
  const categories = db.prepare('SELECT * FROM categories ORDER BY name').all();
  const goals = db.prepare('SELECT * FROM goals WHERE archived_at IS NULL ORDER BY created_at DESC').all();
  const pendingDrafts = (db.prepare("SELECT id,section,raw_input,proposal,attachment_ids,attachment_meta,status,created_at FROM ai_drafts WHERE status='pending' ORDER BY created_at DESC").all() as {id:string;attachment_ids:string;attachment_meta:string;[key:string]:unknown}[]).map(draft=>({...draft,attachments:draftAttachments(draft.id),attachmentMeta:JSON.parse(draft.attachment_meta || '[]')}));
  res.json({ date, plan, tasks, items, archivedItems, categories, goals, pendingDrafts });
});

app.post('/api/items/:id/undo', route((req, res) => {
  const current = db.prepare('SELECT * FROM growth_items WHERE id=?').get(String(req.params.id)) as Record<string, unknown> | undefined;
  if (!current) throw new Error('找不到这条成长记录。');
  if(req.body.expectedVersion!==undefined&&Number(req.body.expectedVersion)!==Number(current.version)) throw new Error('事项已在其他位置修改，请刷新后再撤销。');
  const history = db.prepare("SELECT * FROM item_history WHERE item_id=? AND action NOT LIKE 'undo:%' ORDER BY created_at DESC,rowid DESC").all(String(req.params.id)) as { id: string; snapshot: string; action: string }[];
  const undone = new Set((db.prepare("SELECT action FROM item_history WHERE item_id=? AND action LIKE 'undo:%'").all(String(req.params.id)) as { action: string }[]).map((entry) => entry.action.slice(5)));
  const target = history.find((entry) => !undone.has(entry.id));
  if (!target) throw new Error('没有可撤销的变更。');
  snapshotItem(String(req.params.id), `undo:${target.id}`);
  if (target.action === 'created') db.prepare('UPDATE growth_items SET archived_at=?,updated_at=? WHERE id=?').run(now(), now(), req.params.id);
  else {
    const previous = JSON.parse(target.snapshot) as Record<string, unknown>;
    db.prepare('UPDATE growth_items SET title=?,category_id=?,status=?,description=?,priority=?,started_on=?,due_on=?,completed_on=?,next_action=?,link=?,goal_id=?,progress_percent=?,progress_note=?,progress_source=?,progress_updated_at=?,updated_at=?,archived_at=? WHERE id=?')
      .run(previous.title, previous.category_id, previous.status, previous.description, previous.priority, previous.started_on, previous.due_on, previous.completed_on, previous.next_action, previous.link, previous.goal_id, previous.progress_percent ?? null, previous.progress_note ?? '', previous.progress_source ?? null, previous.progress_updated_at ?? null, now(), previous.archived_at, req.params.id);
  }
  res.json({ ok: true });
}));

app.patch('/api/plan/:date', route((req, res) => {
  const budget = Number(req.body?.budgetMinutes);
  if (!Number.isInteger(budget) || budget < 30 || budget > 720 || budget%30!==0) throw new Error('每日预算需为半小时的整数倍，范围是 0.5 到 12 小时。');
  ensurePlan(String(req.params.date));
  db.prepare('UPDATE daily_plans SET budget_minutes=?,updated_at=? WHERE date=?').run(budget, now(), String(req.params.date));
  res.json({ plan: db.prepare('SELECT * FROM daily_plans WHERE date=?').get(String(req.params.date)) });
}));

app.post('/api/tasks', route((req, res) => {
  const input = dailyTaskSchema.parse(req.body);
  const date = String(req.body.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
  if(!isValidDateOnly(date)) throw new Error('任务日期无效。');
  if(input.itemId&&!db.prepare('SELECT id FROM growth_items WHERE id=? AND archived_at IS NULL').get(input.itemId)) throw new Error('关联的成长事项不存在或已归档。');
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
    itemId: req.body.itemId === undefined ? current.item_id as string|null : req.body.itemId===null||req.body.itemId===''?null:String(req.body.itemId),
  };
  if (!next.title || !Number.isInteger(next.estimate) || next.estimate < 5 || next.estimate > 720 || !Number.isInteger(next.priority)||next.priority<1||next.priority>3||String(next.criteria).length>500||(next.actual !== null && (!Number.isInteger(next.actual) || next.actual < 0)) || !['open','done','cancelled'].includes(String(next.status))) throw new Error('请检查任务标题、时长、优先级或状态。');
  if(next.itemId&&!db.prepare('SELECT id FROM growth_items WHERE id=? AND archived_at IS NULL').get(next.itemId)) throw new Error('关联的成长事项不存在或已归档。');
  db.prepare('UPDATE daily_tasks SET title=?,estimate_minutes=?,actual_minutes=?,priority=?,completion_criteria=?,item_id=?,status=?,updated_at=? WHERE id=?')
    .run(next.title, next.estimate, next.actual, next.priority, next.criteria, next.itemId, next.status, now(), req.params.id);
  res.json({ task: db.prepare('SELECT * FROM daily_tasks WHERE id=?').get(req.params.id) });
}));

app.get('/api/ai/status', route(async (_req, res) => res.json(await getAIStatus())));
app.get('/api/ai/events', (_req, res) => res.status(410).json({ error: '请改用 /api/ai/status 获取当前授权状态。' }));
app.post('/api/ai/login', route(async (req, res) => { res.json({ login: await beginOpenAILogin(typeof req.body.accountKey === 'string' ? req.body.accountKey : undefined, req.body.fresh === true, req.body.reconsent === true) }); }));
app.post('/api/ai/reply', route((req, res) => {
  if (!answerAuthPrompt(String(req.body.attemptId ?? ''), String(req.body.promptId ?? ''), String(req.body.value ?? ''))) throw new Error('登录输入已过期，请重新开始授权。');
  res.json({ ok: true });
}));
app.post('/api/ai/cancel', route((req, res) => {
  if (!cancelOpenAILogin(String(req.body.attemptId ?? ''))) throw new Error('这次授权已结束或已过期。');
  res.json({ login: getLoginSnapshot() });
}));
app.post('/api/ai/logout', route(async (_req, res) => { res.json({ ok: true, message: await disconnectOpenAI() }); }));
app.post('/api/ai/models', route(async (_req, res) => res.json(await refreshModels())));
app.post('/api/ai/account', route(async (req, res) => { await selectAccount(String(req.body.key)); res.json(await getAIStatus()); }));
app.patch('/api/ai/model', route(async (req, res) => { await setSelectedModel(String(req.body.modelId ?? '')); res.json(await getAIStatus()); }));
app.post('/api/ai/test', route(async (_req, res) => {
  res.json(await testConnection());
}));

const growthInstructions = `你是个人成长记录整理助手。用户从${'{section}'}板块输入经历、进展或计划。结合当前事项判断需要新增、修改、归档、恢复或跨状态移动。不要编造日期、成绩、成果或期限。信息不明确或冲突时，简短提出澄清问题并减少危险变更。新增或转入进行中必须收集明确的截止日期；缺失时 dueOn=null 并在 clarification 询问，不能猜日期。进行中事项必须记录 0-100 的进度；可根据用户明确陈述的里程碑估算，需设置 progressSource="ai_estimate"，并在 progressNote 说明估算依据；证据不足时 progressPercent=null 并询问。用户直接给出的百分比用 progressSource="user_reported"。对于进度没有变化的记录，省略 progressPercent/progressNote/progressSource，不要清空原值；对其他未变化字段也尽量省略。只输出一个合法 JSON 对象，结构为 {"clarification":"可为空","suggestions":[{"id":null,"op":"create|update|archive|restore|move","title":"","category":"课程|技能|科研|竞赛|实习|其他","status":"completed|in_progress|planned","description":"","priority":1,"startedOn":null,"dueOn":null,"completedOn":null,"progressPercent":50,"progressNote":"进度判断依据","progressSource":"user_reported|ai_estimate","nextAction":"","link":"","goalTitle":""}]}。update/move/archive/restore 必须使用现有事项 id；新增时 id 为 null。priority:1高2中3低。日期用 YYYY-MM-DD 或 null。`;

function dailyBasis(date:string,budgetMinutes:number) {
  ensurePlan(date);
  const plan=db.prepare('SELECT budget_minutes,updated_at FROM daily_plans WHERE date=?').get(date) as {budget_minutes:number;updated_at:string};
  if(plan.budget_minutes!==budgetMinutes) db.prepare('UPDATE daily_plans SET budget_minutes=?,updated_at=? WHERE date=?').run(budgetMinutes,now(),date);
  const currentPlan=db.prepare('SELECT budget_minutes,updated_at FROM daily_plans WHERE date=?').get(date) as {budget_minutes:number;updated_at:string};
  const dayTasks=db.prepare("SELECT id,title,estimate_minutes,actual_minutes,priority,completion_criteria,item_id,status,updated_at FROM daily_tasks WHERE plan_date=? AND status IN ('open','done') ORDER BY created_at,id").all(date) as {id:string;title:string;estimate_minutes:number;actual_minutes:number|null;priority:number;completion_criteria:string;item_id:string|null;status:string;updated_at:string}[];
  const completedUsed=dayTasks.filter(t=>t.status==='done').reduce((sum,t)=>sum+(t.actual_minutes??t.estimate_minutes),0);
  const items=db.prepare(`${growthRows} WHERE i.status IN ('in_progress','planned') AND i.archived_at IS NULL ORDER BY i.due_on IS NULL,i.due_on,i.priority,i.updated_at DESC`).all() as (Record<string,unknown>&{id:string;version:number;status:string;due_on:string|null;priority:number;progress_percent:number|null;next_action:string})[];
  const previousTasks=db.prepare("SELECT t.id,t.plan_date,t.title,t.estimate_minutes,t.actual_minutes,t.priority,t.completion_criteria,t.item_id,t.status,t.updated_at FROM daily_tasks t WHERE t.plan_date<? AND t.plan_date>=date(?,'-30 days') AND t.status='open' AND NOT EXISTS(SELECT 1 FROM daily_tasks next WHERE next.continued_from=t.id) ORDER BY t.plan_date DESC,t.priority ASC,t.created_at DESC LIMIT 20").all(date,date) as {id:string;plan_date:string;title:string;estimate_minutes:number;actual_minutes:number|null;priority:number;completion_criteria:string;item_id:string|null;status:string;updated_at:string}[];
  return {date,budgetMinutes:currentPlan.budget_minutes,planUpdatedAt:currentPlan.updated_at,completedUsed,dayTasks,items,previousTasks,taskVersions:dayTasks.map(({id,updated_at,status})=>({id,updatedAt:updated_at,status})),taskSnapshots:dayTasks,itemVersions:items.map(({id,version})=>({id,version}))};
}

async function makeProposal(draftId:string,section:string,input:string,attachments:SavedAttachment[],date:string,budgetMinutes:number) {
  let proposal:unknown, rawResult='';
  const preserveRaw=(raw:string)=>{rawResult=raw;};
  try {
    if(section==='daily'||section==='daily_replan'){
      const basis=dailyBasis(date,budgetMinutes),open=basis.dayTasks.filter(t=>t.status==='open');
      const prompt=`为 ${date} 规划当日任务。总时间预算 ${budgetMinutes} 分钟；已完成任务按实际用时计 ${basis.completedUsed} 分钟；剩余预算 ${Math.max(0,budgetMinutes-basis.completedUsed)} 分钟。进行中和待进行事项（包含截止日期、优先级、进度、下一步）：${JSON.stringify(basis.items)}。当日已完成任务：${JSON.stringify(basis.dayTasks.filter(t=>t.status==='done'))}。现有未完成任务：${JSON.stringify(open)}。近 30 天内其他日期的未完成任务仅作为候选，用户必须逐项确认后才能接续，不能自动复制：${JSON.stringify(basis.previousTasks)}。用户补充说明：${input||'无'}。紧急顺序：已逾期、今日到期、3日内到期、7日内到期、其他；结合优先级和进度安排。现有未完成任务必须逐个在建议中选择 keep（原样保留）、update（改写或拆分）、defer（暂缓）；允许新增 create。若决定接续历史任务，使用新的 create 建议并填写 sourceTaskId=原任务 id；不要自动带入所有候选项。defer 不计入预算。不要安排起止时段，不虚构事项、截止日期或工作量；资料不足时写 clarification，不为填满预算造任务。每项建议须有预计分钟数、优先级、完成标准、关联事项 id 或 null、简短 reason。tasks 采用 JSON：{"clarification":"","tasks":[{"id":null,"op":"create|keep|update|defer","sourceTaskId":null,"title":"","estimateMinutes":45,"priority":1,"completionCriteria":"","itemId":null,"reason":""}]}。只返回 JSON。`;
      const validated=await completeJSON('你是严谨的每日任务规划助手。根据用户的实际成长事项安排可执行任务，明确优先级和推荐理由。遵循总预算，不安排钟点，不自动完成成长事项，不编造任务。只返回合法 JSON。',prompt,raw=>dailyProposalSchema.parse(JSON.parse(raw)),attachments,preserveRaw);
      const ids=validated.tasks.filter(t=>t.id!==null).map(t=>t.id!);
      if(new Set(ids).size!==ids.length||ids.length!==open.length||open.some(task=>!ids.includes(task.id))) throw new Error('AI 没有覆盖全部现有未完成任务，请重新生成。');
      if(validated.tasks.some(t=>t.id===null&&t.op!=='create'||t.id!==null&&(t.op==='create'||!open.some(task=>task.id===t.id)))) throw new Error('AI 建议引用了无效的现有任务。');
      const activeItemIds=new Set(basis.items.map(item=>item.id));
      if(validated.tasks.some(t=>t.itemId!==null&&!activeItemIds.has(t.itemId))) throw new Error('AI 建议关联了不可用的成长事项。');
      const previousById=new Map(basis.previousTasks.map(task=>[task.id,task]));
      const carryIds=validated.tasks.filter(task=>task.sourceTaskId!==null).map(task=>task.sourceTaskId!);
      if(new Set(carryIds).size!==carryIds.length||validated.tasks.some(task=>task.sourceTaskId!==null&&(!previousById.has(task.sourceTaskId)||task.id!==null||task.op!=='create'))) throw new Error('AI 建议接续了不可用的历史任务。');
      const taskById=new Map(basis.dayTasks.map(task=>[task.id,task]));
      const normalizedTasks=validated.tasks.map(task=>{
        if(task.sourceTaskId){const source=previousById.get(task.sourceTaskId);return {...task,sourceDate:source?.plan_date??null};}
        if(task.op!=='keep'&&task.op!=='defer') return task;
        const original=task.id?taskById.get(task.id):undefined;
        if(!original) return task;
        return {...task,title:original.title,estimateMinutes:original.estimate_minutes,priority:original.priority,completionCriteria:original.completion_criteria,itemId:original.item_id};
      });
      const planned=normalizedTasks.filter(t=>t.op!=='defer').reduce((sum,t)=>sum+t.estimateMinutes,0);
      if(basis.completedUsed+planned>budgetMinutes) throw new Error('已完成用时加上建议任务超过预算，请降低预算或重新生成。');
      proposal={...validated,tasks:normalizedTasks,basis:{date,budgetMinutes,planUpdatedAt:basis.planUpdatedAt,completedUsed:basis.completedUsed,taskVersions:basis.taskVersions,taskSnapshots:basis.taskSnapshots,previousTaskSnapshots:basis.previousTasks,itemVersions:basis.itemVersions},totalMinutes:planned+basis.completedUsed};
    }else if(['completed','in_progress','planned'].includes(section)){
      const records=db.prepare(growthRows).all() as (Record<string,unknown>&{id:string;category?:string;goalTitle?:string})[];
      const sectionName=section==='completed'?'已完成':section==='in_progress'?'进行中':'待进行';
      const parsed=await completeJSON(`${growthInstructions.replace('${section}',sectionName)} archived_at 非空的事项属于已归档记录，若用户要恢复它们应使用 restore 操作。`, `当前板块：${sectionName}\n已有事项：${JSON.stringify(records)}\n用户输入：${input||'用户仅提供附件，请先识别资料中的事实并整理建议。'}`,raw=>growthProposalSchema.parse(JSON.parse(raw)),attachments,preserveRaw);
      const byId=new Map(records.map(record=>[record.id,record]));
      proposal={...parsed,suggestions:parsed.suggestions.map(item=>{const current=item.id?byId.get(item.id):undefined;return {id:item.op==='create'?null:item.id??null,expectedVersion:current?.version,op:item.op,title:item.title,category:item.category??(typeof current?.category==='string'?current.category:'其他'),status:item.status??String(current?.status??(section==='in_progress'?'in_progress':section==='completed'?'completed':'planned')),description:item.description??String(current?.description??''),priority:item.priority??Number(current?.priority??2),startedOn:item.startedOn==null&&current?(current.started_on as string|null??null):item.startedOn??null,dueOn:item.dueOn==null&&current?(current.due_on as string|null??null):item.dueOn??null,completedOn:item.completedOn==null&&current?(current.completed_on as string|null??null):item.completedOn??null,progressPercent:item.progressPercent==null&&current?(current.progress_percent as number|null??null):item.progressPercent??null,progressNote:item.progressNote==null&&current?String(current.progress_note??''):item.progressNote??'',progressSource:item.progressSource==null&&current?(current.progress_source as 'user_reported'|'ai_estimate'|null??null):item.progressSource??null,nextAction:item.nextAction??String(current?.next_action??''),link:item.link??String(current?.link??''),goalTitle:item.goalTitle??String(current?.goalTitle??'')}})};
    }else throw new Error('未知的 AI 整理板块。');
    db.prepare('UPDATE ai_drafts SET proposal=?,updated_at=? WHERE id=?').run(JSON.stringify(proposal),now(),draftId);
    return {id:draftId,section,rawInput:input,proposal,attachments,attachmentMeta:attachments.map(({filename,mimeType,size})=>({filename,mimeType,size}))};
  }catch(error){
    const failure=error instanceof AIError?error:normalizeError(error,'业务校验');
    recordDiagnostic(failure.diagnostic);
    const prior=db.prepare('SELECT proposal FROM ai_drafts WHERE id=?').get(draftId) as {proposal:string}|undefined;
    let context:Record<string,unknown>={};try{context=JSON.parse(prior?.proposal??'{}') as Record<string,unknown>;}catch{}
    proposal={...context,failed:true,rawResult:rawResult||undefined,diagnostic:failure.diagnostic};
    db.prepare('UPDATE ai_drafts SET proposal=?,updated_at=? WHERE id=?').run(JSON.stringify(proposal),now(),draftId);
    return {id:draftId,section,rawInput:input,proposal,attachments,attachmentMeta:attachments.map(({filename,mimeType,size})=>({filename,mimeType,size})),error:{message:failure.message,diagnostic:failure.diagnostic}};
  }
}

app.post('/api/ai/propose',route(async(req,res)=>{
  const section=String(req.body.section??''),input=String(req.body.input??'').trim(),date=String(req.body.date??new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}));
  const attachmentIds=Array.isArray(req.body.attachmentIds)?req.body.attachmentIds.map(String):[];
  if(attachmentIds.length>5||new Set(attachmentIds).size!==attachmentIds.length) throw new Error('附件编号重复或超过每次 5 个的上限。');
  if(!input&&!attachmentIds.length&&section!=='daily') throw new Error('请先输入文字或附加文件。');
  if(input.length>8000) throw new Error('文字输入请控制在 8000 字以内。');
  let budgetMinutes=Number(req.body.budgetMinutes);
  if(section==='daily'){
    ensurePlan(date);const plan=db.prepare('SELECT budget_minutes FROM daily_plans WHERE date=?').get(date) as {budget_minutes:number};
    budgetMinutes=Number.isInteger(budgetMinutes)?budgetMinutes:plan.budget_minutes;
    if(budgetMinutes<30||budgetMinutes>720||budgetMinutes%30!==0) throw new Error('每日预算需为半小时的整数倍，范围是 0.5 到 12 小时。');
  }
  const draftId=id(),initial={failed:true,date,budgetMinutes};
  db.prepare('INSERT INTO ai_drafts(id,section,raw_input,proposal,attachment_ids,attachment_meta,status,created_at,updated_at) VALUES(?,?,?,?,?,?,\'pending\',?,?)').run(draftId,section==='daily_replan'?'daily':section,input,JSON.stringify(initial),'[]','[]',now(),now());
  const attachments=attachToDraft(draftId,attachmentIds);
  if(section==='daily') db.prepare('UPDATE daily_plans SET budget_minutes=?,updated_at=? WHERE date=?').run(budgetMinutes,now(),date);
  res.json({draft:await makeProposal(draftId,section,input,attachments,date,budgetMinutes)});
}));

app.post('/api/drafts/:id/retry',route(async(req,res)=>{
  const row=db.prepare("SELECT * FROM ai_drafts WHERE id=? AND status='pending'").get(String(req.params.id)) as {id:string;section:string;raw_input:string;proposal:string;attachment_ids:string}|undefined;
  if(!row) throw new Error('这条待处理建议不存在或已经确认。');
  const old=JSON.parse(row.proposal) as {date?:string;budgetMinutes?:number;failed?:boolean};
  if(!old.failed) throw new Error('这条建议尚未出现需要重试的失败。');
  const input=req.body.input===undefined?row.raw_input:String(req.body.input).trim();
  if(input.length>8000) throw new Error('文字输入请控制在 8000 字以内。');
  if(!input&&!row.attachment_ids||!input&&row.attachment_ids==='[]'&&row.section!=='daily') throw new Error('请先输入文字或附加文件。');
  if(req.body.input!==undefined) db.prepare('UPDATE ai_drafts SET raw_input=?,updated_at=? WHERE id=?').run(input,now(),row.id);
  const attachments=draftAttachments(row.id);
  res.json({draft:await makeProposal(row.id,row.section,input,attachments,old.date??new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),old.budgetMinutes??720)});
}));

app.post('/api/drafts/:id/apply', route((req, res) => {
  const draft = db.prepare('SELECT * FROM ai_drafts WHERE id=?').get(req.params.id) as { id: string; section: string; proposal: string; status:string } | undefined;
  if(draft?.status==='applied') return res.json({applied:0,alreadyApplied:true});
  if (!draft || draft.status!=='pending') throw new Error('这条 AI 建议已处理或已过期。');
  const trx = db.transaction(() => {
    const pending = req.body.accepted === false ? false : true;
    if (!pending) {
      db.prepare("UPDATE ai_drafts SET status='dismissed',updated_at=? WHERE id=?").run(now(), draft.id);
      return { dismissed: true };
    }
    if(draft.section==='daily'){
      const proposal=JSON.parse(draft.proposal) as {failed?:boolean;basis?:{date:string;budgetMinutes:number;planUpdatedAt:string;completedUsed:number;taskVersions:{id:string;updatedAt:string;status:string}[];taskSnapshots?:{id:string;title:string;estimate_minutes:number;actual_minutes:number|null;priority:number;completion_criteria:string;item_id:string|null;status:string;updated_at:string}[];previousTaskSnapshots?:{id:string;plan_date:string;status:string;updated_at:string}[];itemVersions:{id:string;version:number}[]};tasks?:unknown[]};
      if(proposal.failed||!proposal.basis||!proposal.tasks) throw new Error('这条建议尚未生成成功，请修复输入后重新整理。');
      const basis=proposal.basis,date=basis.date;
      if(req.body.date!==undefined&&String(req.body.date)!==date) throw new Error('当前建议属于另一个日期，请返回原日期确认。');
      const plan=db.prepare('SELECT budget_minutes,updated_at FROM daily_plans WHERE date=?').get(date) as {budget_minutes:number;updated_at:string}|undefined;
      if(!plan||plan.budget_minutes!==basis.budgetMinutes||plan.updated_at!==basis.planUpdatedAt) throw new Error('当天预算已变化，请重新生成任务建议。');
      const currentTasks=db.prepare("SELECT id,title,estimate_minutes,actual_minutes,priority,completion_criteria,item_id,status,updated_at FROM daily_tasks WHERE plan_date=? AND status IN ('open','done') ORDER BY created_at,id").all(date) as {id:string;title:string;estimate_minutes:number;actual_minutes:number|null;priority:number;completion_criteria:string;item_id:string|null;status:string;updated_at:string}[];
      const expected=basis.taskVersions, signature=(tasks:{id:string;title:string;estimate_minutes:number;actual_minutes:number|null;priority:number;completion_criteria:string;item_id:string|null;status:string;updated_at:string}[])=>JSON.stringify(tasks.map(t=>[t.id,t.updated_at,t.status,t.title,t.estimate_minutes,t.actual_minutes,t.priority,t.completion_criteria,t.item_id]));
      const expectedSignature=JSON.stringify(expected.map((t)=>{const match=basis.taskSnapshots?.find(current=>current.id===t.id);return match?[match.id,match.updated_at,match.status,match.title,match.estimate_minutes,match.actual_minutes,match.priority,match.completion_criteria,match.item_id]:null;}));
      if(!expected.length&&currentTasks.length||expected.length&&signature(currentTasks)!==expectedSignature) throw new Error('当天任务已变化，请重新生成建议。');
      const currentItems=db.prepare("SELECT id,version FROM growth_items WHERE archived_at IS NULL AND status IN ('in_progress','planned')").all() as {id:string;version:number}[];
      if(JSON.stringify(currentItems.map(i=>[i.id,i.version]).sort())!==JSON.stringify(basis.itemVersions.map(i=>[i.id,i.version]).sort())) throw new Error('成长事项或进度已更新，请重新生成任务建议。');
      const tasks=req.body.tasks===undefined?dailyProposalSchema.shape.tasks.parse(proposal.tasks):zodTasks(req.body.tasks);
      const openIds=expected.filter(t=>t.status==='open').map(t=>t.id),proposedIds=tasks.filter(t=>t.id!==null).map(t=>t.id!);
      if(new Set(proposedIds).size!==proposedIds.length||openIds.length!==proposedIds.length||openIds.some(id=>!proposedIds.includes(id))) throw new Error('建议没有覆盖全部现有未完成任务，请重新生成。');
      if(tasks.some(t=>t.id===null&&t.op!=='create'||t.id!==null&&(t.op==='create'||!openIds.includes(t.id)))) throw new Error('任务操作与现有任务不匹配，请重新生成。');
      const originalTasks=new Map((basis.taskSnapshots??[]).map(task=>[task.id,task]));
      for(const task of tasks) if(task.op==='keep'){
        const original=task.id?originalTasks.get(task.id):undefined;
        if(!original||task.title!==original.title||task.estimateMinutes!==original.estimate_minutes||task.priority!==original.priority||task.completionCriteria!==original.completion_criteria||task.itemId!==original.item_id) throw new Error('“保留”任务的内容必须与当前记录一致，请选择调整或重新规划。');
      }
      const carryTasks=tasks.filter(task=>task.sourceTaskId!==null);
      if(new Set(carryTasks.map(task=>task.sourceTaskId)).size!==carryTasks.length) throw new Error('同一条历史任务不能重复接续。');
      for(const task of carryTasks){
        if(task.id!==null||task.op!=='create') throw new Error('历史未完成任务只能作为新的接续建议。');
        const snapshot=basis.previousTaskSnapshots?.find(candidate=>candidate.id===task.sourceTaskId);
        const source=db.prepare("SELECT plan_date,status,updated_at FROM daily_tasks WHERE id=?").get(task.sourceTaskId) as {plan_date:string;status:string;updated_at:string}|undefined;
        if(!snapshot||!source||source.status!=='open'||source.plan_date>=date||source.plan_date!==snapshot.plan_date||source.updated_at!==snapshot.updated_at) throw new Error('历史任务已变化，请重新生成建议后再接续。');
      }
      const doneUsed=currentTasks.filter(t=>t.status==='done').reduce((sum,t)=>sum+(t.actual_minutes??t.estimate_minutes),0);
      const active=tasks.filter(t=>t.op!=='defer'),total=doneUsed+active.reduce((sum,t)=>sum+t.estimateMinutes,0);
      if(doneUsed!==basis.completedUsed||total>plan.budget_minutes) throw new Error('已完成用时或预算发生变化，请重新生成建议。');
      for(const task of active) if(task.itemId&&!basis.itemVersions.some(item=>item.id===task.itemId)) throw new Error('任务关联的成长事项已变化，请重新生成。');
      for(const task of tasks){
        if(task.id===null){if(task.op==='create'){if(task.sourceTaskId){const canceled=db.prepare("UPDATE daily_tasks SET status='cancelled',updated_at=? WHERE id=? AND status='open'").run(now(),task.sourceTaskId);if(canceled.changes!==1)throw new Error('历史任务已被其他操作接续，请重新规划。');}db.prepare('INSERT INTO daily_tasks(id,plan_date,title,estimate_minutes,priority,completion_criteria,item_id,continued_from,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(),date,task.title,task.estimateMinutes,task.priority,task.completionCriteria,task.itemId,task.sourceTaskId,now(),now());}continue;}
        if(task.op==='defer')db.prepare("UPDATE daily_tasks SET status='cancelled',updated_at=? WHERE id=? AND plan_date=? AND status='open'").run(now(),task.id,date);
        else if(task.op==='update')db.prepare("UPDATE daily_tasks SET title=?,estimate_minutes=?,priority=?,completion_criteria=?,item_id=?,updated_at=? WHERE id=? AND plan_date=? AND status='open'").run(task.title,task.estimateMinutes,task.priority,task.completionCriteria,task.itemId,now(),task.id,date);
      }
      db.prepare("UPDATE ai_drafts SET status='applied',updated_at=? WHERE id=?").run(now(),draft.id);
      return {applied:tasks.length};
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
    // Validate all requested active states before any write; the transaction rolls back on every failure.
    for (const item of suggestions) {
      const current = item.id ? db.prepare('SELECT * FROM growth_items WHERE id=?').get(item.id) as Record<string, unknown> | undefined : undefined;
      if (item.op !== 'create' && !current) throw new Error('被修改的事项已不存在，请重新生成建议。');
      if (item.op === 'create' && item.id != null) throw new Error('新增事项不能携带更新 ID，请重新整理建议。');
      if (item.op !== 'create') {
        const original = proposal.suggestions.find(suggestion => suggestion.id === item.id && suggestion.op !== 'create');
        if (!original || original.expectedVersion === undefined || original.expectedVersion !== current?.version) throw new Error('事项版本已变化或旧建议缺少版本，请重新整理；原输入及建议已保留。');
      }
      if (item.op === 'archive') continue;
      const dueOn = item.dueOn === undefined ? current?.due_on as string | null : item.dueOn;
      const progressPercent = item.progressPercent === undefined ? current?.progress_percent as number | null : item.progressPercent;
      const progressNote = item.progressNote === undefined ? String(current?.progress_note ?? '') : item.progressNote;
      const progressSource = item.progressSource === undefined ? current?.progress_source as string | null : item.progressSource;
      const willBeInProgress = item.status === 'in_progress';
      for (const dateValue of [item.startedOn, item.dueOn, item.completedOn]) {
        if (dateValue && !isValidDateOnly(dateValue)) throw new Error('日期无效，请使用有效的 YYYY-MM-DD 日期。');
      }
      if (willBeInProgress && !dueOn) throw new Error(`「${item.title}」属于进行中事项，请先补充截止日期。`);
      if (willBeInProgress && progressPercent == null) throw new Error(`「${item.title}」属于进行中事项，请先补充并确认进度（0 到 100%）。`);
      if (willBeInProgress && progressSource == null) throw new Error(`「${item.title}」请标明进度来自本人报告还是 AI 估算。`);
      if (willBeInProgress && progressSource === 'ai_estimate' && !progressNote.trim()) throw new Error(`「${item.title}」的 AI 进度估算需要填写依据。`);
      if (dueOn && !isValidDateOnly(dueOn)) throw new Error('截止日期无效，请重新选择有效日期。');
    }
    for (const item of suggestions) persistGrowthItem(item as unknown as Record<string,unknown>,'ai');
    db.prepare("UPDATE ai_drafts SET status='applied',updated_at=? WHERE id=?").run(now(), draft.id);
    return { applied: suggestions.length };
  });
  const result=trx();
  if(result.dismissed||draft.status==='pending'&&db.prepare("SELECT status FROM ai_drafts WHERE id=?").get(draft.id)) cleanupDraftAttachments(draft.id);
  res.json(result);
}));

function zodTasks(input: unknown) { return dailyProposalSchema.shape.tasks.parse(input); }
function zodSuggestions(input: unknown) { return growthProposalSchema.shape.suggestions.parse(input); }

app.get('/api/backup', (_req, res) => {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const tables = ['categories','goals','growth_items','item_history','daily_plans','daily_tasks','ai_drafts'];
  const data=Object.fromEntries(tables.map((table)=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
  data.ai_drafts=(data.ai_drafts as Record<string,unknown>[]).map(row=>({...row,attachment_ids:'[]'}));
  const backup = { format: 'personal-growth-platform', version: 5, createdAt: now(), tables: data };
  res.setHeader('Content-Disposition', 'attachment; filename="personal-growth-backup.json"');
  res.json(backup);
});

app.post('/api/backup/restore', route((req, res) => {
  const backup = req.body?.backup;
  if (backup?.format !== 'personal-growth-platform' || ![1, 2, 3, 4, 5].includes(backup?.version) || !backup?.tables) throw new Error('备份文件格式或版本不支持。');
  const tables = backup.tables;
  for (const name of ['categories','goals','growth_items','item_history','daily_plans','daily_tasks','ai_drafts']) if (!Array.isArray(tables[name])) throw new Error(`备份中缺少 ${name} 数据。`);
  const liveTables = ['categories','goals','growth_items','item_history','daily_plans','daily_tasks','ai_drafts'];
  const safetyTables=Object.fromEntries(liveTables.map((table)=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
  safetyTables.ai_drafts=(safetyTables.ai_drafts as Record<string,unknown>[]).map(row=>({...row,attachment_ids:'[]'}));
  const safetyBackup = { format: 'personal-growth-platform', version: 5, createdAt: now(), tables: safetyTables };
  writeFileSync(join(dataDir, `restore-safety-${Date.now()}.json`), JSON.stringify(safetyBackup, null, 2), 'utf8');
  const rollback = db.transaction(() => {
    db.exec('DELETE FROM item_history; DELETE FROM daily_tasks; DELETE FROM ai_drafts; DELETE FROM ai_attachments; DELETE FROM growth_items; DELETE FROM goals; DELETE FROM daily_plans; DELETE FROM categories;');
    const insertRows = (name: string, columns: string[]) => {
      const insert = db.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
      for (const row of tables[name] as Record<string, unknown>[]) insert.run(...columns.map((column) => column === 'progress_note' ? row[column] ?? '' : column === 'version' ? row[column] ?? 0 : ['attachment_ids','attachment_meta'].includes(column) ? row[column] ?? '[]' : row[column] ?? null));
    };
    insertRows('categories',['id','name','created_at']); insertRows('goals',['id','title','description','created_at','archived_at']);
    insertRows('growth_items',['id','title','category_id','status','description','priority','started_on','due_on','completed_on','next_action','link','goal_id','progress_percent','progress_note','progress_source','progress_updated_at','created_at','updated_at','archived_at','version']);
    insertRows('item_history',['id','item_id','snapshot','action','created_at']); insertRows('daily_plans',['date','budget_minutes','created_at','updated_at']);
    insertRows('daily_tasks',['id','plan_date','title','estimate_minutes','actual_minutes','priority','completion_criteria','item_id','continued_from','status','created_at','updated_at']);
    insertRows('ai_drafts',['id','section','raw_input','proposal','attachment_ids','attachment_meta','status','created_at','updated_at']);
  });
  rollback(); purgeAllAttachments(); res.json({ ok: true });
}));

if (process.env.NODE_ENV !== 'development') app.use(express.static(join(process.cwd(), 'dist/public')));
app.use((_req, res) => res.sendFile(join(process.cwd(), 'dist/public/index.html')));
app.listen(port, '127.0.0.1', () => console.log(`昭濂个人成长平台运行于 http://127.0.0.1:${port}，数据目录：${dataDir}`));
