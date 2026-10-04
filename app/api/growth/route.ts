import { getChatGPTUser } from "@/app/chatgpt-auth";
import { cancelDraft, commitDraft, GrowthError, issueBrowserToken, overview, saveDraft, verifyBrowserToken } from "@/db/growth-store";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
  if (error instanceof GrowthError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof Error && /请填写|无效|需要|格式|不支持|不能|重复|不存在/.test(error.message))
    return Response.json({ error: error.message }, { status: 400 });
  console.error("growth api error", error);
  return Response.json({ error: "操作失败，请稍后重试" }, { status: 500 });
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  try {
    const [data, browserToken] = await Promise.all([overview(user.userId), issueBrowserToken(user.userId)]);
    return Response.json({ ...data, browserToken, viewer: user.displayName }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) return Response.json({ error: "请求来源无效" }, { status: 403 });
  try {
    const token = request.headers.get("x-growth-token") ?? "";
    await verifyBrowserToken(user.userId, token);
    const input = await request.json() as Record<string, unknown>;
    if (input.action === "saveDraft") {
      const draft = await saveDraft({
        ownerId: user.userId, source: "manual", sourceText: String(input.sourceText ?? ""),
        changes: input.changes, questions: input.questions, id: typeof input.id === "string" ? input.id : undefined,
        expectedRevision: Number(input.expectedRevision),
      });
      return Response.json({ draft });
    }
    if (input.action === "cancelDraft") {
      await cancelDraft(user.userId, String(input.id), Number(input.revision));
      return Response.json({ ok: true });
    }
    if (input.action === "commitDraft") {
      const result = await commitDraft(user.userId, String(input.id), Number(input.revision), token);
      return Response.json({ ok: true, ...result });
    }
    return Response.json({ error: "未知操作" }, { status: 400 });
  } catch (error) { return failure(error); }
}
