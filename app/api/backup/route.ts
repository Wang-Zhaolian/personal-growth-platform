import { getChatGPTUser } from "@/app/chatgpt-auth";
import { exportData, GrowthError, restoreData, verifyBrowserToken } from "@/db/growth-store";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  try {
    const data = await exportData(user.userId);
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="growth-backup-${new Date().toISOString().slice(0, 10)}.json"` },
    });
  } catch (error) {
    console.error("backup export", error);
    return Response.json({ error: "导出失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return Response.json({ error: "请求来源无效" }, { status: 403 });
  try {
    await verifyBrowserToken(user.userId, request.headers.get("x-growth-token") ?? "");
    const raw = await request.text();
    if (raw.length > 20_000_000) throw new GrowthError("备份文件过大");
    return Response.json({ ok: true, result: await restoreData(user.userId, JSON.parse(raw)) });
  } catch (error) {
    if (error instanceof GrowthError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "恢复失败，请检查备份文件" }, { status: 400 });
  }
}
