import { requireChatGPTUser } from "./chatgpt-auth";
import GrowthWorkspace from "./growth-workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requireChatGPTUser("/");
  return <GrowthWorkspace />;
}
