import { requireChatGPTUser } from "./chatgpt-auth";
import GrowthWorkspace from "./growth-workspace";

export const dynamic = "force-dynamic";

export default function Home({ searchParams }: { searchParams: Promise<{ draft?: string }> }) {
  return <ProtectedWorkspace searchParams={searchParams} />;
}

async function ProtectedWorkspace({ searchParams }: { searchParams: Promise<{ draft?: string }> }) {
  const { draft } = await searchParams;
  await requireChatGPTUser(draft ? `/?draft=${encodeURIComponent(draft)}` : "/");
  return <GrowthWorkspace />;
}
