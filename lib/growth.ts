export type GrowthLevel = "goal" | "project" | "step";
export type GrowthStatus = "planned" | "ongoing" | "done";

export type GrowthRecord = {
  id: string; ownerId: string; title: string; level: GrowthLevel; category: string;
  status: GrowthStatus; parentId: string | null; notes: string; outcome: string;
  links: string[]; startText: string; dueDate: string; completedText: string;
  paused: boolean; archived: boolean; version: number; createdAt: string; updatedAt: string;
};

export type GrowthFields = Pick<GrowthRecord,
  "title" | "level" | "category" | "status" | "parentId" | "notes" | "outcome" |
  "links" | "startText" | "dueDate" | "completedText" | "paused" | "archived">;

export type DraftChange = {
  kind: "create" | "update" | "progress";
  clientKey?: string;
  recordId?: string;
  baseVersion?: number;
  fields?: Partial<GrowthFields>;
  progressText?: string;
  occurredText?: string;
};

export type GrowthDraft = {
  id: string; ownerId: string; source: "chatgpt" | "manual";
  sourceText: string; changes: DraftChange[]; questions: string[];
  status: "pending" | "applied" | "cancelled";
  revision: number; createdAt: string; updatedAt: string;
};

export type GrowthHistory = {
  id: string; ownerId: string; draftId: string; recordId: string;
  action: string; occurredText: string; beforeJson: string | null;
  afterJson: string; createdAt: string;
};

export const DEFAULT_CATEGORIES = ["课程", "技能", "科研", "竞赛", "实习", "其他"];

const clean = (value: unknown, limit: number) => String(value ?? "").trim().slice(0, limit);
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? value as T : fallback;

export function normalizeFields(raw: Partial<GrowthFields>, previous?: GrowthRecord): GrowthFields {
  const fields = { ...previous, ...raw };
  const links = Array.isArray(fields.links) ? fields.links.map((link) => clean(link, 500)).filter(Boolean).slice(0, 10) : [];
  for (const link of links) {
    let url: URL;
    try { url = new URL(link); } catch { throw new Error("链接需要完整的 http 或 https 地址"); }
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("链接只支持 http 或 https 地址");
  }
  const dueDate = clean(fields.dueDate, 10);
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error("截止日期格式应为 YYYY-MM-DD");
  if (dueDate && (!Number.isFinite(Date.parse(`${dueDate}T00:00:00Z`)) ||
    new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate)) throw new Error("截止日期无效");
  if (fields.level && !["goal", "project", "step"].includes(fields.level)) throw new Error("事项层级无效");
  if (fields.status && !["planned", "ongoing", "done"].includes(fields.status)) throw new Error("事项状态无效");
  const result: GrowthFields = {
    title: clean(fields.title, 120), category: clean(fields.category, 40),
    level: oneOf(fields.level, ["goal", "project", "step"], "step"),
    status: oneOf(fields.status, ["planned", "ongoing", "done"], "planned"),
    parentId: clean(fields.parentId, 100) || null,
    notes: clean(fields.notes, 3000), outcome: clean(fields.outcome, 1000), links,
    startText: clean(fields.startText, 100), dueDate, completedText: clean(fields.completedText, 100),
    paused: Boolean(fields.paused), archived: Boolean(fields.archived),
  };
  if (!result.title) throw new Error("请填写事项名称");
  if (!result.category) throw new Error("请填写类别");
  if (result.paused && result.status !== "ongoing") throw new Error("只有进行中事项可以暂停");
  if (result.level === "goal" && result.parentId) throw new Error("目标不能有上级事项");
  return result;
}

export function normalizeChanges(input: unknown): DraftChange[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error("每份草稿需要 1 至 20 项变更");
  return input.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("变更内容无效");
    const raw = item as Record<string, unknown>;
    if (!["create", "update", "progress"].includes(String(raw.kind))) throw new Error("变更类型无效");
    const kind = raw.kind as DraftChange["kind"];
    const recordId = clean(raw.recordId, 100) || undefined;
    if (kind !== "create" && (!recordId || !Number.isInteger(raw.baseVersion) || Number(raw.baseVersion) < 1))
      throw new Error("修改已有事项时需要事项 ID 和当前版本");
    const fields = raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields)
      ? raw.fields as Partial<GrowthFields> : {};
    if (kind === "create") normalizeFields(fields);
    const progressText = clean(raw.progressText, 2000);
    if (kind === "progress" && !progressText) throw new Error("请填写进展内容");
    return {
      kind, clientKey: clean(raw.clientKey, 80) || undefined, recordId,
      baseVersion: kind === "create" ? undefined : Number(raw.baseVersion),
      fields: kind === "progress" ? undefined : fields,
      progressText: progressText || undefined, occurredText: clean(raw.occurredText, 100) || undefined,
    };
  });
}

export function statusLabel(status: GrowthStatus) {
  return status === "done" ? "已完成" : status === "ongoing" ? "进行中" : "待进行";
}

export function levelLabel(level: GrowthLevel) {
  return level === "goal" ? "目标" : level === "project" ? "项目" : "步骤 / 事项";
}

export function dueLabel(record: GrowthRecord, today: string) {
  if (record.paused) return "已暂停";
  if (!record.dueDate) return "未设截止日期";
  const days = Math.round((Date.parse(`${record.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days === 0) return "今天到期";
  return days <= 7 ? `${days} 天后到期` : `${record.dueDate} 到期`;
}
