import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, dataDir } from './db.js';
import { getOutboundNetworkStatus } from './network.js';
import { ChatGPTAuth } from './ai-auth.js';
import { ProtectedVault } from './ai-vault.js';
import { ChatGPTInference } from './ai-inference.js';
import { AIError, normalizeError, type Diagnostic } from './ai-errors.js';

export function recordDiagnostic(diagnostic: Diagnostic) {
  try {
    const old = JSON.parse((db.prepare("SELECT value FROM settings WHERE key='ai_diagnostics'").get() as { value?: string } | undefined)?.value ?? '[]') as Diagnostic[];
    db.prepare("INSERT INTO settings(key,value) VALUES('ai_diagnostics',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify([...old, diagnostic].slice(-30)));
  } catch { /* Diagnostics must not replace the original error. */ }
}
const setting = (key: string) => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
export const auth = new ChatGPTAuth(new ProtectedVault(join(dataDir, 'auth')), () => {
  let device = setting('device_id');
  if (!device) { device = randomUUID(); db.prepare("INSERT INTO settings(key,value) VALUES('device_id',?)").run(device); }
  return device.startsWith('urn:uuid:') ? device : `urn:uuid:${device}`;
}, () => setting('siwc_eligibility') === 'approved_private' || process.env.GROWTH_SIWC_ELIGIBILITY === 'approved_private', recordDiagnostic);
const inference = new ChatGPTInference(auth);
export const getLoginSnapshot = () => auth.login;
export const beginOpenAILogin = (key?: string, fresh?: boolean, reconsent?: boolean) => auth.begin(key, fresh, reconsent);
export const cancelOpenAILogin = (attemptId: string) => auth.cancel(attemptId);
export const answerAuthPrompt = (_attempt: string, _prompt: string, _value: string) => false;
export const disconnectOpenAI = async () => { const result = await auth.disconnect(); inference.clear(); return result; };
export const selectAccount = async (key: string) => { await auth.select(key); inference.clear(); };
export async function getAIStatus() {
  const status = await auth.status();
  const eligible = setting('siwc_eligibility') === 'approved_private' || process.env.GROWTH_SIWC_ELIGIBILITY === 'approved_private';
  return { ...status, eligible, eligibility: eligible ? '私有客户端资格由使用者确认已获批' : '私有客户端资格待确认', login: auth.login, network: getOutboundNetworkStatus(), provider: 'openai', selectedModel: setting('model_id') ?? '', models: inference.cached(status.activeKey), diagnostics: JSON.parse(setting('ai_diagnostics') ?? '[]') as Diagnostic[] };
}
export async function refreshModels() {
  const models = await inference.models();
  if (!models.some(model => model.id === setting('model_id'))) await setSelectedModel(models[0].id);
  return getAIStatus();
}
export async function setSelectedModel(modelId: string) {
  const status = await auth.status();
  if (!inference.cached(status.activeKey).some(model => model.id === modelId)) throw new AIError('模型列表', 'invalid_model', '请先获取模型列表并选择当前账号可用模型。');
  db.prepare("INSERT INTO settings(key,value) VALUES('model_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(modelId);
}
export async function testConnection() {
  await refreshModels();
  const model = setting('model_id')!;
  const result = await inference.text(model, 'Reply with exactly the text: Hello, world!', 'Connection test. No personal data.');
  if (result.text.trim() !== 'Hello, world!') throw new AIError('结果解析', 'unexpected_test_result', '已收到完整响应，但测试文本不符合预期。');
  await auth.markVerified(result.accountKey, model);
  return { ok: true, message: '已验证可调用：收到完整响应 Hello, world!', model, requestId: result.requestId };
}
export async function completeJSON<T>(systemPrompt: string, input: string, parse: (text: string) => T) {
  const status = await getAIStatus();
  if (!status.verified || status.verified.model !== status.selectedModel) throw new AIError('权限检查', 'connection_test_required', '请先在设置中主动测试当前账号与模型。', '测试只发送合成短文本；验证通过后再提交个人成长内容。');
  if (!(await getAIStatus()).models.length) await refreshModels();
  const result = await inference.text(setting('model_id') ?? '', systemPrompt, input);
  const cleaned = result.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return parse(cleaned); }
  catch (error) {
    try { db.prepare('INSERT INTO ai_drafts(id,section,raw_input,proposal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), 'ai_failed_result', input, JSON.stringify({ rawResult: result.text }), 'pending', new Date().toISOString(), new Date().toISOString()); }
    catch (saveError) { throw normalizeError(saveError, '数据保存'); }
    throw new AIError(error instanceof SyntaxError ? '结果解析' : '业务校验', 'invalid_ai_result', 'AI 结果格式不符合要求，原始结果已保留在本机失败记录中。', '修改输入后重试；可下载备份查看原始结果，未写入正式成长记录。');
  }
}
