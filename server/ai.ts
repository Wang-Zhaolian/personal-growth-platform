import { Entry } from '@napi-rs/keyring';
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { db, now } from './db.js';

const secretEntry = new Entry('PersonalGrowthPlatform', 'pi-ai-credentials');
const store: CredentialStore = {
  async read(providerId) {
    const raw = secretEntry.getPassword();
    if (!raw) return undefined;
    const all = JSON.parse(raw) as Record<string, unknown>;
    return all[providerId] as Awaited<ReturnType<CredentialStore['read']>>;
  },
  async list() {
    const raw = secretEntry.getPassword();
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, { type?: string }>;
    return Object.entries(all).map(([providerId, value]) => ({ providerId, type: value.type === 'api_key' ? 'api_key' as const : 'oauth' as const }));
  },
  async modify(providerId, fn) {
    const all = JSON.parse(secretEntry.getPassword() ?? '{}') as Record<string, never>;
    const current = (all[providerId] as never) ?? undefined;
    const next = await fn(current);
    if (next !== undefined) all[providerId] = next as never;
    if (Object.keys(all).length) secretEntry.setPassword(JSON.stringify(all));
    else { try { secretEntry.deletePassword(); } catch { /* already empty */ } }
    return next ?? current;
  },
  async delete(providerId) {
    const all = JSON.parse(secretEntry.getPassword() ?? '{}') as Record<string, unknown>;
    delete all[providerId];
    if (Object.keys(all).length) secretEntry.setPassword(JSON.stringify(all));
    else { try { secretEntry.deletePassword(); } catch { /* already empty */ } }
  },
};

export const models = createModels({ credentials: store });
models.setProvider(openaiProvider());

type AuthEvent = { id: number; type: 'info' | 'auth_url' | 'device_code' | 'progress' | 'prompt' | 'done' | 'error'; message?: string; url?: string; userCode?: string; verificationUri?: string; promptType?: string; promptId?: string };
const events: AuthEvent[] = [];
let eventId = 0;
const pendingPrompts = new Map<string, (value: string) => void>();
let loginRunning = false;

function emit(event: Omit<AuthEvent, 'id'>) {
  events.push({ ...event, id: ++eventId });
  if (events.length > 100) events.shift();
}

export function authEvents(after = 0) { return events.filter((event) => event.id > after); }
export function isLoginRunning() { return loginRunning; }

export function answerAuthPrompt(promptId: string, value: string) {
  const resolve = pendingPrompts.get(promptId);
  if (!resolve) return false;
  pendingPrompts.delete(promptId);
  resolve(value);
  return true;
}

export async function beginOpenAILogin() {
  if (loginRunning) return;
  loginRunning = true;
  void models.login('openai', 'oauth', {
    prompt: async (prompt) => new Promise<string>((resolve, reject) => {
      const promptId = crypto.randomUUID();
      pendingPrompts.set(promptId, resolve);
      emit({ type: 'prompt', message: prompt.message, promptType: prompt.type, promptId });
      prompt.signal?.addEventListener('abort', () => {
        pendingPrompts.delete(promptId);
        reject(new Error('登录已取消'));
      }, { once: true });
    }),
    notify: (event) => {
      if (event.type === 'info') emit({ type: 'info', message: event.message });
      if (event.type === 'progress') emit({ type: 'progress', message: event.message });
      if (event.type === 'auth_url') emit({ type: 'auth_url', url: event.url });
      if (event.type === 'device_code') emit({ type: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri });
    },
  }).then(() => emit({ type: 'done', message: 'ChatGPT 授权成功' })).catch((error: unknown) => {
    emit({ type: 'error', message: error instanceof Error ? error.message : '授权失败，请重试。' });
  }).finally(() => { loginRunning = false; });
}

export async function disconnectOpenAI() {
  await models.logout('openai');
}

export async function getAIStatus() {
  const credentials = await store.list();
  const configured = credentials.some((credential) => credential.providerId === 'openai');
  const availableModels = models.getModels('openai').map((model) => ({ id: model.id, name: model.name }));
  const persisted = db.prepare("SELECT value FROM settings WHERE key='model_id'").get() as { value: string } | undefined;
  const selected = process.env.GROWTH_MODEL_ID || persisted?.value || 'gpt-4o-mini';
  return { configured, loginRunning, provider: 'openai', selectedModel: availableModels.some((model) => model.id === selected) ? selected : (availableModels[0]?.id ?? selected), models: availableModels, events: authEvents() };
}

export async function setSelectedModel(modelId: string) {
  if (!models.getModel('openai', modelId)) throw new Error('所选模型当前不可用。');
  process.env.GROWTH_MODEL_ID = modelId;
  db.prepare("INSERT INTO settings(key,value) VALUES('model_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(modelId);
}

export async function completeJSON<T>(systemPrompt: string, input: string, parse: (text: string) => T) {
  const state = await getAIStatus();
  if (!state.configured) throw new Error('请先在设置中连接 ChatGPT。');
  const model = models.getModel('openai', state.selectedModel);
  if (!model) throw new Error('模型不可用，请在设置中重新选择模型。');
  const result = await models.complete(model, {
    systemPrompt,
    messages: [{ role: 'user', content: input, timestamp: Date.now() }],
  });
  const text = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  if (!text) throw new Error('模型没有返回整理结果，请重试。');
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return parse(cleaned);
}
