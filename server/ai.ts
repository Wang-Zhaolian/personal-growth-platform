import { Entry } from '@napi-rs/keyring';
import { randomUUID } from 'node:crypto';
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';
import type { AuthPrompt } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { db, now } from './db.js';

const secretEntry = new Entry('PersonalGrowthPlatform', 'pi-ai-credentials');
const credentialTails = new Map<string, Promise<void>>();

function withCredentialLock<T>(providerId: string, action: () => Promise<T>): Promise<T> {
  const previous = credentialTails.get(providerId) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => turn);
  credentialTails.set(providerId, tail);
  return previous.then(action).finally(() => {
    release();
    if (credentialTails.get(providerId) === tail) credentialTails.delete(providerId);
  });
}

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
  modify(providerId, fn) {
    return withCredentialLock(providerId, async () => {
      const all = JSON.parse(secretEntry.getPassword() ?? '{}') as Record<string, never>;
      const current = (all[providerId] as never) ?? undefined;
      const next = await fn(current);
      if (next !== undefined) all[providerId] = next as never;
      if (Object.keys(all).length) secretEntry.setPassword(JSON.stringify(all));
      else { try { secretEntry.deletePassword(); } catch { /* already empty */ } }
      return next ?? current;
    });
  },
  delete(providerId) {
    return withCredentialLock(providerId, async () => {
    const all = JSON.parse(secretEntry.getPassword() ?? '{}') as Record<string, unknown>;
    delete all[providerId];
    if (Object.keys(all).length) secretEntry.setPassword(JSON.stringify(all));
    else { try { secretEntry.deletePassword(); } catch { /* already empty */ } }
    });
  },
};

export const models = createModels({ credentials: store });
models.setProvider(openaiProvider());

export type AuthPhase = 'idle' | 'starting' | 'waiting' | 'exchanging' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export type LoginPrompt = { id: string; type: AuthPrompt['type']; message: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] };
export type LoginSnapshot = { attemptId: string | null; phase: AuthPhase; authUrl?: string; instructions?: string; message?: string; error?: string; prompt?: LoginPrompt; expiresAt?: number };

let login: LoginSnapshot = { attemptId: null, phase: 'idle' };
let loginController: AbortController | undefined;
let loginTimeout: NodeJS.Timeout | undefined;
const pendingPrompts = new Map<string, { attemptId: string; resolve: (value: string) => void; reject: (reason: Error) => void; signal?: AbortSignal; onAbort?: () => void }>();

function getOrCreateDeviceId() {
  const existing = db.prepare("SELECT value FROM settings WHERE key='device_id'").get() as { value: string } | undefined;
  if (existing?.value) return existing.value;
  const value = randomUUID();
  db.prepare("INSERT INTO settings(key,value) VALUES('device_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
  return value;
}

function userFacingAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/device ID \(UUID\)/i.test(message)) return '无法读取本机授权标识。请重启应用后重试。';
  if (/port 1455 is in use|EADDRINUSE/i.test(message)) return '授权回调端口 1455 已被占用。请关闭其他 pi 或 ChatGPT 登录窗口后重试。';
  if (/fetch failed|network|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(message)) return '无法连接 ChatGPT 授权服务，请检查网络后重试。';
  if (/credential|keyring|keychain|secret service|permission denied|access is denied/i.test(message)) return '系统钥匙串未能保存授权信息。请检查 Windows 凭据管理器权限后重试。';
  if (/must start with http:\/\/127\.0\.0\.1:1455/i.test(message)) return '请粘贴浏览器地址栏中完整的回调链接。';
  return `ChatGPT 授权失败：${message}`;
}

function settleLogin(phase: Extract<AuthPhase, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>, message?: string, error?: string) {
  if (loginTimeout) clearTimeout(loginTimeout);
  loginTimeout = undefined;
  login = { ...login, phase, message, error, prompt: undefined };
  for (const [id, pending] of pendingPrompts) {
    if (pending.attemptId !== login.attemptId) continue;
    pending.signal?.removeEventListener('abort', pending.onAbort!);
    pendingPrompts.delete(id);
    pending.reject(new Error(phase === 'timed_out' ? '授权已超时' : phase === 'cancelled' ? '登录已取消' : '授权流程已结束'));
  }
}

