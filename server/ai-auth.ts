import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { AIError, checkedFetch, normalizeError, remoteError, type Diagnostic } from './ai-errors.js';
import type { Registration, Vault } from './ai-vault.js';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
export const APP_NAME = '昭濂个人成长平台';
const random = () => randomBytes(32).toString('base64url');
export type LoginSnapshot = { attemptId: string | null; phase: 'idle' | 'starting' | 'waiting' | 'exchanging' | 'saving' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'; authUrl?: string; message?: string; error?: string; diagnostic?: Diagnostic; expiresAt?: number };
type Pending = { id: string; state: string; nonce: string; verifier: string; redirect: string; selected?: Registration; clientId?: string; controller: AbortController; server: Server; timer?: NodeJS.Timeout };
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function assertScopes(scopes: string[]) {
  if (!scopes.includes(DIRECT_SCOPE) || !scopes.includes('resource.invoke')) throw remoteError('权限检查', 403, 'insufficient_scope');
}
export function parseCallback(url: URL, expectedState: string, registeredClientId?: string) {
  if (!same(url.searchParams.get('state') ?? '', expectedState)) throw new AIError('授权', 'state_mismatch', '授权回调校验失败。', '关闭此授权窗口，回到平台重新开始登录。');
  if (url.searchParams.has('error')) throw remoteError('授权', 400, url.searchParams.get('error'));
  const code = url.searchParams.get('code');
  const supplied = url.searchParams.get('client_id');
  if (registeredClientId && supplied && supplied !== registeredClientId) throw new AIError('授权', 'client_mismatch', '回调应用标识与本次注册不一致。');
  const clientId = registeredClientId ?? supplied;
  if (!code || !clientId || clientId === 'dynamic_agent_client') throw new AIError('授权', 'registration_incomplete', '未取得本应用的正式注册标识或授权码。');
  return { code, clientId };
}
export async function verifyIdentity(token: string, clientId: string, nonce: string, fetcher: typeof fetch = fetch) {
  try {
    const discovery = await (await checkedFetch('授权', `${ISSUER}/.well-known/openid-configuration`, {}, fetcher)).json() as { issuer: string; jwks_uri: string };
    if (discovery.issuer !== ISSUER || new URL(discovery.jwks_uri).origin !== ISSUER) throw new Error('Untrusted issuer');
    const jwks = await (await checkedFetch('授权', discovery.jwks_uri, {}, fetcher)).json() as JSONWebKeySet;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5 });
    if (typeof payload.nonce !== 'string' || !same(payload.nonce, nonce) || !payload.sub) throw new Error('Invalid nonce');
    return payload.sub;
  } catch (error) {
    if (error instanceof AIError) throw error;
    throw new AIError('授权', 'id_token_invalid', 'OpenAI 身份令牌验证失败。', '签名、签发者、受众、有效期或 nonce 不匹配；未保存此次凭据，请重新授权。');
  }
}
type Tokens = { access_token?: string; refresh_token?: string; id_token?: string; scope?: string; expires_in?: number; token_type?: string };
export function mergeTokens(previous: Registration, token: Tokens, first: boolean): Registration {
  if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in) || Number(token.expires_in) <= 0 || (first && (!token.id_token || typeof token.scope !== 'string')) || (token.token_type && token.token_type.toLowerCase() !== 'bearer')) throw new AIError('授权', 'invalid_token_response', '令牌响应缺少必要字段。');
  return { ...previous, accessToken: token.access_token, refreshToken: token.refresh_token, idToken: first ? token.id_token : previous.idToken, scopes: token.scope === undefined ? previous.scopes : token.scope.trim().split(/\s+/), expiresAt: Date.now() + Number(token.expires_in) * 1000, reauthRequired: false };
}
export class ChatGPTAuth {
  login: LoginSnapshot = { attemptId: null, phase: 'idle' };
  private pending?: Pending;
  constructor(public vault: Vault, private hostId: () => string, private eligible: () => boolean, private report: (d: Diagnostic) => void, private fetcher: typeof fetch = fetch, private verify = verifyIdentity) {}
  assertEligibility() { if (!this.eligible()) throw new AIError('权限检查', 'private_client_approval_required', '本私有项目的官方订阅接入资格尚未确认。', '官方当前仅向开源项目及获准私有客户端开放此流程。保持仓库私有，先取得 OpenAI 的批准；不要借用其他应用身份。'); }
  async status() { return this.vault.transact(async (data) => {
    const active = data.registrations.find(r => r.key === data.active);
    return { activeKey: data.active, configured: Boolean(active?.accessToken && !active.reauthRequired), scopes: active?.scopes ?? [], verified: active?.verified, accounts: data.registrations.map(r => ({ key: r.key, label: r.label, loggedIn: Boolean(r.accessToken && !r.reauthRequired) })) };
  }); }
  async begin(accountKey?: string, fresh = false, reconsent = false) {
    this.assertEligibility();
    if (this.pending || this.login.phase === 'starting') return this.login;
    this.login = { attemptId: randomUUID(), phase: 'starting', message: '正在启动本机授权回调…' };
    const attemptId = this.login.attemptId!;
    try {
      const selected = await this.vault.transact(async data => structuredClone(data.registrations.find(r => r.key === (accountKey ?? (fresh ? undefined : data.active)))));
      if (this.login.attemptId !== attemptId || this.login.phase === 'cancelled') return this.login;
      const server = createServer();
      const pending: Pending = { id: attemptId, state: random(), nonce: random(), verifier: random(), redirect: '', selected, controller: new AbortController(), server };
      this.pending = pending;
      server.on('request', (request, response) => {
        const callback = new URL(request.url ?? '/', pending.redirect);
        if (request.method !== 'GET' || callback.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
        try {
          if (this.pending !== pending || this.login.phase !== 'waiting') throw new AIError('授权', 'expired_callback', '该授权回调已过期。');
          const result = parseCallback(callback, pending.state, selected?.clientId);
          pending.clientId = result.clientId;
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'" }).end('<title>昭濂个人成长平台</title><h1>已收到授权信息</h1><p>请返回昭濂个人成长平台查看最终结果。浏览器回调不代表令牌和调用已验证。</p>');
          server.close();
          this.login = { ...this.login, authUrl: undefined, phase: 'exchanging', message: '正在换取令牌并验证身份…' };
          void this.exchange(pending, result.code, result.clientId).catch(error => this.fail(pending, error));
        } catch (error) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('授权未完成，请返回平台查看原因。');
          // A foreign state must not terminate a legitimate outstanding attempt.
          if (!(error instanceof AIError && error.diagnostic.code === 'state_mismatch')) this.fail(pending, error);
        }
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Callback not listening');
      pending.redirect = `http://127.0.0.1:${address.port}/auth/callback`;
      const url = new URL(`${ISSUER}/api/accounts/authorize`);
      url.search = new URLSearchParams({ client_id: selected?.clientId ?? 'dynamic_agent_client', ...(!selected ? { agent_name_hint: APP_NAME } : {}), ext_agent_host_id: this.hostId(), response_type: 'code', redirect_uri: pending.redirect, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE, state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(pending.verifier).digest('base64url') }).toString();
      if (reconsent) url.searchParams.set('prompt', 'consent');
      // Omit optional id_token_hint: tokens never pass through this app's browser UI.
      this.login = { attemptId, phase: 'waiting', authUrl: url.toString(), expiresAt: Date.now() + 300_000, message: '回调监听已就绪，请点击授权页面并自行登录。' };
      pending.timer = setTimeout(() => this.cancel(pending.id, true), 300_000);
    } catch (error) {
      if (this.pending) this.fail(this.pending, error);
      else { const failure = normalizeError(error, '授权'); this.report(failure.diagnostic); this.login = { attemptId, phase: 'failed', error: failure.message, diagnostic: failure.diagnostic }; }
    }
    return this.login;
  }
  private async exchange(pending: Pending, code: string, clientId: string) {
    let response: Response;
    try { response = await checkedFetch('授权', TOKEN_URL, { method: 'POST', signal: pending.controller.signal, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirect, resource: RESOURCE }) }, this.fetcher); }
    catch (error) {
      if (error instanceof AIError && error.diagnostic.code === 'invalid_grant' && !pending.selected && this.pending === pending) {
        await this.vault.transact(async (data, save) => {
          if (this.pending !== pending) return;
          const registration: Registration = { key: randomUUID(), clientId, label: `待重新授权的注册 ${new Date().toLocaleString('zh-CN')}`, scopes: [] };
          data.registrations.push(registration); data.active = registration.key; await save();
        });
      }
      throw error;
    }
    const token = await response.json() as Tokens;
    const abortableFetch: typeof fetch = (url, init) => this.fetcher(url, { ...init, signal: AbortSignal.any([pending.controller.signal, ...(init?.signal ? [init.signal] : [])]) });
    const subject = await this.verify(token.id_token ?? '', clientId, pending.nonce, abortableFetch);
    if (pending.selected?.subject && subject !== pending.selected.subject) throw new AIError('授权', 'account_mismatch', '登录账号与选定注册的身份不一致，原凭据未被替换。');
    const base: Registration = pending.selected ?? { key: randomUUID(), clientId, label: `ChatGPT 账号 ${new Date().toLocaleString('zh-CN')}`, scopes: [] };
    const next = mergeTokens({ ...base, subject, verified: undefined }, token, true);
    await this.vault.transact(async (data, save) => {
      if (this.pending !== pending || pending.controller.signal.aborted) throw new AIError('授权', 'cancelled', '授权已取消。');
      this.login = { ...this.login, phase: 'saving', message: '身份已验证，正在保存凭据和实际授权范围…' };
      const index = data.registrations.findIndex(r => r.key === next.key);
      if (index < 0) data.registrations.push(next); else data.registrations[index] = next;
      data.active = next.key; await save();
    });
    if (this.pending !== pending) return;
    this.cleanup(pending);
    let permission: Diagnostic | undefined;
    try { assertScopes(next.scopes); } catch (error) { permission = (error as AIError).diagnostic; this.report(permission); }
    this.login = { attemptId: pending.id, phase: 'succeeded', message: permission ? '已登录，但未授予订阅调用权限。' : '已登录且已授予订阅权限；请获取模型并主动测试调用。', diagnostic: permission };
  }
  private cleanup(pending: Pending) { clearTimeout(pending.timer); pending.server.close(); pending.server.closeAllConnections(); if (this.pending === pending) this.pending = undefined; }
  private fail(pending: Pending, error: unknown) {
    if (this.pending !== pending) return;
    const failure = normalizeError(error, '授权'); this.report(failure.diagnostic); this.cleanup(pending);
    this.login = { attemptId: pending.id, phase: failure.diagnostic.code === 'access_denied' ? 'cancelled' : 'failed', error: failure.message, diagnostic: failure.diagnostic };
  }
  cancel(attemptId: string, timedOut = false) {
    if (this.login.attemptId !== attemptId || !['starting', 'waiting', 'exchanging'].includes(this.login.phase)) return false;
    if (this.pending) { const pending = this.pending; pending.controller.abort(); this.cleanup(pending); }
    this.login = { attemptId, phase: timedOut ? 'timed_out' : 'cancelled', message: timedOut ? '授权等待已超时，请重试。' : '已取消授权。' }; return true;
  }
  async credential() {
    this.assertEligibility();
    return this.vault.transact(async (data, save) => {
      const index = data.registrations.findIndex(r => r.key === data.active);
      let record = data.registrations[index];
      if (!record?.accessToken || record.reauthRequired) throw remoteError('授权', 401, 'login_required');
      assertScopes(record.scopes);
      if ((record.expiresAt ?? 0) <= Date.now() + 60_000) {
        try {
          const response = await checkedFetch('授权', TOKEN_URL, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: record.clientId, refresh_token: record.refreshToken ?? '', resource: RESOURCE }) }, this.fetcher);
          record = mergeTokens(record, await response.json() as Tokens, false);
          data.registrations[index] = record; await save(); assertScopes(record.scopes);
        } catch (error) {
          if (error instanceof AIError && ['invalid_grant', 'invalid_token', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.diagnostic.code)) { record.reauthRequired = true; record.verified = undefined; record.accessToken = record.refreshToken = record.idToken = undefined; await save(); }
          throw error;
        }
      }
      return structuredClone(record);
    });
  }
  async markVerified(key: string, model: string) { await this.vault.transact(async (data, save) => { const record = data.registrations.find(r => r.key === key); if (record?.accessToken && !record.reauthRequired && data.active === key) { record.verified = { model, at: new Date().toISOString() }; await save(); } }); }
  async select(key: string) { if (this.pending) throw new AIError('授权', 'login_running', '请先完成或取消当前授权。'); await this.vault.transact(async (data, save) => { if (!data.registrations.some(r => r.key === key)) throw new AIError('授权', 'account_unknown', '找不到该注册。'); data.active = key; await save(); }); }
  async disconnect() {
    if (this.pending) this.cancel(this.pending.id);
    return this.vault.transact(async (data, save) => {
      const record = data.registrations.find(r => r.key === data.active);
      if (!record) return '已断开连接。';
      let revoked = !record.refreshToken;
      try {
        const discovery = await (await checkedFetch('授权', `${ISSUER}/.well-known/openid-configuration`, {}, this.fetcher)).json() as { revocation_endpoint: string };
        if (new URL(discovery.revocation_endpoint).origin !== ISSUER) throw new Error('Invalid revocation endpoint');
        if (record.refreshToken) {
          for (let attempt = 0; ; attempt++) {
            try { await checkedFetch('授权', discovery.revocation_endpoint, { method: 'POST', body: new URLSearchParams({ token: record.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }) }, this.fetcher); break; }
            catch (error) {
              if (!(error instanceof AIError) || attempt >= 1 || !((error.diagnostic.httpStatus ?? 0) >= 500 || ['network_error','timeout'].includes(error.diagnostic.code))) throw error;
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
        }
        revoked = true;
      } catch (error) { this.report(normalizeError(error, '授权').diagnostic); }
      record.accessToken = record.refreshToken = record.idToken = undefined; record.expiresAt = undefined; record.scopes = []; record.verified = undefined;
      await save();
      return revoked ? '已断开连接并撤销远程会话；保留本应用注册供重新登录。' : '已在本机断开，远程撤销未确认。请到 ChatGPT 设置中断开本应用。';
    });
  }
}
