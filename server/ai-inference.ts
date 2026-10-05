import { AIError, checkedFetch, normalizeError, remoteError } from './ai-errors.js';
import { RESOURCE, type ChatGPTAuth } from './ai-auth.js';
export type ModelChoice = { id: string; name: string };
export function parseModels(value: unknown): ModelChoice[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { models?: unknown }).models)) throw new AIError('模型列表', 'invalid_catalog', '模型列表不是此订阅流程要求的 models 数组。');
  const models = (value as { models: unknown[] }).models.filter((item): item is { slug: string; display_name: string; visibility: string } => Boolean(item && typeof item === 'object' && (item as { visibility?: string }).visibility === 'list' && typeof (item as { slug?: string }).slug === 'string' && typeof (item as { display_name?: string }).display_name === 'string'));
  if (!models.length) throw new AIError('模型列表', 'no_models', '当前账号没有可展示的可用模型。', '检查账号、工作区政策和实际授权范围。');
  return models.map(m => ({ id: m.slug, name: m.display_name }));
}
// HTTP 200, a text delta or [DONE] alone is insufficient.
export async function readResponseStream(response: Response) {
  const requestId = response.headers.get('x-request-id') ?? undefined;
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new AIError('结果解析', 'invalid_stream', '服务端未返回预期的事件流。', undefined, response.status, requestId);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', completed = false, totalBytes = 0;
  const consume = (frame: string) => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event: { type: string; delta?: string; error?: { code?: string }; code?: string; response?: { status?: string; error?: { code?: string }; output?: { content?: { type?: string; text?: string }[] }[] } };
    try { event = JSON.parse(data); } catch { throw new AIError('结果解析', 'invalid_event', '模型事件不是合法 JSON。', undefined, response.status, requestId); }
    if (event.type === 'response.failed' || event.type === 'error') throw remoteError('推理请求', response.status, event.response?.error?.code ?? event.error?.code ?? event.code, requestId);
    if (event.type === 'response.incomplete') throw new AIError('结果解析', 'response_incomplete', '模型结果未完成，未进入业务保存。', '缩短输入或换一个账号可用模型后重试。', response.status, requestId);
    if (event.type === 'response.output_text.delta') text += event.delta ?? '';
    if (event.type === 'response.completed') {
      if (event.response?.status !== 'completed') throw new AIError('结果解析', 'invalid_completion', '完成事件与结果状态不一致。');
      const finalText = event.response.output?.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text ?? '').join('\n');
      if (finalText) text = finalText;
      completed = true;
    }
  };
  try {
    while (!completed) {
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new AIError('结果解析', 'stream_timeout', '模型流等待超时。')); }, 30_000); })]).finally(() => clearTimeout(timer));
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > 4_000_000) throw new AIError('结果解析', 'response_too_large', '模型响应超出本平台文本大小限制。');
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
    }
    if (!completed) throw new AIError('结果解析', 'stream_interrupted', '模型流中断，未收到 response.completed。', '已收到的部分文字不会作为有效建议或保存记录。', response.status, requestId);
    if (!text.trim()) throw new AIError('结果解析', 'empty_response', '模型已结束但没有返回文本。', '本次测试只支持文本，请选择支持文本的模型。', response.status, requestId);
    return { text, requestId };
  } catch (error) { throw normalizeError(error, '结果解析'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class ChatGPTInference {
  private catalog?: { key: string; at: number; models: ModelChoice[] };
  constructor(private auth: ChatGPTAuth, private fetcher: typeof fetch = fetch) {}
  clear() { this.catalog = undefined; }
  cached(key?: string) { return this.catalog?.key === key ? this.catalog?.models ?? [] : []; }
  async models() {
    const record = await this.auth.credential();
    const response = await checkedFetch('模型列表', `${RESOURCE}/models`, { headers: { Authorization: `Bearer ${record.accessToken}` } }, this.fetcher);
    let json: unknown;
    try { json = await response.json(); } catch { throw new AIError('模型列表', 'invalid_catalog', '无法解析账号模型列表。'); }
    const models = parseModels(json); this.catalog = { key: record.key, at: Date.now(), models }; return models;
  }
  async text(model: string, instructions: string, input: string) {
    const record = await this.auth.credential();
    if (!this.catalog || this.catalog.key !== record.key || Date.now() - this.catalog.at > 300_000) await this.models();
    if (!this.cached(record.key).some(m => m.id === model)) throw new AIError('模型列表', 'model_not_available', '所选模型不在当前账号可用列表中。', '刷新模型列表并重新选择。');
    const response = await checkedFetch('推理请求', `${RESOURCE}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${record.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, instructions, input: [{ role: 'user', content: input }], store: false, stream: true }), signal: AbortSignal.timeout(120_000) }, this.fetcher);
    const result = await readResponseStream(response);
    return { ...result, accountKey: record.key };
  }
}