export function getLoginSnapshot() { return login; }

export async function beginOpenAILogin() {
  if (loginController && ['starting', 'waiting', 'exchanging'].includes(login.phase)) return login;
  const attemptId = randomUUID();
  loginController = new AbortController();
  const controller = loginController;
  login = { attemptId, phase: 'starting', message: '正在启动 ChatGPT 授权…', expiresAt: Date.now() + 5 * 60_000 };
  loginTimeout = setTimeout(() => {
    if (login.attemptId !== attemptId || !['starting', 'waiting', 'exchanging'].includes(login.phase)) return;
    settleLogin('timed_out', '授权等待超过 5 分钟，请重试。');
    controller.abort();
  }, 5 * 60_000);

  void models.login('openai', 'oauth', {
    signal: controller.signal,
    prompt: async (prompt) => new Promise<string>((resolve, reject) => {
      if (controller.signal.aborted || prompt.signal?.aborted) {
        reject(new Error('登录已取消'));
        return;
      }
      const promptId = randomUUID();
      const onAbort = () => {
        pendingPrompts.delete(promptId);
        if (login.attemptId === attemptId && login.prompt?.id === promptId) login = { ...login, prompt: undefined };
        reject(new Error('登录已取消'));
      };
      pendingPrompts.set(promptId, { attemptId, resolve, reject, signal: prompt.signal, onAbort });
      prompt.signal?.addEventListener('abort', onAbort, { once: true });
      login = { ...login, phase: 'waiting', message: prompt.message, prompt: { id: promptId, type: prompt.type, message: prompt.message, ...('placeholder' in prompt ? { placeholder: prompt.placeholder } : {}), ...('options' in prompt ? { options: prompt.options } : {}) } };
    }),
    notify: (event) => {
      if (login.attemptId !== attemptId) return;
      if (event.type === 'auth_url') login = { ...login, phase: 'waiting', authUrl: event.url, instructions: event.instructions, message: '请在浏览器中完成 ChatGPT 登录。' };
      if (event.type === 'progress') login = { ...login, phase: 'exchanging', message: event.message };
      if (event.type === 'device_code') login = { ...login, phase: 'waiting', message: '请使用下方代码完成授权。' };
      if (event.type === 'info') login = { ...login, message: event.message };
    },
  }, { getDeviceId: getOrCreateDeviceId }).then(() => {
    if (login.attemptId === attemptId && !['cancelled', 'timed_out'].includes(login.phase)) settleLogin('succeeded', 'ChatGPT 授权成功，可以开始使用 AI。');
  }).catch((error: unknown) => {
    if (login.attemptId !== attemptId || ['cancelled', 'timed_out'].includes(login.phase)) return;
    settleLogin(controller.signal.aborted ? 'cancelled' : 'failed', undefined, userFacingAuthError(error));
  }).finally(() => {
    if (login.attemptId === attemptId) loginController = undefined;
  });
  return login;
}

export function answerAuthPrompt(attemptId: string, promptId: string, value: string) {
  const pending = pendingPrompts.get(promptId);
  if (!pending || pending.attemptId !== attemptId || login.attemptId !== attemptId || login.prompt?.id !== promptId) return false;
  pendingPrompts.delete(promptId);
  pending.signal?.removeEventListener('abort', pending.onAbort!);
  login = { ...login, prompt: undefined, phase: 'exchanging', message: '正在处理授权信息…' };
  pending.resolve(value);
  return true;
}

export function cancelOpenAILogin(attemptId: string) {
  if (login.attemptId !== attemptId || !loginController || !['starting', 'waiting', 'exchanging'].includes(login.phase)) return false;
  settleLogin('cancelled', '已取消授权。');
  loginController.abort();
  return true;
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
  return { configured, login, provider: 'openai', selectedModel: availableModels.some((model) => model.id === selected) ? selected : (availableModels[0]?.id ?? selected), models: availableModels };
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
