import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dataRoot = await mkdtemp(join(tmpdir(), 'zhaolian-feature-smoke-'));
if (!resolve(dataRoot).startsWith(resolve(tmpdir()))) throw new Error('Refusing to use a test database outside the temp directory.');
const port = 44000 + Math.floor(Math.random() * 10000);
const child = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: resolve('.'), env: { ...process.env, LOCALAPPDATA: dataRoot, PORT: String(port) },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
let stderr = '';
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-5000); });
const baseUrl = `http://127.0.0.1:${port}`;
const request = async (path, options) => {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options?.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited early: ${stderr}`);
    try { ready = (await fetch(`${baseUrl}/api/health`)).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.equal(ready, true, `Test server did not become ready: ${stderr}`);
  const db = new Database(join(dataRoot, '个人成长平台', 'growth.db'));
  const date = '2026-10-06';

  const incomplete = await request('/api/items', { method: 'POST', body: JSON.stringify({ title: '缺少期限', category: '科研', status: 'in_progress' }) });
  assert.equal(incomplete.response.ok, false, 'Active records without a deadline/progress must be rejected.');
  const created = await request('/api/items', { method: 'POST', body: JSON.stringify({ title: '手动测试事项', category: '科研', status: 'in_progress', dueOn: '2026-10-20', progressPercent: 25, progressNote: '已完成初步准备', nextAction: '开始实验', priority: 1 }) });
  assert.equal(created.response.status, 201, created.body.error);
  let item = created.body.item;
  assert.equal(item.progress_source, 'user_reported');
  assert.equal(item.progress_percent, 25);
  assert.ok(item.progress_updated_at);

  const nonProgressEdit = await request(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: item.version, title: '手动测试事项（名称已改）', category: item.category, status: item.status, dueOn: item.due_on, progressPercent: item.progress_percent, progressNote: item.progress_note, description: '直接手动保存，不需要 AI。' }) });
  assert.equal(nonProgressEdit.response.ok, true, nonProgressEdit.body.error);
  const preserved = nonProgressEdit.body.item;
  assert.equal(preserved.progress_source, 'user_reported');
  assert.equal(preserved.progress_updated_at, item.progress_updated_at, 'Editing unrelated fields must preserve progress provenance/time.');
  const stale = await request(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ expectedVersion: item.version, title: '旧表单覆盖', category: '科研', status: 'in_progress', dueOn: '2026-10-20', progressPercent: 25 }) });
  assert.equal(stale.response.ok, false, 'Stale item versions must not overwrite newer manual edits.');
  item = preserved;

  const archive = await request(`/api/items/${item.id}/archive`, { method: 'POST', body: JSON.stringify({ expectedVersion: item.version }) });
  assert.equal(archive.response.ok, true, archive.body.error);
  let state = await request(`/api/state?date=${date}`);
  assert.ok(state.body.archivedItems.some((entry) => entry.id === item.id));
  const archived = state.body.archivedItems.find((entry) => entry.id === item.id);
  const restore = await request(`/api/items/${item.id}/restore`, { method: 'POST', body: JSON.stringify({ expectedVersion: archived.version, title: archived.title, category: archived.category, status: archived.status, dueOn: archived.due_on, progressPercent: archived.progress_percent, progressNote: archived.progress_note, priority: archived.priority }) });
  assert.equal(restore.response.ok, true, restore.body.error);
  state = await request(`/api/state?date=${date}`);
  item = state.body.items.find((entry) => entry.id === item.id);
  assert.ok(item, 'Restoring an item should preserve the original ID and associated records.');

  const budget = await request(`/api/plan/${date}`, { method: 'PATCH', body: JSON.stringify({ budgetMinutes: 210 }) });
  assert.equal(budget.response.ok, true, budget.body.error);
  assert.equal(budget.body.plan.budget_minutes, 210, 'Half-hour budget steps must be accepted.');
  const tooSmall = await request(`/api/plan/${date}`, { method: 'PATCH', body: JSON.stringify({ budgetMinutes: 20 }) });
  assert.equal(tooSmall.response.ok, false);
  await request(`/api/plan/${date}`, { method: 'PATCH', body: JSON.stringify({ budgetMinutes: 240 }) });

  const priorDate='2026-10-05';
  const priorPlan=await request(`/api/plan/${priorDate}`,{method:'PATCH',body:JSON.stringify({budgetMinutes:180})});
  assert.equal(priorPlan.response.ok,true,priorPlan.body.error);
  const priorTask=await request('/api/tasks',{method:'POST',body:JSON.stringify({date:priorDate,title:'昨日未完成候选',estimateMinutes:45,priority:1,completionCriteria:'整理两条文献',itemId:item.id})});
  assert.equal(priorTask.response.status,201,priorTask.body.error);
  state=await request(`/api/state?date=${date}`);
  assert.equal(state.body.tasks.some(task=>task.id===priorTask.body.task.id),false,'Previous-day open work must not be silently copied into today.');

  const createTask = async (title, minutes) => request('/api/tasks', { method: 'POST', body: JSON.stringify({ date, title, estimateMinutes: minutes, priority: 2, completionCriteria: '完成合成测试', itemId: item.id }) });
  const done = await createTask('已完成任务', 60);
  const updateDone = await request(`/api/tasks/${done.body.task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done', actualMinutes: 40 }) });
  assert.equal(updateDone.response.ok, true, updateDone.body.error);
  const openA = await createTask('保留并调整', 90);
  const openB = await createTask('由我确认暂缓', 60);
  assert.equal(openA.response.status, 201);
  assert.equal(openB.response.status, 201);
  const taskRows = db.prepare("SELECT id,title,estimate_minutes,actual_minutes,priority,completion_criteria,item_id,status,updated_at FROM daily_tasks WHERE plan_date=? AND status IN ('open','done') ORDER BY created_at,id").all(date);
  const planRow = db.prepare('SELECT budget_minutes,updated_at FROM daily_plans WHERE date=?').get(date);
  const activeItems = db.prepare("SELECT id,version FROM growth_items WHERE archived_at IS NULL AND status IN ('in_progress','planned') ORDER BY id").all();
  const previousTaskSnapshots=db.prepare("SELECT id,plan_date,title,estimate_minutes,actual_minutes,priority,completion_criteria,item_id,status,updated_at FROM daily_tasks WHERE plan_date<? AND plan_date>=date(?,'-30 days') AND status='open' ORDER BY plan_date DESC,priority ASC,created_at DESC LIMIT 20").all(date,date);
  const openIds = new Set(taskRows.filter((task) => task.status === 'open').map((task) => task.id));
  const proposalTasks = [
    { id: openA.body.task.id, op: 'update', title: '保留并调整', estimateMinutes: 100, priority: 1, completionCriteria: '完成最重要的分析', itemId: item.id, reason: '关联事项期限较近。' },
    { id: openB.body.task.id, op: 'defer', title: '由我确认暂缓', estimateMinutes: 60, priority: 2, completionCriteria: '完成合成测试', itemId: item.id, reason: '为优先事项留出预算。' },
    { id: null, op: 'create', sourceTaskId:null,sourceDate:null,title: '新增短任务', estimateMinutes: 60, priority: 2, completionCriteria: '完成一页草稿', itemId: item.id, reason: '用于验证预算核算。' },
    { id: null, op: 'create', sourceTaskId:priorTask.body.task.id,sourceDate:priorDate,title: '接续昨日的文献整理', estimateMinutes: 40, priority: 1, completionCriteria: '整理两条文献', itemId: item.id, reason: '这是历史未完成候选，经确认后继续。' },
  ];
  assert.equal(proposalTasks.filter((task) => task.id && openIds.has(task.id)).length, 2);
  const basis = { date, budgetMinutes: planRow.budget_minutes, planUpdatedAt: planRow.updated_at, completedUsed: 40, taskVersions: taskRows.map(({ id, updated_at, status }) => ({ id, updatedAt: updated_at, status })), taskSnapshots: taskRows,previousTaskSnapshots,itemVersions: activeItems };
  const draftId = randomUUID();
  db.prepare("INSERT INTO ai_drafts(id,section,raw_input,proposal,attachment_ids,attachment_meta,status,created_at,updated_at) VALUES(?,?,?,?, '[]','[]','pending',datetime('now'),datetime('now'))")
    .run(draftId, 'daily', '', JSON.stringify({ clarification: '', tasks: proposalTasks, basis }));
  const applied = await request(`/api/drafts/${draftId}/apply`, { method: 'POST', body: JSON.stringify({ date }) });
  assert.equal(applied.response.ok, true, applied.body.error);
  const again = await request(`/api/drafts/${draftId}/apply`, { method: 'POST', body: JSON.stringify({ date }) });
  assert.equal(again.response.ok, true);
  assert.equal(again.body.alreadyApplied, true, 'Confirming twice must not duplicate tasks.');
  state = await request(`/api/state?date=${date}`);
  assert.equal(state.body.tasks.find((task) => task.id === openA.body.task.id).estimate_minutes, 100);
  assert.equal(state.body.tasks.find((task) => task.id === openB.body.task.id).status, 'cancelled');
  assert.equal(state.body.tasks.filter((task) => task.title === '新增短任务').length, 1);
  assert.equal(state.body.tasks.find(task=>task.continued_from===priorTask.body.task.id)?.title,'接续昨日的文献整理');
  assert.equal(db.prepare('SELECT status FROM daily_tasks WHERE id=?').get(priorTask.body.task.id).status,'cancelled','The prior row stays in its original date as a deferred history entry.');
  const priorHistory=await request(`/api/state?date=${priorDate}`);
  assert.equal(priorHistory.body.tasks.find(task=>task.id===priorTask.body.task.id).continued_to_date,date,'The old day should show where the user-approved continuation went.');
  const totalCommitted = state.body.tasks.filter((task) => task.status !== 'cancelled').reduce((sum, task) => sum + (task.status === 'done' ? task.actual_minutes ?? task.estimate_minutes : task.estimate_minutes), 0);
  assert.equal(totalCommitted, 240, 'The done actual time plus the proposed open list is budget checked.');

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R6sAAAAASUVORK5CYII=', 'base64');
  const upload = async (name, bytes = png, type = 'image/png') => {
    const form = new FormData();
    form.append('files', new Blob([bytes], { type }), name);
    return request('/api/attachments', { method: 'POST', body: form });
  };
  const imageUpload = await upload('tiny.png');
  assert.equal(imageUpload.response.status, 201, imageUpload.body.error);
  const imageAttachment = imageUpload.body.attachments[0];
  const preview = await fetch(`${baseUrl}${imageAttachment.url}`);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await preview.arrayBuffer()).length, png.length);
  const unsupported = await upload('vector.svg', Buffer.from('<svg/>'), 'image/svg+xml');
  assert.equal(unsupported.response.ok, false, 'Unsupported attachment extensions must be rejected.');

  const draftWithAttachment = randomUUID();
  db.prepare("INSERT INTO ai_drafts(id,section,raw_input,proposal,status,created_at,updated_at) VALUES(?,?,?,?,'pending',datetime('now'),datetime('now'))")
    .run(draftWithAttachment, 'completed', 'synthetic attachment input', JSON.stringify({ failed: true }));
  db.prepare('UPDATE ai_attachments SET draft_id=? WHERE id=?').run(draftWithAttachment, imageAttachment.id);
  db.prepare('UPDATE ai_drafts SET attachment_ids=?,attachment_meta=? WHERE id=?').run(JSON.stringify([imageAttachment.id]), JSON.stringify([{ id: imageAttachment.id, filename: imageAttachment.filename, mimeType: imageAttachment.mimeType, size: imageAttachment.size }]), draftWithAttachment);
  const removed = await request(`/api/drafts/${draftWithAttachment}/attachments/${imageAttachment.id}`, { method: 'DELETE' });
  assert.equal(removed.response.ok, true, removed.body.error);
  assert.deepEqual(JSON.parse(db.prepare('SELECT attachment_ids FROM ai_drafts WHERE id=?').get(draftWithAttachment).attachment_ids), []);
  assert.deepEqual(JSON.parse(db.prepare('SELECT attachment_meta FROM ai_drafts WHERE id=?').get(draftWithAttachment).attachment_meta), []);

  const pendingId = randomUUID();
  db.prepare("INSERT INTO ai_drafts(id,section,raw_input,proposal,attachment_ids,attachment_meta,status,created_at,updated_at) VALUES(?,?,?,?, '[]','[]','pending',datetime('now'),datetime('now'))")
    .run(pendingId, 'completed', '', JSON.stringify({ failed: true }));
  const reattachUpload = await upload('reattach.png');
  assert.equal(reattachUpload.response.status, 201);
  const reattached = await request(`/api/drafts/${pendingId}/attachments`, { method: 'POST', body: JSON.stringify({ attachmentIds: [reattachUpload.body.attachments[0].id] }) });
  assert.equal(reattached.response.ok, true, reattached.body.error);
  assert.equal(reattached.body.attachments.length, 1);

  const pendingRetry = randomUUID();
  db.prepare("INSERT INTO ai_drafts(id,section,raw_input,proposal,status,created_at,updated_at) VALUES(?,?,?,?,'pending',datetime('now'),datetime('now'))")
    .run(pendingRetry, 'completed', 'original synthetic text', JSON.stringify({ failed: true }));
  const retry = await request(`/api/drafts/${pendingRetry}/retry`, { method: 'POST', body: JSON.stringify({ input: 'edited synthetic text' }) });
  assert.equal(retry.response.ok, true);
  assert.equal(db.prepare('SELECT raw_input FROM ai_drafts WHERE id=?').get(pendingRetry).raw_input, 'edited synthetic text', 'Retry must persist edited text before processing and preserve it on failure.');
  assert.equal(retry.body.draft.proposal.failed, true, 'Without a user model connection, retry should remain an explicit failure, never fake success.');

  const backupResponse = await fetch(`${baseUrl}/api/backup`);
  const backup = await backupResponse.json();
  assert.equal(backup.version, 5);
  const backupDraft = backup.tables.ai_drafts.find((entry) => entry.id === pendingId);
  assert.equal(backupDraft.attachment_ids, '[]');
  assert.ok(Array.isArray(JSON.parse(backupDraft.attachment_meta)));
  assert.equal('disk_name' in backupDraft, false, 'Backup must not contain attachment binary locations.');
  const restored = await request('/api/backup/restore', { method: 'POST', body: JSON.stringify({ backup }) });
  assert.equal(restored.response.ok, true, restored.body.error);
  state = await request(`/api/state?date=${date}`);
  const restoredPending = state.body.pendingDrafts.find((draft) => draft.id === pendingId);
  assert.ok(restoredPending);
  assert.equal(restoredPending.attachments.length, 0);
  assert.equal(restoredPending.attachmentMeta.length, 1);
  const missingBinary = await fetch(`${baseUrl}/api/attachments/${reattachUpload.body.attachments[0].id}`);
  assert.equal(missingBinary.ok, false, 'Restoring a backup must remove temporary attachment originals.');

  db.close();
  console.log('Feature smoke passed: direct edit/version/undo-safe operations, archive/restore, half-hour budget, stable-ID daily replanning and idempotency, attachment validation/retry/re-attach, and backup privacy. No account credentials or external AI requests were used.');
} catch (error) {
  console.error(error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  child.kill();
  await delay(250);
  await rm(dataRoot, { recursive: true, force: true });
}
