import { createServer } from "node:http";
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.GROWTH_COMPANION_PORT || 41739);
const SITE_ORIGIN = process.env.GROWTH_SITE_ORIGIN;
const OPENAI_ISSUER = "https://auth.openai.com";
const OAUTH_AUTH = `${OPENAI_ISSUER}/api/accounts/authorize`;
const OAUTH_TOKEN = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
const API_ROOT = "https://api.openai.com/v1";
const REDIRECT_URI = `http://${HOST}:${PORT}/auth/callback`;
const APP_NAME = "Personal Growth Companion";
const DATA_DIR = path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "PersonalGrowthAssistant");
const CREDENTIAL_FILE = path.join(DATA_DIR, "credential.dpapi");
const PAIR_FILE = path.join(DATA_DIR, "paired-sites.json");
const HOST_FILE = path.join(DATA_DIR, "host-id");
const pairCode = randomBytes(5).toString("hex").toUpperCase();
const transactions = new Map();
let jwksCache;
let refreshPromise;
let pairFailures = 0;

if (process.platform !== "win32") throw new Error("此版本辅助服务使用 Windows DPAPI 加密凭据。");
if (!SITE_ORIGIN || !/^https:\/\//.test(SITE_ORIGIN)) throw new Error("请通过 GROWTH_SITE_ORIGIN 设置平台的 HTTPS 地址。");
try {
  const configuredOrigin = new URL(SITE_ORIGIN);
  if (configuredOrigin.protocol !== "https:" || configuredOrigin.origin !== SITE_ORIGIN || configuredOrigin.username || configuredOrigin.password)
    throw new Error("请将 GROWTH_SITE_ORIGIN 设置为不带路径的 HTTPS 网站源地址。");
} catch (error) {
  if (error instanceof Error && error.message.includes("GROWTH_SITE_ORIGIN")) throw error;
  throw new Error("GROWTH_SITE_ORIGIN 不是有效的 HTTPS 网站源地址。");
}
await mkdir(DATA_DIR, { recursive: true });
let hostId;
try { hostId = (await readFile(HOST_FILE, "utf8")).trim(); }
catch { hostId = randomUUID(); await writeFile(HOST_FILE, hostId, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async () => { hostId = (await readFile(HOST_FILE, "utf8")).trim(); }); }

const base64url = (buffer) => Buffer.from(buffer).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const safeEqual = (left, right) => {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function protect(value) {
  const script = "$ErrorActionPreference='Stop'; $raw=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $raw -AsPlainText -Force; ConvertFrom-SecureString -SecureString $secure";
  return runPowerShell(script, value);
}

async function unprotect(value) {
  const script = "$ErrorActionPreference='Stop'; $cipher=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $cipher; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }";
  return runPowerShell(script, value);
}

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 1_000_000) child.kill(); });
    child.once("error", () => reject(new Error("无法启动 Windows 凭据保护服务")));
    child.once("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error("Windows 凭据加密或解密失败")));
    child.stdin.end(input);
  });
}

async function writeSecret(value) {
  await mkdir(DATA_DIR, { recursive: true });
  const encrypted = await protect(JSON.stringify(value));
  const temp = `${CREDENTIAL_FILE}.${process.pid}.tmp`;
  await writeFile(temp, encrypted, { encoding: "utf8", mode: 0o600, flag: "w" });
  await rename(temp, CREDENTIAL_FILE);
}

async function readSecret() {
  try { return JSON.parse(await unprotect(await readFile(CREDENTIAL_FILE, "utf8"))); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("本机订阅凭据无法解密，请重新连接 ChatGPT。");
  }
}

async function readPairHashes() {
  try { return JSON.parse(await readFile(PAIR_FILE, "utf8")); } catch { return []; }
}

