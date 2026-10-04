import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDraft, GrowthError, listRecords, saveDraft } from "@/db/growth-store";

export const dynamic = "force-dynamic";

const tools = [
  {
    name: "search_records", description: "先查询个人成长事项，再决定是新增、补充进展还是更新已有事项。返回稳定 ID 和版本。对不确定的归属、日期或完成状态，应先追问用户。",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "标题、笔记、成果或类别关键词，可为空" },
      status: { type: "string", enum: ["planned", "ongoing", "done"] },
      category: { type: "string" },
    } },
  },
  {
    name: "get_draft", description: "读取一份待确认的更新草稿，查看内容、修订号和未解决问题。",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
  },
  {
    name: "save_draft", description: "仅保存待网页核对的草稿，不修改正式成长记录。保留用户原话；每项变更是 create、update 或 progress。更新已有事项须使用 search_records 返回的 recordId 和 baseVersion。若用户意思不明确，先追问；仍有疑问时填入 questions。保存后请给用户预览链接，正式生效必须由用户在网页确认。",
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: { type: "object", required: ["sourceText", "changes"], properties: {
      sourceText: { type: "string", description: "用户关于过去、当前或未来事项的原始叙述" },
      changes: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", required: ["kind"], properties: {
        kind: { type: "string", enum: ["create", "update", "progress"] },
        clientKey: { type: "string", description: "同一草稿新事项的临时编号；parentId 可写 temp:编号" },
        recordId: { type: "string" }, baseVersion: { type: "integer" },
        fields: { type: "object", description: "可含 title、level(goal/project/step)、category、status(planned/ongoing/done)、parentId、notes、outcome、links(数组)、startText、dueDate(精确日期)、completedText、paused、archived；不要编造未知日期" },
        progressText: { type: "string" }, occurredText: { type: "string", description: "事情发生的日期，可为模糊文字，如2025年春" },
      } } },
      questions: { type: "array", items: { type: "string" } },
      draftId: { type: "string" }, expectedRevision: { type: "integer" },
    } },
  },
];

function rpc(id: unknown, result: unknown) { return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "Cache-Control": "no-store" } }); }
function rpcError(id: unknown, code: number, message: string) { return Response.json({ jsonrpc: "2.0", id, error: { code, message } }); }
function toolText(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return rpcError(null, -32700, "Invalid JSON"); }
  const id = body.id ?? null;
  const params = body.params && typeof body.params === "object" ? body.params as Record<string, unknown> : {};
  try {
    if (body.method === "initialize") return rpc(id, {
      protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "personal-growth-platform", version: "1.0.0" },
    });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "ping") return rpc(id, {});
    if (body.method === "tools/list") return rpc(id, { tools });
    if (body.method !== "tools/call") return rpcError(id, -32601, "Method not found");
    const name = String(params.name ?? "");
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    if (name === "search_records") {
      const query = String(args.query ?? "").trim().toLocaleLowerCase();
      const records = (await listRecords(user.userId)).filter((record) =>
        (!query || [record.title, record.category, record.notes, record.outcome].some((part) => part.toLocaleLowerCase().includes(query))) &&
        (!args.status || record.status === args.status) && (!args.category || record.category === args.category));
      return rpc(id, toolText({ records: records.slice(0, 100), total: records.length }));
    }
    if (name === "get_draft") {
      const draft = await getDraft(user.userId, String(args.draftId ?? ""));
      if (!draft) throw new GrowthError("草稿不存在", 404);
      return rpc(id, toolText({ draft }));
    }
    if (name === "save_draft") {
      const draft = await saveDraft({
        ownerId: user.userId, source: "chatgpt", sourceText: String(args.sourceText ?? ""),
        changes: args.changes, questions: args.questions,
        id: typeof args.draftId === "string" ? args.draftId : undefined,
        expectedRevision: Number(args.expectedRevision),
      });
      return rpc(id, toolText({ draftId: draft.id, revision: draft.revision, questions: draft.questions,
        previewUrl: new URL(`/?draft=${encodeURIComponent(draft.id)}`, request.url).toString(),
        message: "草稿已保存。请在网页检查并确认后才会更新正式记录。" }));
    }
    return rpcError(id, -32602, "Unknown tool");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool failed";
    return rpc(id, { content: [{ type: "text", text: message }], isError: true });
  }
}
