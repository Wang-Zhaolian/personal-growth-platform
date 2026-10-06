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
const dataRoot = await mkdtemp(join(tmpdir(), 'zhaolian-progress-smoke-'));
if (!resolve(dataRoot).startsWith(resolve(tmpdir()))) throw new Error('Refusing to use a test database outside the temp directory.');
const port = 43000 + Math.floor(Math.random() * 15000);
const child = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: resolve('.'),
  env: { ...process.env, LOCALAPPDATA: dataRoot, PORT: String(port) },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
const baseUrl = `http://127.0.0.1:${port}`;
const request = async (path, options) => {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...options?.headers } });
  const body = await response.json();
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

  const state = await request('/api/state');
  assert.equal(state.response.status, 200);
  const db = new Database(join(dataRoot, '个人成长平台', 'growth.db'));
  const missingDeadlineDraftId = randomUUID();
  const createProposal = {
    clarification: '',
    suggestions: [{ id: null, op: 'create', title: '进度冒烟测试事项', category: '科研', status: 'in_progress', description: '', priority: 2, startedOn: null, dueOn: null, completedOn: null, progressPercent: 30, progressNote: '已完成首轮数据采集', progressSource: 'user_reported', nextAction: '检查原始数据', link: '', goalTitle: '' }],
  };
  db.prepare("INSERT INTO ai_drafts(id,section,raw_input,proposal,status,created_at,updated_at) VALUES(?,?,?,?, 'pending',datetime('now'),datetime('now'))")
    .run(missingDeadlineDraftId, 'in_progress', '冒烟测试', JSON.stringify(createProposal));
  db.close();

  const rejected = await request(`/api/drafts/${missingDeadlineDraftId}/apply`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.body.error, /截止日期/);
  const missingSource = await request(`/api/drafts/${missingDeadlineDraftId}/apply`, {
    method: 'POST', body: JSON.stringify({ suggestions: [{ ...createProposal.suggestions[0], dueOn: '2026-10-31', progressSource: null }] }),
  });
  assert.equal(missingSource.response.status, 400);
  assert.match(missingSource.body.error, /本人报告还是 AI 估算/);
  const invalidDate = await request(`/api/drafts/${missingDeadlineDraftId}/apply`, {
    method: 'POST', body: JSON.stringify({ suggestions: [{ ...createProposal.suggestions[0], dueOn: '2026-02-30' }] }),
  });
  assert.equal(invalidDate.response.status, 400);
  assert.match(invalidDate.body.error, /日期无效/);

  const acceptedCreate = await request(`/api/drafts/${missingDeadlineDraftId}/apply`, {
    method: 'POST', body: JSON.stringify({ suggestions: [{ ...createProposal.suggestions[0], dueOn: '2026-10-31' }] }),
  });
  assert.equal(acceptedCreate.response.status, 200, acceptedCreate.body.error);
  const createdState = await request('/api/state');
  const item = createdState.body.items.find((entry) => entry.title === '进度冒烟测试事项');
  assert.ok(item);
  assert.equal(item.progress_percent, 30);
  assert.equal(item.progress_source, 'user_reported');
  assert.equal(item.due_on, '2026-10-31');

  // Failure must preserve both the draft and the original row transactionally.
  const failureDb = new Database(join(dataRoot, '个人成长平台', 'growth.db'));
  const failedDraft = randomUUID();
  const failureProposal = { clarification: '', suggestions: [{ ...createProposal.suggestions[0], id: item.id, expectedVersion: item.version, op: 'update', dueOn: '2026-10-31', title: 'synthetic-save-failure' }] };
  failureDb.prepare("INSERT INTO ai_drafts(id,section,raw_input,proposal,status,created_at,updated_at) VALUES(?,?,?,?, 'pending',datetime('now'),datetime('now'))").run(failedDraft,'in_progress','synthetic original input',JSON.stringify(failureProposal));
  failureDb.exec("CREATE TRIGGER synthetic_write_failure BEFORE UPDATE ON growth_items WHEN NEW.title='synthetic-save-failure' BEGIN SELECT RAISE(ABORT,'synthetic save failure'); END;");
  const failedSave = await request(`/api/drafts/${failedDraft}/apply`, { method: 'POST', body: '{}' });
  assert.equal(failedSave.response.status,500); assert.equal(failedSave.body.diagnostic.stage,'数据保存');
  assert.equal(failureDb.prepare('SELECT raw_input FROM ai_drafts WHERE id=?').get(failedDraft).raw_input,'synthetic original input');
  assert.equal(failureDb.prepare('SELECT status FROM ai_drafts WHERE id=?').get(failedDraft).status,'pending');
  assert.equal(failureDb.prepare('SELECT title FROM growth_items WHERE id=?').get(item.id).title,item.title);
  failureDb.exec('DROP TRIGGER synthetic_write_failure');
  failureDb.close();

  const literalNone = await request(`/api/drafts/${failedDraft}/apply`, { method: 'POST', body: JSON.stringify({suggestions:[{...failureProposal.suggestions[0],id:'None'}]}) });
  assert.equal(literalNone.response.status,400);
  const duplicateCreate = await request(`/api/drafts/${missingDeadlineDraftId}/apply`, { method: 'POST', body: '{}' });
  assert.equal(duplicateCreate.response.status,200);
  assert.equal(duplicateCreate.body.alreadyApplied,true);

  const updateDraftId = randomUUID();
  const updateProposal = {
    clarification: '',
    suggestions: [{ ...createProposal.suggestions[0], id: item.id, expectedVersion: item.version, op: 'update', dueOn: '2026-11-02', progressPercent: 65, progressNote: '完成三组实验并开始整理数据', progressSource: 'ai_estimate' }],
  };
  const updateDb = new Database(join(dataRoot, '个人成长平台', 'growth.db'));
  updateDb.prepare("INSERT INTO ai_drafts(id,section,raw_input,proposal,status,created_at,updated_at) VALUES(?,?,?,?, 'pending',datetime('now'),datetime('now'))")
    .run(updateDraftId, 'in_progress', '更新进度', JSON.stringify(updateProposal));
  updateDb.close();
  const estimateWithoutBasis = await request(`/api/drafts/${updateDraftId}/apply`, {
    method: 'POST', body: JSON.stringify({ suggestions: [{ ...updateProposal.suggestions[0], progressNote: '' }] }),
  });
  assert.equal(estimateWithoutBasis.response.status, 400);
  assert.match(estimateWithoutBasis.body.error, /估算需要填写依据/);
  const acceptedUpdate = await request(`/api/drafts/${updateDraftId}/apply`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(acceptedUpdate.response.status, 200, acceptedUpdate.body.error);
  const updatedState = await request('/api/state');
  const updated = updatedState.body.items.find((entry) => entry.id === item.id);
  assert.equal(updated.progress_percent, 65);
  assert.equal(updated.progress_source, 'ai_estimate');
  assert.match(updated.progress_note, /三组实验/);
  assert.ok(updated.progress_updated_at);
  assert.equal(updated.due_on, '2026-11-02');
  const staleApply = await request(`/api/drafts/${failedDraft}/apply`, { method: 'POST', body: '{}' });
  assert.equal(staleApply.response.status,400); assert.match(staleApply.body.error,/版本/);

  const undone = await request(`/api/items/${item.id}/undo`, { method: 'POST', body: '{}' });
  assert.equal(undone.response.status, 200, undone.body.error);
  const afterUndo = await request('/api/state');
  const restored = afterUndo.body.items.find((entry) => entry.id === item.id);
  assert.equal(restored.progress_percent, 30);
  assert.equal(restored.progress_source, 'user_reported');
  assert.equal(restored.due_on, '2026-10-31');

  const backupResponse = await fetch(`${baseUrl}/api/backup`);
  const backup = await backupResponse.json();
  assert.equal(backup.version, 5);
  assert.equal(backup.tables.ai_drafts.every((entry) => entry.attachment_ids === '[]'), true);
  assert.equal(backup.tables.growth_items.find((entry) => entry.id === item.id).version, restored.version);
  assert.equal(backup.tables.growth_items.find((entry) => entry.id === item.id).progress_percent, 30);
  const legacy = structuredClone(backup);
  legacy.version = 1;
  legacy.tables.growth_items = legacy.tables.growth_items.map(({ progress_percent, progress_note, progress_source, progress_updated_at, ...row }) => row);
  legacy.tables.item_history = legacy.tables.item_history.map((entry) => ({ ...entry, snapshot: JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(entry.snapshot)).filter(([key]) => !key.startsWith('progress_')))) }));
  const restoredLegacy = await request('/api/backup/restore', { method: 'POST', body: JSON.stringify({ backup: legacy }) });
  assert.equal(restoredLegacy.response.status, 200, restoredLegacy.body.error);
  const legacyState = await request('/api/state');
  const legacyItem = legacyState.body.items.find((entry) => entry.id === item.id);
  assert.equal(legacyItem.progress_percent, null);
  assert.equal(legacyItem.progress_note, '');
  assert.equal(legacyItem.due_on, '2026-10-31');

  const aiStatus = await request('/api/ai/status');
  assert.equal(aiStatus.response.status, 200);
  assert.ok(aiStatus.body.network?.source);
  assert.equal('proxyUrl' in aiStatus.body.network, false);
  console.log('Progress acceptance, required deadline, estimate provenance, undo, v5 backup, v1 restore, and sanitized network status passed.');
} catch (error) {
  console.error(error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  child.kill();
  await delay(250);
  await rm(dataRoot, { recursive: true, force: true });
}