async function savePairHashes(values) {
  await mkdir(DATA_DIR, { recursive: true });
  const temp = `${PAIR_FILE}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(values), { encoding: "utf8", mode: 0o600, flag: "w" });
  await rename(temp, PAIR_FILE);
}

function cors(request, response) {
  const origin = request.headers.origin;
  if (!origin || origin !== SITE_ORIGIN) return false;
  response.setHeader("Access-Control-Allow-Origin", SITE_ORIGIN);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Growth-Companion");
  if (request.headers["access-control-request-private-network"] === "true")
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  response.setHeader("Access-Control-Max-Age", "600");
  return true;
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("请求内容过大");
  }
  return raw ? JSON.parse(raw) : {};
}

async function validateIdentity(token, nonce, clientId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("ChatGPT 身份令牌格式无效");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "RS256" || !header.kid) throw new Error("身份令牌签名算法无效");
  if (!jwksCache || jwksCache.expiresAt < Date.now()) {
    const response = await fetch(`${OPENAI_ISSUER}/.well-known/jwks.json`);
    if (!response.ok) throw new Error("无法验证 ChatGPT 身份");
    jwksCache = { data: await response.json(), expiresAt: Date.now() + 10 * 60_000 };
  }
  const jwk = jwksCache.data.keys.find((key) => key.kid === header.kid && key.use === "sig");
  if (!jwk) throw new Error("找不到用于验证 ChatGPT 身份的签名密钥");
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  const signatureOk = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
  const audienceMatches = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
  if (!signatureOk || claims.iss !== OPENAI_ISSUER || !audienceMatches || !claims.sub || Number(claims.exp) <= Date.now() / 1000 || claims.nonce !== nonce)
    throw new Error("ChatGPT 身份或授权校验失败");
  return claims;
}

function beginAuthorization(existing = null) {
  const verifier = base64url(randomBytes(48));
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const transaction = { verifier, state, nonce, createdAt: Date.now(), clientId: existing?.client_id || "dynamic_agent_client",
    expectedSubject: existing?.subject || null, newRegistration: !existing };
  transactions.set(state, transaction);
  for (const [key, value] of transactions) if (Date.now() - value.createdAt > 10 * 60_000) transactions.delete(key);
  const params = new URLSearchParams({
    client_id: transaction.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: API_ROOT,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
    ext_agent_host_id: `urn:uuid:${hostId}`,
  });
  if (existing) {
    if (existing.id_token) params.set("id_token_hint", existing.id_token);
    if (existing.email) params.set("login_hint", existing.email);
    params.set("prompt", "consent");
  } else params.set("agent_name_hint", APP_NAME);
  return `${OAUTH_AUTH}?${params.toString()}`;
}

async function exchangeToken(form) {
  const response = await fetch(OAUTH_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("ChatGPT 授权未完成，请返回页面重试。");
  return result;
}

async function ensureFreshCredential() {
  const credential = await readSecret();
  if (!credential) throw new Error("尚未连接 ChatGPT Plus");
  if (Number(credential.expires_at) > Date.now() + 90_000) return credential;
  if (!refreshPromise) refreshPromise = (async () => {
    const current = await readSecret();
    const token = await exchangeToken(new URLSearchParams({ grant_type: "refresh_token", client_id: current.client_id,
      refresh_token: current.refresh_token, resource: API_ROOT }));
  const updated = { ...current, access_token: token.access_token, refresh_token: token.refresh_token || current.refresh_token,
      id_token: token.id_token || current.id_token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
      scopes: String(token.scope || current.scopes.join(" ")).split(/\s+/).filter(Boolean) };
    if (!updated.scopes.includes("chatgpt.tokens.use.direct") || !updated.scopes.includes("resource.invoke")) throw new Error("此 ChatGPT 授权未包含订阅推理权限，请重新同意完整权限。");
    await writeSecret(updated);
    return updated;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function openAiFetch(route, credential, init = {}) {
  return fetch(`${API_ROOT}${route}`, { ...init, headers: { Authorization: `Bearer ${credential.access_token}`, Accept: "application/json", ...(init.headers || {}) } });
}

async function getModels() {
  const credential = await ensureFreshCredential();
  let response = await openAiFetch("/models", credential);
  if (response.status === 401) response = await openAiFetch("/models", await ensureFreshCredential());
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || "无法读取此账号可用的模型");
  const models = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
  return models.filter((item) => item.visibility === "list" || !item.visibility)
    .map((item) => ({ slug: String(item.slug || item.id), name: String(item.display_name || item.name || item.slug || item.id) }))
    .filter((item) => item.slug && item.slug !== "undefined");
}

async function generate(input) {
  const prompt = String(input.prompt || "").trim();
  const model = String(input.model || "").trim();
  if (!prompt || prompt.length > 30_000) throw new Error("请输入不超过 30000 字符的内容");
  if (!model || model.length > 120) throw new Error("请选择此账号支持的模型");
  const models = await getModels();
  if (!models.some((item) => item.slug === model)) throw new Error("所选模型不在此账号的可用列表中，请刷新模型列表");
  const credential = await ensureFreshCredential();
  const request = { model, instructions: String(input.instructions || "").slice(0, 8000),
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }], store: false, stream: true };
  let response = await openAiFetch("/responses", credential, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  if (response.status === 401) response = await openAiFetch("/responses", await ensureFreshCredential(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = body?.error?.code;
    if (code === "subscription_sharing_usage_limit_exceeded") throw new Error("Plus 订阅的 AI 使用限额已到，请稍后再试或查看 ChatGPT 设置中的用量。");
    if (code === "subscription_sharing_user_not_eligible") throw new Error("此账号、工作区或地区当前没有开通订阅推理权限。");
    throw new Error(body?.error?.message || body?.detail || "模型请求失败，请检查 ChatGPT 连接后重试");
  }
  let buffer = "", output = "", completed = false, failure = null;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型没有返回可读取的响应流");
  const decoder = new TextDecoder();
  const consume = (line) => {
    if (!line.startsWith("data: ")) return;
    let event;
    try { event = JSON.parse(line.slice(6)); } catch { return; }
    if (event.type === "response.output_text.delta") {
      output += String(event.delta || "");
      if (output.length > 200_000) failure = "AI 返回内容过长，请缩小整理范围后重试。";
    }
    if (event.type === "response.failed") {
      const code = event.response?.error?.code;
      failure = code === "subscription_sharing_usage_limit_exceeded" || code === "subscription_sharing_usage_unavailable"
        ? "ChatGPT 订阅额度暂时不可用，请稍后重试或查看账号用量设置。"
        : event.response?.error?.message || "模型响应失败";
    }
    if (event.type === "response.incomplete") failure = event.response?.incomplete_details?.reason || "模型响应未完整结束，请重试。";
    if (event.type === "response.completed") completed = true;
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) consume(line);
    if (failure) { await reader.cancel().catch(() => {}); break; }
    if (done) break;
  }
  for (const line of buffer.split("\n")) consume(line);
  if (failure) throw new Error(failure);
  if (!completed) throw new Error("模型响应中断，没有完成本次生成；请重试。");
  return output;
}

const page = (connected, email = "", authorization = "") => {
  const notice = authorization === "declined" ? "你尚未授权 ChatGPT 订阅使用权限。AI 整理仍不可用，可以重新开始授权。"
    : authorization === "failed" ? "授权未完成，请重新开始。" : "";
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>成长平台 AI 助手</title><style>body{font:16px system-ui,'Microsoft YaHei',sans-serif;background:#080d16;color:#e7efff;margin:0;padding:32px}.box{max-width:680px;margin:5vh auto;padding:32px;background:#121b2a;border:1px solid #263750;border-radius:18px}h1{margin-top:0}p{line-height:1.7;color:#b2bfd5}.code{font:700 22px ui-monospace,monospace;letter-spacing:.14em;color:#74a8ff;background:#0a111d;padding:12px 16px;border-radius:10px;display:inline-block}.button{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:700;padding:12px 16px;border-radius:10px;margin:8px 8px 0 0}.muted{font-size:13px;color:#8b9ab3}.notice{color:#f6cb80!important}</style><main class="box"><h1>个人成长平台 · 本机 AI 助手</h1><p>${connected ? `已连接 ChatGPT：${escapeHtml(email)}` : "尚未连接 ChatGPT Plus。授权后，本机服务会通过官方订阅授权发送 AI 请求。"}</p>${notice ? `<p class="notice">${notice}</p>` : ""}<p>首次配对验证码（仅显示在本机）：</p><div class="code">${pairCode}</div><p>在成长平台打开 AI 整理，首次使用时输入此验证码。配对后验证码不再需要。</p><a class="button" href="/auth/start">${connected ? "重新连接 ChatGPT" : "Continue with ChatGPT"}</a><a class="button" href="${escapeHtml(SITE_ORIGIN)}">打开成长平台</a><p class="muted">授权凭据只保存在当前 Windows 用户的 DPAPI 加密存储中。请仅在自己的电脑上使用。</p></main></html>`;
};
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
    if (request.method === "OPTIONS") {
      if (!cors(request, response)) return json(response, 403, { error: "来源未获授权" });
      response.writeHead(204); return response.end();
    }
    const isLocalPage = url.pathname === "/" || url.pathname.startsWith("/auth/");
    if (!isLocalPage && !cors(request, response)) return json(response, 403, { error: "来源未获授权" });
    if (url.pathname === "/" && request.method === "GET") {
      const credential = await readSecret(); response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
      return response.end(page(Boolean(credential), credential?.email || "", url.searchParams.get("authorization") || ""));
    }
    if (url.pathname === "/auth/start" && request.method === "GET") {
      const fetchSite = request.headers["sec-fetch-site"];
      const referer = request.headers.referer || "";
      if ((fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") ||
          (referer && !referer.startsWith(`http://${HOST}:${PORT}/`))) return json(response, 403, { error: "请从本机助手页面启动 ChatGPT 授权" });
      const credential = await readSecret(); response.writeHead(302, { Location: beginAuthorization(credential) }); return response.end();
    }
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const state = url.searchParams.get("state"), transaction = transactions.get(state);
      if (!transaction || Date.now() - transaction.createdAt > 10 * 60_000) throw new Error("授权已过期，请重新连接");
      transactions.delete(state);
      if (url.searchParams.get("error")) {
        const declined = url.searchParams.get("error") === "access_denied";
        response.writeHead(302, { Location: declined ? "/?authorization=declined" : "/?authorization=failed" }); return response.end();
      }
      const callbackClientId = url.searchParams.get("client_id");
      if (transaction.newRegistration && (!callbackClientId || callbackClientId === "dynamic_agent_client"))
        throw new Error("ChatGPT 没有返回正式 client_id，注册尚未完成；请重新授权。");
      const issuedClientId = callbackClientId || transaction.clientId;
      if (issuedClientId !== transaction.clientId && !transaction.newRegistration) throw new Error("ChatGPT 返回了不同的授权客户端");
      const code = url.searchParams.get("code"); if (!code) throw new Error("ChatGPT 没有返回授权码");
      const token = await exchangeToken(new URLSearchParams({ grant_type: "authorization_code", client_id: issuedClientId,
        code, code_verifier: transaction.verifier, redirect_uri: REDIRECT_URI, resource: API_ROOT }));
      const scopes = String(token.scope || "").split(/\s+/).filter(Boolean);
      if (!scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke"))
        throw new Error("授权没有包含 ChatGPT 订阅推理权限。请重新点击授权并同意完整权限。");
      const claims = await validateIdentity(String(token.id_token || ""), transaction.nonce, issuedClientId);
      if (transaction.expectedSubject && claims.sub !== transaction.expectedSubject) throw new Error("本次授权返回了不同的 ChatGPT 账号，已保留原凭据；请重新选择原账号。");
      if (!token.access_token || !token.refresh_token) throw new Error("ChatGPT 授权响应缺少订阅调用或续期凭据。");
      await writeSecret({ client_id: issuedClientId, subject: claims.sub, email: String(claims.email || ""), id_token: token.id_token,
        access_token: token.access_token, refresh_token: token.refresh_token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
        scopes, token_type: token.token_type || "Bearer" });
      response.writeHead(302, { Location: "/" }); return response.end();
    }
    if (url.pathname === "/health" && request.method === "GET") {
      const credential = await readSecret(); return json(response, 200, { connected: Boolean(credential), email: credential?.email || "", pairRequired: true });
    }
    const incomingToken = String(request.headers["x-growth-companion"] || "");
    if (url.pathname === "/pair" && request.method === "POST") {
      const input = await bodyJson(request);
      if (pairFailures >= 10) return json(response, 429, { error: "配对失败次数过多，请重新启动本机助手" });
      if (!safeEqual(String(input.code || "").toUpperCase(), pairCode)) { pairFailures++; return json(response, 403, { error: "配对验证码不正确" }); }
      pairFailures = 0;
      const token = base64url(randomBytes(32));
      const hashes = await readPairHashes(); hashes.push(digest(token)); await savePairHashes(hashes.slice(-10));
      return json(response, 200, { token });
    }
    const hashes = await readPairHashes();
    if (!hashes.some((hash) => safeEqual(String(hash), digest(incomingToken)))) return json(response, 401, { error: "请先在本机助手页面获取验证码并配对" });
    if (url.pathname === "/health" && request.method === "POST") {
      const credential = await readSecret(); return json(response, 200, { connected: Boolean(credential), email: credential?.email || "" });
    }
    if (url.pathname === "/models" && request.method === "GET") return json(response, 200, { models: await getModels() });
    if (url.pathname === "/generate" && request.method === "POST") return json(response, 200, { text: await generate(await bodyJson(request)) });
    if (url.pathname === "/unlink" && request.method === "POST") {
      await unlink(CREDENTIAL_FILE).catch(() => {});
      return json(response, 200, { ok: true });
    }
    return json(response, 404, { error: "接口不存在" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "本机助手发生错误";
    if (!response.headersSent) return json(response, /尚未连接|未包含|限额|资格|模型|响应|身份|授权|验证码|请求内容/.test(message) ? 400 : 500, { error: message });
    response.end();
  }
});

server.listen(PORT, HOST, () => console.log(`Personal Growth Companion listening at http://${HOST}:${PORT}`));
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
