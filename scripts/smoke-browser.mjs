import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const chromeCandidates = [
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chromePath = chromeCandidates.find(existsSync);
if (!chromePath) throw new Error('Chrome was not found; run this check on the Windows app machine with Chrome installed.');
const tempRoot = await mkdtemp(join(tmpdir(), 'zhaolian-browser-smoke-'));
if (!resolve(tempRoot).startsWith(resolve(tmpdir()))) throw new Error('Refusing to use a browser profile outside the temp directory.');
const port = 45000 + Math.floor(Math.random() * 12000);
const app = spawn(process.execPath, ['dist/server/index.js'], { cwd: resolve('.'), env: { ...process.env, LOCALAPPDATA: tempRoot, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let appError = '';
app.stderr.setEncoding('utf8').on('data', (chunk) => { appError = (appError + chunk).slice(-4000); });
const request = async (path) => fetch(`http://127.0.0.1:${port}${path}`);
let chrome;
let ws;

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await request('/api/health')).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.equal(ready, true, `Test app did not start: ${appError}`);
  const db = new Database(join(tempRoot, '个人成长平台', 'growth.db'));
  const category = db.prepare("SELECT id FROM categories WHERE name='科研'").get();
  db.prepare('INSERT INTO growth_items(id,title,category_id,status,description,priority,started_on,due_on,completed_on,next_action,link,goal_id,progress_percent,progress_note,progress_source,progress_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), '浏览器进度卡片检查', category.id, 'in_progress', '验证期限与进度展示', 1, '2026-10-01', '2026-10-15', null, '完成窄屏布局检查', '', null, 38, '已完成主要实验，正在复核数据。', 'ai_estimate', new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  db.close();

  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-allow-origins=*', `--user-data-dir=${join(tempRoot, 'chrome-profile')}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = join(tempRoot, 'chrome-profile', 'DevToolsActivePort');
  let debugPort;
  for (let i = 0; i < 100; i++) {
    try { debugPort = Number((await readFile(portFile, 'utf8')).split(/\r?\n/)[0]); break; } catch {}
    await delay(100);
  }
  assert.ok(debugPort, 'Chrome DevTools did not start.');
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = pages.find((target) => target.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Chrome page target was not available.');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { ws.addEventListener('open', resolveOpen, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  const runtimeErrors = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text);
    if (message.id && pending.has(message.id)) {
      const { resolve: resolveCommand, reject: rejectCommand } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectCommand(new Error(message.error.message)); else resolveCommand(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}` });
  await delay(1400);
  const initial = await evaluate("JSON.stringify({title:document.title,brand:document.body.innerText.includes('昭濂个人成长平台'),oldBrand:document.body.innerText.includes('拾阶')})");
  const initialInfo = JSON.parse(initial);
  assert.equal(initialInfo.title, '昭濂个人成长平台');
  assert.equal(initialInfo.brand, true);
  assert.equal(initialInfo.oldBrand, false);

  await evaluate("document.querySelector('.settings-nav')?.click()");
  await delay(350);
  const settingsText = await evaluate('document.body.innerText');
  assert.match(settingsText, /出站网络：Windows 系统代理|出站网络：环境变量代理|出站网络：直连/);

  await evaluate("Array.from(document.querySelectorAll('.side-nav .nav-item')).find((el)=>el.textContent.includes('进行中'))?.click()");
  await delay(350);
  const desktopView = await evaluate("JSON.stringify({text:document.querySelector('.growth-grid')?.innerText,scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth})");
  const desktopInfo = JSON.parse(desktopView);
  if (!desktopInfo.text) console.error('UI diagnostic:', await evaluate("JSON.stringify({body:document.body.innerText,section:document.querySelector('.page-content')?.innerHTML.slice(0,500)})"));
  assert.match(desktopInfo.text, /浏览器进度卡片检查/);
  assert.match(desktopInfo.text, /38%/);
  assert.match(desktopInfo.text, /AI 估算 · 已确认/);
  assert.match(desktopInfo.text, /剩余/);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(250);
  const narrowView = JSON.parse(await evaluate("JSON.stringify({scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth,cardWidth:document.querySelector('.growth-card')?.getBoundingClientRect().width})"));
  assert.ok(narrowView.scrollWidth <= narrowView.innerWidth, `Narrow viewport overflows horizontally: ${JSON.stringify(narrowView)}`);
  assert.ok(narrowView.cardWidth > 0);
  assert.deepEqual(runtimeErrors, []);
  console.log('Chrome smoke test passed: brand/title, proxy status, progress card, and 390px layout.');
} catch (error) {
  console.error(error);
  if (appError) console.error(appError);
  process.exitCode = 1;
} finally {
  ws?.close();
  chrome?.kill();
  app.kill();
  await delay(300);
  await rm(tempRoot, { recursive: true, force: true });
}
