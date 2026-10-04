import { env } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import { qwenTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn";
import { qwenTokenPlanIndividualProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-individual";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { verifyBrowserToken } from "@/db/growth-store";

export const dynamic = "force-dynamic";

const providers = [zaiProvider(), zaiCodingCnProvider(), qwenTokenPlanCnProvider(), qwenTokenPlanIndividualProvider(), kimiCodingProvider()];
const names: Record<string, string> = {
  zai: "智谱 GLM Coding Plan（国际）", "zai-coding-cn": "智谱 GLM Coding Plan（中国）",
  "qwen-token-plan-cn": "千问 Token Plan（中国）", "qwen-token-plan-individual": "千问 Token Plan（个人）",
  "kimi-coding": "Kimi For Coding",
};
const models = createModels();
providers.forEach((provider) => models.setProvider(provider));

type Connection = { provider_id: string; encrypted_token: string; selected_model: string; verified_at: string | null; is_default: number };
function database() {
  if (!env.DB) throw new Error("数据库暂时不可用");
  return env.DB;
}
function bytesToBase64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function base64ToBytes(value: string) { return Uint8Array.from(atob(value), (part) => part.charCodeAt(0)); }
async function encryptionKey() {
  if (!env.MODEL_CREDENTIAL_KEY) throw new Error("站点尚未配置模型凭据加密密钥");
  const raw = base64ToBytes(env.MODEL_CREDENTIAL_KEY);
  if (raw.length !== 32) throw new Error("模型凭据加密密钥格式无效");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(token: string, ownerId: string, providerId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(token);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${ownerId}:${providerId}`) }, await encryptionKey(), data);
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}
async function decrypt(value: string, ownerId: string, providerId: string) {
  const [version, iv, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("模型凭据格式无效");
  const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv), additionalData: new TextEncoder().encode(`${ownerId}:${providerId}`) }, await encryptionKey(), base64ToBytes(ciphertext));
  return new TextDecoder().decode(result);
}
function validModel(providerId: string, modelId: string) {
  if (!names[providerId] || !models.getModel(providerId, modelId)) throw new Error("请选择支持的订阅服务和模型");
}
async function getConnection(ownerId: string, providerId: string) {
  return database().prepare("SELECT * FROM model_connections WHERE owner_id=? AND provider_id=?").bind(ownerId, providerId).first<Connection>();
}
async function catalog(ownerId: string) {
  const rows = await database().prepare("SELECT provider_id, selected_model, verified_at, is_default FROM model_connections WHERE owner_id=? ORDER BY updated_at DESC").bind(ownerId).all<Connection>();
  const state = new Map(rows.results.map((row) => [row.provider_id, row]));
  return providers.map((provider) => ({
    id: provider.id, name: names[provider.id], models: models.getModels(provider.id).map((model) => ({ id: model.id, name: model.name })),
    connected: state.has(provider.id), verified: Boolean(state.get(provider.id)?.verified_at),
    selectedModel: state.get(provider.id)?.selected_model ?? "", isDefault: Boolean(state.get(provider.id)?.is_default),
  }));
}
async function invoke(providerId: string, modelId: string, token: string, prompt: string, instructions: string) {
  const model = models.getModel(providerId, modelId);
  if (!model) throw new Error("所选模型不存在");
  const response = await models.completeSimple(model, {
    systemPrompt: instructions,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, { apiKey: token, signal: AbortSignal.timeout(60000) });
  if (response.stopReason !== "stop") throw new Error("模型调用未完整成功，请检查订阅额度与令牌");
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
  if (!text) throw new Error("模型未返回文字内容");
  return text;
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  try { return Response.json({ providers: await catalog(user.userId) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { console.error("model catalog error", error); return Response.json({ error: "暂时无法读取模型配置" }, { status: 500 }); }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "请求来源无效" }, { status: 403 });
  try {
    await verifyBrowserToken(user.userId, request.headers.get("x-growth-token") ?? "");
    if (Number(request.headers.get("content-length") ?? 0) > 60000) throw new Error("输入过长");
    const body = await request.text();
    if (body.length > 60000) throw new Error("输入过长");
    const input = JSON.parse(body) as Record<string, unknown>;
    const action = String(input.action ?? "");
    const providerId = String(input.providerId ?? "");
    const modelId = String(input.modelId ?? "");
    if (!names[providerId]) throw new Error("不支持此订阅服务");
    if (action === "connect") {
      validModel(providerId, modelId);
      const token = String(input.token ?? "").trim();
      if (token.length < 8 || token.length > 8192) throw new Error("请填写有效的订阅服务令牌");
      const encrypted = await encrypt(token, user.userId, providerId);
      const now = new Date().toISOString();
      const existing = await database().prepare("SELECT COUNT(*) AS count FROM model_connections WHERE owner_id=? AND is_default=1").bind(user.userId).first<{ count: number }>();
      await database().prepare("INSERT INTO model_connections (owner_id,provider_id,encrypted_token,selected_model,verified_at,is_default,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_id,provider_id) DO UPDATE SET encrypted_token=excluded.encrypted_token,selected_model=excluded.selected_model,verified_at=NULL,updated_at=excluded.updated_at")
        .bind(user.userId, providerId, encrypted, modelId, null, existing?.count ? 0 : 1, now).run();
      return Response.json({ providers: await catalog(user.userId) });
    }
    const connection = await getConnection(user.userId, providerId);
    if (!connection) throw new Error("请先连接此订阅服务");
    if (action === "disconnect") {
      await database().prepare("DELETE FROM model_connections WHERE owner_id=? AND provider_id=?").bind(user.userId, providerId).run();
      return Response.json({ providers: await catalog(user.userId) });
    }
    if (action === "select") {
      validModel(providerId, modelId);
      const now = new Date().toISOString();
      await database().batch([
        database().prepare("UPDATE model_connections SET is_default=0 WHERE owner_id=?").bind(user.userId),
        database().prepare("UPDATE model_connections SET selected_model=?,verified_at=CASE WHEN selected_model=? THEN verified_at ELSE NULL END,is_default=1,updated_at=? WHERE owner_id=? AND provider_id=?").bind(modelId, modelId, now, user.userId, providerId),
      ]);
      return Response.json({ providers: await catalog(user.userId) });
    }
    if (action === "test") {
      const token = await decrypt(connection.encrypted_token, user.userId, providerId);
      await invoke(providerId, connection.selected_model, token, "请只回复：连接成功", "这是一次连接测试。请简短回答。");
      await database().prepare("UPDATE model_connections SET verified_at=? WHERE owner_id=? AND provider_id=? AND encrypted_token=? AND selected_model=?")
        .bind(new Date().toISOString(), user.userId, providerId, connection.encrypted_token, connection.selected_model).run();
      return Response.json({ providers: await catalog(user.userId) });
    }
    if (action === "generate") {
      if (!connection.verified_at || !connection.is_default) throw new Error("请先测试并选用当前模型");
      const prompt = String(input.prompt ?? ""), instructions = String(input.instructions ?? "");
      if (!prompt.trim() || prompt.length > 45000 || instructions.length > 10000) throw new Error("输入过长或为空");
      const token = await decrypt(connection.encrypted_token, user.userId, providerId);
      const text = await invoke(providerId, connection.selected_model, token, prompt, instructions);
      return Response.json({ text });
    }
    throw new Error("未知操作");
  } catch (error) {
    if (error instanceof Error && /请选择|不支持|请先|输入过长|未知操作|凭据.*密钥/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
    console.error("model request failed", error instanceof Error ? error.name : "unknown");
    return Response.json({ error: "模型请求失败。请检查订阅令牌、模型权限或剩余额度，并重新测试。" }, { status: 502 });
  }
}
