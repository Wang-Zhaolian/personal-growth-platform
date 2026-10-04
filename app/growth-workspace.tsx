"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, CalendarCheck, Check, CheckCircle2, Clock3, Download, ExternalLink, FolderTree, History, Plus, Search, Sparkles, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { DEFAULT_CATEGORIES, dueLabel, levelLabel, statusLabel, type DraftChange, type GrowthDraft, type GrowthFields, type GrowthHistory, type GrowthRecord, type GrowthStatus } from "@/lib/growth";

type View = "daily" | GrowthStatus;
type Plan = { id: string; date: string; availableMinutes: number; focus: string; status: string; revision: number };
type Task = { id: string; planId: string; title: string; kind: "project" | "habit"; recordId: string | null; habitId: string | null; unit: string; targetAmount: number; completedAmount: number; estimatedMinutes: number; reason: string; carryoverKey: string; sourceTaskId: string | null; position: number; status: string; revision: number };
type Candidate = Partial<Task> & { kind: "project" | "habit"; title: string; targetAmount: number; completedAmount: number; estimatedMinutes: number; unit: string; reason: string; recordId: string | null; habitId: string | null; carryoverKey: string; sourceTaskId: string | null };
type Habit = { id: string; title: string; targetAmount: number; unit: string; estimatedMinutes: number; archived: boolean };
type Snapshot = { records: GrowthRecord[]; drafts: GrowthDraft[]; history: GrowthHistory[]; browserToken: string; viewer: string; daily: { today: string; currentPlan: Plan | null; plans: Plan[]; tasks: Task[]; habits: Habit[]; carryovers: Task[]; recordProgress: Record<string, number> } };
type ApiResult = { error?: string; draft?: GrowthDraft; plan?: Plan & { minutesWarning?: boolean }; daily?: Snapshot["daily"]; task?: Task; duplicate?: boolean };
type ModelProvider = { id: string; name: string; models: { id: string; name: string }[]; connected: boolean; verified: boolean; selectedModel: string; isDefault: boolean };
const labels: Record<View, string> = { daily: "每日任务", done: "已完成", ongoing: "进行中", planned: "待进行" };
const icons = { daily: CalendarCheck, done: CheckCircle2, ongoing: Clock3, planned: BookOpen };
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const blankFields = (status: GrowthStatus = "planned"): GrowthFields => ({ title: "", level: "step", category: "其他", status, parentId: null, notes: "", outcome: "", links: [], startText: "", dueDate: "", completedText: "", priority: 3, progressUnit: "", targetAmount: null, initialAmount: 0, progressWeight: 1, estimatedMinutes: null, paused: false, archived: false });
const readProgressText = (record: GrowthRecord, history: GrowthHistory[]) => {
  const item = history.find((entry) => entry.recordId === record.id && entry.action === "progress");
  try { return String(item ? (JSON.parse(item.afterJson) as { progressText?: string }).progressText ?? "" : ""); } catch { return ""; }
};
function percent(record: GrowthRecord, records: GrowthRecord[], progress: Record<string, number>, seen = new Set<string>()): number | null {
  if (seen.has(record.id)) return null;
  seen.add(record.id);
  const children = records.filter((item) => item.parentId === record.id && !item.archived);
  if (children.length) {
    const values = children.map((item) => ({ weight: item.progressWeight || 1, value: percent(item, records, progress, new Set(seen)) }));
    if (values.some((item) => item.value === null)) return null;
    const weights = values.reduce((sum, item) => sum + item.weight, 0);
    return weights ? values.reduce((sum, item) => sum + item.weight * (item.value ?? 0), 0) / weights : null;
  }
  if (record.targetAmount === null || record.targetAmount <= 0) return null;
  return Math.min(100, Math.max(0, (record.initialAmount + (progress[record.id] ?? 0)) / record.targetAmount * 100));
}
function deadlineNotice(record: GrowthRecord, currentDay: string) {
  if (record.paused) return { text: `暂停提醒 · ${record.dueDate || "未设截止日期"}`, tone: "deadline-paused" };
  const text = dueLabel(record, currentDay);
  if (text.includes("逾期")) return { text: `⚠ ${text}`, tone: "deadline-overdue" };
  if (text === "今天到期" || /^\d+ 天后到期$/.test(text)) return { text: `◷ ${text}`, tone: "deadline-soon" };
  return { text, tone: "" };
}
function parseJson(text: string) {
  const cleaned = text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/i, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI 返回内容格式无效，请重新生成。");
  try { return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>; } catch { throw new Error("AI 返回内容格式无效，请重新生成。"); }
}

export default function GrowthWorkspace() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("daily");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部类别");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<GrowthFields | null>(null);
  const [editRecordId, setEditRecordId] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantTarget, setAssistantTarget] = useState<"records" | "daily">("records");
  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [modelProviders, setModelProviders] = useState<ModelProvider[]>([]);
  const [modelProviderChoice, setModelProviderChoice] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [modelToken, setModelToken] = useState("");
  const [modelModal, setModelModal] = useState(false);
  const [draftModal, setDraftModal] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [changes, setChanges] = useState<DraftChange[]>([]);
  const [questions, setQuestions] = useState<string[]>([]);
  const [sourceText, setSourceText] = useState("");
  const [minutes, setMinutes] = useState(120);
  const [focus, setFocus] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [checkinValues, setCheckinValues] = useState<Record<string, string>>({});
  const [habitForm, setHabitForm] = useState(false);
  const [habitEditingId, setHabitEditingId] = useState<string | null>(null);
  const [showArchivedHabits, setShowArchivedHabits] = useState(false);
  const [habitTitle, setHabitTitle] = useState("");
  const [habitTarget, setHabitTarget] = useState(1);
  const [habitUnit, setHabitUnit] = useState("次");
  const [habitMinutes, setHabitMinutes] = useState(10);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/growth", { cache: "no-store" });
    const payload = await response.json() as Snapshot & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "无法读取记录");
    setData(payload);
    const modelResponse = await fetch("/api/models", { cache: "no-store" });
    if (modelResponse.ok) {
      const modelData = await modelResponse.json() as { providers: ModelProvider[] };
      setModelProviders(modelData.providers);
      const preferred = modelData.providers.find((provider) => provider.isDefault) ?? modelData.providers[0];
      setModelProviderChoice((current) => current || preferred?.id || "");
      setModelChoice((current) => current || preferred?.selectedModel || preferred?.models[0]?.id || "");
    }
    setMinutes(payload.daily.currentPlan?.availableMinutes ?? 120);
    setFocus(payload.daily.currentPlan?.focus ?? "");
    const plan = payload.daily.currentPlan;
    setCandidates(plan?.status === "draft" ? payload.daily.tasks.filter((task) => task.planId === plan.id && task.status === "suggested").map((task) => ({ ...task })) : []);
    setCheckinValues(Object.fromEntries(payload.daily.tasks.map((task) => [task.id, String(task.completedAmount)])));
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { load().catch((reason: Error) => setError(reason.message)); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const records = useMemo(() => data?.records ?? [], [data]);
  const selectedRecord = records.find((record) => record.id === selectedRecordId) ?? null;
  const pendingDrafts = data?.drafts.filter((draft) => draft.status === "pending") ?? [];
  const selectedDraft = data?.drafts.find((draft) => draft.id === draftId) ?? null;
  const categories = useMemo(() => [...new Set([...DEFAULT_CATEGORIES, ...records.map((record) => record.category)])], [records]);
  const visibleRecords = useMemo(() => records.filter((record) => record.status === view && (showArchived || !record.archived) &&
    (category === "全部类别" || record.category === category) && (!query || [record.title, record.category, record.notes, record.outcome].some((part) => part.toLowerCase().includes(query.toLowerCase()))))
    .sort((a, b) => view === "ongoing" ? Number(a.paused) - Number(b.paused) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || b.priority - a.priority : b.updatedAt.localeCompare(a.updatedAt)), [records, view, showArchived, category, query]);
  const currentTasks = data?.daily.currentPlan ? data.daily.tasks.filter((task) => task.planId === data.daily.currentPlan?.id) : [];
  const activeModel = modelProviders.find((provider) => provider.isDefault && provider.verified);
  const configuredProvider = modelProviders.find((provider) => provider.id === modelProviderChoice);

  const request = async (path: string, body: unknown): Promise<ApiResult> => {
    if (!data) throw new Error("页面尚未准备好");
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "x-growth-token": data.browserToken }, body: JSON.stringify(body) });
    const result = await response.json() as ApiResult;
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "操作失败");
    return result;
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请稍后重试"); } finally { setBusy(false); }
  };
  const openManual = (record?: GrowthRecord, status?: GrowthStatus) => {
    setEditRecordId(record?.id ?? null);
    setEditFields(record ? { title: record.title, level: record.level, category: record.category, status: record.status, parentId: record.parentId,
      notes: record.notes, outcome: record.outcome, links: record.links, startText: record.startText, dueDate: record.dueDate, completedText: record.completedText,
      priority: record.priority, progressUnit: record.progressUnit, targetAmount: record.targetAmount, initialAmount: record.initialAmount,
      progressWeight: record.progressWeight, estimatedMinutes: record.estimatedMinutes, paused: record.paused, archived: record.archived } : blankFields(status));
  };
  const setField = (key: keyof GrowthFields, value: unknown) => setEditFields((current) => current ? { ...current, [key]: value } : current);
  const saveManual = () => run(async () => {
    if (!editFields) return;
    const record = records.find((item) => item.id === editRecordId);
    const change: DraftChange = record ? { kind: "update", recordId: record.id, baseVersion: record.version, fields: editFields }
      : { kind: "create", clientKey: crypto.randomUUID(), fields: editFields };
    const draft = await request("/api/growth", { action: "saveDraft", source: "manual", sourceText: record ? "在事项详情中手动修改记录" : "手动新增成长事项", changes: [change], questions: [] });
    if (!draft.draft) throw new Error("未能创建事项草稿");
    await request("/api/growth", { action: "commitDraft", id: draft.draft.id, revision: draft.draft.revision });
    setEditFields(null); await load(); setMessage("记录已保存，变更历史已更新。");
  });
  const openDraft = (draft: GrowthDraft) => {
    setDraftId(draft.id); setDraftRevision(draft.revision); setSourceText(draft.sourceText);
    setChanges(draft.changes.map((change) => ({ ...change }))); setQuestions([...draft.questions]); setDraftModal(true);
  };
  const fieldAt = (index: number, key: keyof GrowthFields, value: unknown) => setChanges((items) => items.map((item, i) => i === index ? { ...item, fields: { ...item.fields, [key]: value } } : item));
  const changeAt = (index: number, patch: Partial<DraftChange>) => setChanges((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item));
  const saveDraft = () => run(async () => {
    const result = await request("/api/growth", { action: "saveDraft", source: "chatgpt", id: draftId, expectedRevision: draftRevision, sourceText, changes, questions });
    if (!result.draft) throw new Error("未能保存整理草稿");
    setDraftId(result.draft.id); setDraftRevision(result.draft.revision); await load(); setMessage("整理草稿已保存，确认前正式事项不会改变。");
  });
  const commitDraft = () => run(async () => {
    if (!draftId || draftRevision === null) return;
    await request("/api/growth", { action: "commitDraft", id: draftId, revision: draftRevision });
    setDraftModal(false); setDraftId(null); await load(); setMessage("已确认，成长记录和历史已更新。");
  });
  const cancelDraft = () => run(async () => {
    if (!draftId || draftRevision === null) return;
    await request("/api/growth", { action: "cancelDraft", id: draftId, revision: draftRevision });
    setDraftModal(false); setDraftId(null); await load(); setMessage("草稿已取消。");
  });
  const changeModelConfiguration = (action: "connect" | "select" | "test" | "disconnect") => run(async () => {
    const result = await request("/api/models", { action, providerId: modelProviderChoice, modelId: modelChoice, ...(action === "connect" ? { token: modelToken } : {}) }) as ApiResult & { providers?: ModelProvider[] };
    if (result.providers) setModelProviders(result.providers);
    if (action === "connect") { setModelToken(""); setMessage("令牌已加密保存。请点击“测试连接”验证实际模型调用。"); }
    if (action === "select") setMessage("已选用模型。若模型发生变化，请再次测试连接。");
    if (action === "test") setMessage("模型实际调用成功，现在可以生成建议。");
    if (action === "disconnect") setMessage("订阅连接已移除。");
  });
  const askAI = async (prompt: string, instructions: string) => {
    if (!activeModel) throw new Error("请先在模型配置中连接订阅服务，并完成实际调用测试。");
    const result = await request("/api/models", { action: "generate", providerId: activeModel.id, prompt, instructions }) as ApiResult & { text?: string };
    if (!result.text) throw new Error("AI 没有返回内容，请重试。");
    return result.text;
  };
  const compactRecords = () => records.map((record) => ({
    id: record.id, version: record.version, title: record.title, level: record.level, category: record.category, status: record.status,
    parentId: record.parentId, notes: record.notes, outcome: record.outcome, startText: record.startText, dueDate: record.dueDate,
    completedText: record.completedText, paused: record.paused, archived: record.archived, priority: record.priority,
    progressUnit: record.progressUnit, targetAmount: record.targetAmount, progress: percent(record, records, data?.daily.recordProgress ?? {}),
  }));
  const generateRecordDraft = () => run(async () => {
    if (!assistantPrompt.trim()) throw new Error("先写下你要记录或整理的内容。");
    const instructions = "你是个人成长档案整理助手。只依据用户明确提供的信息和当前事项，不编造事实、日期、成绩或技能掌握。先识别新增、更新、追加进展和状态迁移；重复事项优先复用已有ID和version。归属、时间或是否完成不确定时提出questions并避免猜测。只返回JSON对象：{summary:string,changes:DraftChange[],questions:string[]}。changes中kind为create/update/progress。已有事项要给recordId和baseVersion；新事项要给clientKey和完整fields，包括title,level,category,status,parentId,notes,outcome,links,startText,dueDate,completedText,priority,progressUnit,targetAmount,initialAmount,progressWeight,estimatedMinutes,paused,archived。";
    const prompt = JSON.stringify({ request: assistantPrompt, categories, currentRecords: compactRecords() });
    const parsed = parseJson(await askAI(prompt, instructions));
    if (!Array.isArray(parsed.changes) || !parsed.changes.length) throw new Error(String(parsed.summary || "AI 没有提出事项变更。"));
    const result = await request("/api/growth", { action: "saveDraft", source: "chatgpt", sourceText: assistantPrompt,
      changes: parsed.changes, questions: Array.isArray(parsed.questions) ? parsed.questions : [] });
    if (!result.draft) throw new Error("未能保存 AI 整理草稿");
    setAssistantOpen(false); setAssistantPrompt(""); await load(); openDraft(result.draft);
  });
  const changeCandidate = (index: number, key: keyof Candidate, value: unknown) => setCandidates((tasks) => tasks.map((task, i) => i === index ? { ...task, [key]: value } : task));
  const addCandidate = () => setCandidates((tasks) => [...tasks, { kind: "project", title: "", recordId: null, habitId: null, unit: "次", targetAmount: 1, completedAmount: 0, estimatedMinutes: 15, reason: "手动添加", carryoverKey: crypto.randomUUID(), sourceTaskId: null }]);
  const generateDaily = () => run(async () => {
    const eligible = records.filter((record) => record.status === "ongoing" && !record.paused && !record.archived && record.targetAmount !== null &&
      !records.some((child) => child.parentId === record.id && !child.archived) && record.initialAmount + (data?.daily.recordProgress[record.id] ?? 0) < record.targetAmount);
    const byCarryover = new Map((data?.daily.carryovers ?? []).map((task) => [task.id, task]));
    const instructions = "你是个人成长平台每日计划助手。只从给定的进行中末级事项和习惯中选择。根据可用分钟、截止日期（7天内到期优先）、优先级（5最高）和剩余工作量安排任务。不要安排暂停、归档、待进行、已完成或剩余量为0的事项。任务预计分钟之和尽量不超过预算；如时间不足，优先最紧急且有意义的任务并在summary中解释。习惯不累积漏打卡。只有适合今天时才推荐顺延任务，使用其sourceTaskId和carryoverKey，数量不超过其剩余量。为任务估计分钟并说明原因。只返回JSON：{summary:string,tasks:[{title,kind,recordId,habitId,unit,targetAmount,estimatedMinutes,reason,carryoverKey,sourceTaskId}]}。";
    const prompt = JSON.stringify({ date: data?.daily.today, availableMinutes: minutes, focus, userNote: assistantPrompt,
      records: eligible.map((record) => ({ id: record.id, title: record.title, category: record.category, dueDate: record.dueDate, priority: record.priority,
        unit: record.progressUnit, targetAmount: record.targetAmount, completedAmount: record.initialAmount + (data?.daily.recordProgress[record.id] ?? 0),
        remainingAmount: Math.max(0, (record.targetAmount ?? 0) - record.initialAmount - (data?.daily.recordProgress[record.id] ?? 0)), estimatedMinutes: record.estimatedMinutes })),
      habits: data?.daily.habits.filter((habit) => !habit.archived), carryovers: (data?.daily.carryovers ?? []).map((task) => ({
        sourceTaskId: task.id, carryoverKey: task.carryoverKey, title: task.title, kind: task.kind, recordId: task.recordId, habitId: task.habitId,
        unit: task.unit, remainingAmount: task.targetAmount - task.completedAmount, estimatedMinutes: task.estimatedMinutes,
        originalDueDate: task.recordId ? records.find((record) => record.id === task.recordId)?.dueDate : null,
      })) });
    const parsed = parseJson(await askAI(prompt, instructions));
    if (!Array.isArray(parsed.tasks)) throw new Error("AI 没有返回每日任务清单。");
    const tasks = (parsed.tasks as Record<string, unknown>[]).map((task) => {
      const source = byCarryover.get(String(task.sourceTaskId || ""));
      return { ...task, carryoverKey: source?.carryoverKey ?? task.carryoverKey ?? crypto.randomUUID(),
        sourceTaskId: source?.id ?? task.sourceTaskId ?? null, completedAmount: 0 };
    });
    const result = await request("/api/growth", { action: "saveDailyDraft", date: data?.daily.today,
      availableMinutes: minutes, focus, expectedRevision: data?.daily.currentPlan?.revision, tasks });
    await load(); setAssistantOpen(false); setAssistantPrompt("");
    setMessage(String(parsed.summary || "每日任务建议已生成") + "。请核对后再确认。");
    if (result.plan?.minutesWarning) setError("建议安排超过了今天可用时间，请删减或调整任务。");
  });
  const confirmDaily = () => run(async () => {
    const plan = data?.daily.currentPlan;
    if (!plan || plan.status !== "draft") return;
    const saved = await request("/api/growth", { action: "saveDailyDraft", date: data?.daily.today, availableMinutes: minutes,
      focus, expectedRevision: plan.revision, tasks: candidates });
    if (!saved.plan) throw new Error("未能保存每日任务建议");
    await request("/api/growth", { action: "confirmDailyPlan", planId: plan.id, revision: saved.plan.revision });
    await load(); setMessage("今天的任务已确认，可以开始打卡。");
  });
  const saveCheckin = (task: Task) => run(async () => {
    const completedAmount = Number(checkinValues[task.id] ?? task.completedAmount);
    if (!Number.isFinite(completedAmount)) throw new Error("请输入有效完成量。");
    await request("/api/growth", { action: "setTaskProgress", taskId: task.id, expectedRevision: task.revision, completedAmount,
      idempotencyKey: crypto.randomUUID(), note: "每日任务打卡" });
    await load(); setMessage("实际完成量已保存，关联事项进度已更新。");
  });
  const submitHabit = () => run(async () => {
    await request("/api/growth", { action: "saveHabit", id: habitEditingId, title: habitTitle, targetAmount: habitTarget, unit: habitUnit, estimatedMinutes: habitMinutes, archived: false });
    setHabitTitle(""); setHabitEditingId(null); setHabitForm(false); await load(); setMessage("每日习惯已保存。");
  });
  const editHabit = (habit: Habit) => { setHabitEditingId(habit.id); setHabitTitle(habit.title); setHabitTarget(habit.targetAmount); setHabitUnit(habit.unit); setHabitMinutes(habit.estimatedMinutes); setHabitForm(true); };
  const archiveHabit = (habit: Habit, archived: boolean) => run(async () => {
    await request("/api/growth", { action: "saveHabit", id: habit.id, title: habit.title, targetAmount: habit.targetAmount, unit: habit.unit, estimatedMinutes: habit.estimatedMinutes, archived });
    await load(); setMessage(archived ? "习惯已归档，不会进入新的每日建议。" : "习惯已恢复。");
  });

  return <SidebarProvider style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
    <Sidebar collapsible="offcanvas" className="growth-sidebar">
      <SidebarHeader className="brand-block"><span className="brand-mark"><FolderTree size={21} /></span><span><strong>个人成长平台</strong><small>我的成长档案</small></span></SidebarHeader>
      <SidebarContent className="nav-section"><p className="nav-caption">工作台</p><SidebarMenu>
        {(["daily", "done", "ongoing", "planned"] as View[]).map((key) => { const Icon = icons[key]; const count = key === "daily" ? currentTasks.length : records.filter((record) => record.status === key && !record.archived).length;
          return <SidebarMenuItem key={key}><SidebarMenuButton onClick={() => { setView(key); setSelectedRecordId(null); }} isActive={view === key} className="growth-nav-button"><Icon size={18} /><span>{labels[key]}</span><em>{count}</em></SidebarMenuButton></SidebarMenuItem>;
        })}
      </SidebarMenu></SidebarContent>
      <SidebarFooter className="nav-footer"><span className="footer-user">{data?.viewer ?? "个人空间"}</span><span>成长数据保存在云端</span><span>AI 模型在网页配置</span></SidebarFooter>
    </Sidebar>
    <SidebarInset className="growth-main">
      <header className="topbar"><SidebarTrigger className="menu-trigger" aria-label="打开导航" /><div className="topbar-context">{labels[view]}<span> / {today()}</span></div><div className="topbar-status"><span className="status-dot" />仅本人可见 · {activeModel ? `${activeModel.name} 已验证` : "AI 待连接"}</div></header>
      <div className="content-shell">
        {error && <div role="alert" className="feedback error">{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={16} /></button></div>}
        {message && <div role="status" className="feedback success">{message}<button onClick={() => setMessage("")} aria-label="关闭提示"><X size={16} /></button></div>}
        {!data ? <div className="loading-panel">正在读取成长记录…</div> : view === "daily" ? <main>
          <div className="page-heading"><div><p className="eyebrow">TODAY · {data.daily.today}</p><h1>每日任务</h1><p>按今天的时间安排成长事项，完成后记录实际工作量。</p></div><div className="heading-actions">
            <Button variant="outline" disabled={data.daily.currentPlan?.status === "confirmed"} onClick={() => { setAssistantTarget("daily"); setAssistantOpen(true); }}><Sparkles size={16} /> {data.daily.currentPlan?.status === "confirmed" ? "今日任务已确认" : "AI 推荐任务"}</Button>
            <Button variant="outline" onClick={() => { setHabitEditingId(null); setHabitTitle(""); setHabitTarget(1); setHabitUnit("次"); setHabitMinutes(10); setHabitForm(true); }}><Plus size={16} /> 添加习惯</Button></div></div>
          {data.daily.currentPlan?.status === "confirmed" ? <section className="panel daily-plan">
            <div className="panel-heading"><div><h2>今日安排</h2><p>{data.daily.currentPlan.availableMinutes} 分钟 · {data.daily.currentPlan.focus || "未添加特别安排"}</p></div><span className="category-pill">已确认</span></div>
            {currentTasks.length ? <div className="daily-task-list">{currentTasks.map((task) => {
              const linked = task.recordId ? records.find((record) => record.id === task.recordId) : null;
              const complete = task.completedAmount >= task.targetAmount;
              return <article className={"daily-task " + (complete ? "task-complete" : "")} key={task.id}>
                <div className="task-check">{complete ? <Check size={17} /> : <Clock3 size={17} />}</div><div className="task-main">
                  <div className="task-title-row"><h3>{task.title}</h3><span>{task.estimatedMinutes} 分钟</span></div>
                  {linked && <p className="parent-line">推进：{linked.title} · 截止 {linked.dueDate || "未设截止日期"}</p>}
                  <p className="task-reason">{task.reason || (task.kind === "habit" ? "习惯打卡" : "项目步骤")}</p>
                  <div className="task-progress"><div className="progress-track"><span style={{ width: Math.min(100, task.completedAmount / task.targetAmount * 100) + "%" }} /></div><span>{task.completedAmount} / {task.targetAmount} {task.unit}</span></div>
                </div><div className="task-checkin"><label className="field-label">实际完成<Input type="number" min="0" max={task.targetAmount} step="any" value={checkinValues[task.id] ?? task.completedAmount} onChange={(event) => setCheckinValues((value) => ({ ...value, [task.id]: event.target.value }))} /></label><Button size="sm" disabled={busy} onClick={() => saveCheckin(task)}>打卡</Button></div>
              </article>;
            })}</div> : <p className="muted-copy">今天没有任务。你可以先添加习惯或准备明天的安排。</p>}
          </section> : <section className="panel daily-plan">
            <div className="panel-heading"><div><h2>{data.daily.currentPlan ? "审核每日建议" : "安排今天的时间"}</h2><p>AI 会参考时限、优先级、剩余工作量和习惯进行建议。</p></div><span className="category-pill">待审核</span></div>
            <div className="daily-settings"><label className="field-label">今天可用时间（分钟）<Input type="number" min="0" max="1440" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><label className="field-label">今天的重点<Input value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="例如：完成文献综述的方法部分" /></label></div>
            <div className="inline-actions"><Button onClick={() => { setAssistantTarget("daily"); setAssistantOpen(true); }}><Sparkles size={16} /> AI 推荐任务</Button><Button variant="outline" onClick={addCandidate}><Plus size={16} /> 手动添加</Button></div>
            {data.daily.carryovers.length > 0 && <p className="rollover-note">有 {data.daily.carryovers.length} 项未完成工作可加入今天的建议；不会自动顺延，需审核后确认。</p>}
            {candidates.length > 0 && <div className="candidate-list">{candidates.map((task, index) => <article className="candidate-card" key={task.id ?? task.carryoverKey}>
              <div className="task-title-row"><strong>建议 {index + 1}</strong><button className="icon-button" onClick={() => setCandidates((items) => items.filter((_, i) => i !== index))} aria-label="移除建议"><X size={16} /></button></div>
              <div className="editor-grid"><label className="field-label wide">任务名称<Input value={task.title} onChange={(event) => changeCandidate(index, "title", event.target.value)} /></label>
                <label className="field-label">类型<select value={task.kind} onChange={(event) => changeCandidate(index, "kind", event.target.value)}><option value="project">项目步骤</option><option value="habit">每日习惯</option></select></label>
                {task.kind === "project" ? <label className="field-label">进行中步骤<select value={task.recordId ?? ""} onChange={(event) => { const record = records.find((item) => item.id === event.target.value); changeCandidate(index, "recordId", record?.id ?? null); changeCandidate(index, "unit", record?.progressUnit ?? "次"); }}><option value="">选择事项</option>{records.filter((record) => record.status === "ongoing" && !record.paused && !record.archived && record.targetAmount !== null && !records.some((child) => child.parentId === record.id && !child.archived) && record.initialAmount + (data.daily.recordProgress[record.id] ?? 0) < record.targetAmount).map((record) => <option value={record.id} key={record.id}>{record.title}</option>)}</select></label>
                  : <label className="field-label">每日习惯<select value={task.habitId ?? ""} onChange={(event) => { const habit = data.daily.habits.find((item) => item.id === event.target.value); changeCandidate(index, "habitId", habit?.id ?? null); changeCandidate(index, "unit", habit?.unit ?? "次"); }}><option value="">选择习惯</option>{data.daily.habits.filter((habit) => !habit.archived).map((habit) => <option value={habit.id} key={habit.id}>{habit.title}</option>)}</select></label>}
                <label className="field-label">任务量<Input type="number" min="0.01" step="any" value={task.targetAmount} onChange={(event) => changeCandidate(index, "targetAmount", Number(event.target.value))} /></label><label className="field-label">预计分钟<Input type="number" min="0" value={task.estimatedMinutes} onChange={(event) => changeCandidate(index, "estimatedMinutes", Number(event.target.value))} /></label>
                <label className="field-label wide">推荐理由<Input value={task.reason} onChange={(event) => changeCandidate(index, "reason", event.target.value)} /></label>
              </div>
            </article>)}</div>}
            <Button disabled={busy || data.daily.currentPlan?.status !== "draft"} onClick={confirmDaily}><Check size={16} /> 确认今天的任务</Button>
          </section>}
          {habitForm && <section className="panel habit-panel"><div className="panel-heading"><h2>{habitEditingId ? "修改每日习惯" : "添加每日习惯"}</h2><button className="icon-button" onClick={() => { setHabitForm(false); setHabitEditingId(null); }} aria-label="关闭"><X size={16} /></button></div>
            <div className="daily-settings"><label className="field-label">习惯名称<Input value={habitTitle} onChange={(event) => setHabitTitle(event.target.value)} placeholder="例如：背英语单词" /></label><label className="field-label">每日目标<Input type="number" min="0.01" step="any" value={habitTarget} onChange={(event) => setHabitTarget(Number(event.target.value))} /></label><label className="field-label">单位<Input value={habitUnit} onChange={(event) => setHabitUnit(event.target.value)} /></label><label className="field-label">预计分钟<Input type="number" min="0" value={habitMinutes} onChange={(event) => setHabitMinutes(Number(event.target.value))} /></label></div>
            <div className="composer-actions"><Button disabled={busy} onClick={submitHabit}>保存习惯</Button><Button variant="outline" onClick={() => { setHabitForm(false); setHabitEditingId(null); }}>取消</Button></div></section>}
          <section className="panel habit-panel"><div className="panel-heading"><div><h2>每日习惯</h2><p>漏打卡不累积，也不会计入项目进度。</p></div><label className="check-label"><input type="checkbox" checked={showArchivedHabits} onChange={(event) => setShowArchivedHabits(event.target.checked)} />显示已归档</label></div>
            {data.daily.habits.filter((habit) => showArchivedHabits || !habit.archived).length ? <div className="habit-list">{data.daily.habits.filter((habit) => showArchivedHabits || !habit.archived).map((habit) => <div className="habit-chip" key={habit.id}><span><CalendarCheck size={16} /> {habit.title}<small> · 每日 {habit.targetAmount} {habit.unit}</small></span><div className="inline-actions"><Button size="sm" variant="ghost" onClick={() => editHabit(habit)} disabled={habit.archived}>修改</Button><Button size="sm" variant="outline" onClick={() => archiveHabit(habit, !habit.archived)}>{habit.archived ? "恢复" : "归档"}</Button></div></div>)}</div> : <p className="muted-copy">还没有设置习惯，可添加背单词、运动等每日目标。</p>}
          </section>
          <section className="panel recent-days"><div className="panel-heading"><h2>近期每日计划</h2><History size={18} /></div>{data.daily.plans.length ? <div className="day-history">{data.daily.plans.slice(0, 14).map((plan) => {
            const tasks = data.daily.tasks.filter((task) => task.planId === plan.id);
            return <div className="day-row" key={plan.id}><strong>{plan.date}</strong><span>{tasks.length} 项</span><span>{plan.status === "confirmed" ? "已确认" : "待审核"}</span><small>{tasks.filter((task) => task.completedAmount >= task.targetAmount).length} 项完成</small></div>;
          })}</div> : <p className="muted-copy">确认后的任务会保留在这里。</p>}</section>
          {pendingDrafts.length > 0 && <section className="panel pending-panel"><div className="panel-heading"><div><h2>待确认的事项整理</h2><p>网页 AI 和旧 ChatGPT 插件保存的草稿都在这里。</p></div></div><div className="pending-list">{pendingDrafts.map((draft) => <button key={draft.id} className="pending-item" onClick={() => openDraft(draft)}><strong>{draft.sourceText.slice(0, 90)}</strong><span>{draft.source === "chatgpt" ? "AI 整理" : "手动补录"} · {new Date(draft.updatedAt).toLocaleDateString("zh-CN")}</span></button>)}</div></section>}
          <section className="panel backup-panel"><h2>设置与数据</h2><p>模型连接与备份分开保存；备份不包含订阅令牌。</p><div className="inline-actions"><Button variant="outline" onClick={() => setModelModal(true)}>模型配置</Button><a className="backup-link" href="/api/backup"><Download size={16} /> 下载 JSON 备份</a></div>{records.length === 0 && data.drafts.length === 0 && data.history.length === 0 && data.daily.plans.length === 0 && data.daily.habits.length === 0 && <label className="restore-link"><Upload size={16} /> 恢复到空数据库<input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) run(async () => { const response = await fetch("/api/backup", { method: "POST", headers: { "Content-Type": "application/json", "x-growth-token": data.browserToken }, body: await file.text() }); const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "恢复失败"); await load(); setMessage("备份已恢复。"); }); }} /></label>}</section>
        </main> : <main>
          <div className="page-heading"><div><p className="eyebrow">成长档案 · {records.filter((record) => record.status === view && !record.archived).length} 项</p><h1>{labels[view]}</h1><p>{view === "ongoing" ? "跟踪完成比例、优先级和截止日期。" : view === "done" ? "回看已经取得的成果。" : "整理尚未启动的成长方向。"}</p></div>
            <div className="heading-actions"><Button variant="outline" onClick={() => { setAssistantTarget("records"); setAssistantOpen(true); }}><Sparkles size={16} /> AI 帮助整理</Button><Button onClick={() => openManual(undefined, view)}><Plus size={16} /> 新增事项</Button></div></div>
          <div className="filter-bar"><div className="search-box"><Search size={17} /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、笔记和成果" aria-label="搜索事项" /></div><select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="按类别筛选"><option>全部类别</option>{categories.map((name) => <option key={name}>{name}</option>)}</select><label className="check-label archived-filter"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />显示归档</label></div>
          <div className="records-layout"><section className="record-list">{visibleRecords.length ? visibleRecords.map((record) => {
            const parent = records.find((item) => item.id === record.parentId), value = percent(record, records, data.daily.recordProgress), recent = readProgressText(record, data.history);
            return <article key={record.id} className={"record-card " + (selectedRecordId === record.id ? "selected" : "")} onClick={() => setSelectedRecordId(record.id)}>
              <div className="record-top"><span className="category-pill">{record.category}</span><span className="record-level">{levelLabel(record.level)} · 优先级 {record.priority}</span></div><h2>{record.title}</h2>{parent && <p className="parent-line">属于：{parent.title}</p>}
              {view === "ongoing" && <><div className="progress-line"><div className="progress-track"><span style={{ width: (value ?? 0) + "%" }} /></div><span>{value === null ? "待设置进度" : Math.round(value) + "%"}</span></div><p className="record-meta">截止：<span className={deadlineNotice(record, today()).tone}>{deadlineNotice(record, today()).text}</span> · 优先级 {record.priority}/5 · 预计 {record.estimatedMinutes === null ? "未估时" : record.estimatedMinutes + " 分钟"}</p></>}
              {recent && <p className="progress-line">最近进展：{recent}</p>}<div className="record-bottom"><span>{view === "ongoing" ? record.paused ? "已暂停 · 暂停提醒" : value === null ? "补充工作量目标" : "剩余 " + Math.max(0, 100 - value).toFixed(0) + "%" : record.archived ? "已归档" : record.completedText || record.startText || statusLabel(record.status)}</span><span>查看详情</span></div>
            </article>;
          }) : <Empty className="list-empty"><EmptyHeader><EmptyTitle>这里还没有事项</EmptyTitle><EmptyDescription>可手动新增，或让 AI 根据你的叙述整理。</EmptyDescription></EmptyHeader></Empty>}</section>
            <aside className="panel detail-panel">{selectedRecord && selectedRecord.status === view ? (() => {
              const value = percent(selectedRecord, records, data.daily.recordProgress), children = records.filter((item) => item.parentId === selectedRecord.id && !item.archived);
              return <><div className="detail-head"><span className="category-pill">{selectedRecord.category}</span><span>{levelLabel(selectedRecord.level)}</span></div><h2>{selectedRecord.title}</h2><p className="detail-status">{statusLabel(selectedRecord.status)}{selectedRecord.paused ? " · 已暂停" : ""}{selectedRecord.archived ? " · 已归档" : ""}</p>
                {view === "ongoing" && <div className="detail-progress"><div className="task-title-row"><strong>{value === null ? "待设置进度" : Math.round(value) + "%"}</strong><span>优先级 {selectedRecord.priority} / 5</span></div><div className="progress-track"><span style={{ width: (value ?? 0) + "%" }} /></div>{selectedRecord.targetAmount !== null && <p>已完成 {selectedRecord.initialAmount + (data.daily.recordProgress[selectedRecord.id] ?? 0)} / {selectedRecord.targetAmount} {selectedRecord.progressUnit}</p>}{value !== null && value >= 100 && <p className="progress-complete-note">已达到目标，请核对后手动确认事项完成。</p>}</div>}
                <dl className="detail-grid"><dt>上级事项</dt><dd>{records.find((item) => item.id === selectedRecord.parentId)?.title ?? "无"}</dd><dt>开始时间</dt><dd>{selectedRecord.startText || "未记录"}</dd><dt>截止时间</dt><dd>{selectedRecord.dueDate ? dueLabel(selectedRecord, today()) : "未设截止日期"}</dd><dt>完成时间</dt><dd>{selectedRecord.completedText || "未记录"}</dd><dt>预计耗时</dt><dd>{selectedRecord.estimatedMinutes === null ? "未估时" : selectedRecord.estimatedMinutes + " 分钟"}</dd><dt>计量目标</dt><dd>{selectedRecord.targetAmount === null ? "待设置进度" : selectedRecord.targetAmount + " " + selectedRecord.progressUnit}</dd><dt>步骤权重</dt><dd>{selectedRecord.progressWeight}</dd></dl>
                {selectedRecord.notes && <div className="detail-block"><h3>详细笔记</h3><p>{selectedRecord.notes}</p></div>}{selectedRecord.outcome && <div className="detail-block"><h3>成果</h3><p>{selectedRecord.outcome}</p></div>}
                {children.length > 0 && <div className="detail-block"><h3>关联步骤</h3>{children.map((child) => <p className="detail-history" key={child.id}>{child.title} · {statusLabel(child.status)}</p>)}</div>}
                {selectedRecord.links.map((link) => <div className="detail-block" key={link}><a href={link} target="_blank" rel="noreferrer">{link}<ExternalLink size={14} /></a></div>)}
                <div className="detail-block"><h3>变更历史</h3>{data.history.filter((item) => item.recordId === selectedRecord.id).slice(0, 8).map((item) => <p className="detail-history" key={item.id}>{item.occurredText || new Date(item.createdAt).toLocaleDateString("zh-CN")} · {item.action === "progress" ? readProgressText(selectedRecord, [item]) || "新增进展" : item.action === "create" ? "创建事项" : "更新事项"}</p>)}</div>
                <div className="detail-actions"><Button variant="outline" onClick={() => openManual(selectedRecord)}>手动修改</Button><Button variant="outline" onClick={() => { setAssistantTarget("records"); setAssistantPrompt("请整理「" + selectedRecord.title + "」的当前情况："); setAssistantOpen(true); }}>AI 帮助整理</Button>{view === "ongoing" && <Button variant="outline" onClick={() => openManual({ ...selectedRecord, paused: !selectedRecord.paused })}>{selectedRecord.paused ? "恢复事项" : "暂停事项"}</Button>}</div>
              </>;
            })() : <div className="detail-empty"><FolderTree size={34} /><h2>选择一条事项</h2><p>在这里查看目标进度、关联步骤和变更历史。</p></div>}</aside>
          </div>
        </main>}
      </div>
    </SidebarInset>

    {editFields && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditFields(null); }}><section className="modal-card record-editor" role="dialog" aria-modal="true" aria-labelledby="record-editor-title">
      <div className="modal-heading"><div><p className="eyebrow">成长记录</p><h2 id="record-editor-title">{editRecordId ? "修改事项" : "新增事项"}</h2></div><button className="icon-button" onClick={() => setEditFields(null)} aria-label="关闭"><X size={18} /></button></div>
      <div className="editor-grid"><label className="field-label wide">名称<Input value={editFields.title} onChange={(event) => setField("title", event.target.value)} placeholder="课程、技能、科研项目或步骤" /></label>
        <label className="field-label">层级<select value={editFields.level} onChange={(event) => { setField("level", event.target.value); setField("parentId", null); }}><option value="goal">目标</option><option value="project">项目</option><option value="step">步骤 / 独立事项</option></select></label>
        <label className="field-label">状态<select value={editFields.status} onChange={(event) => { setField("status", event.target.value); if (event.target.value !== "ongoing") setField("paused", false); }}><option value="planned">待进行</option><option value="ongoing">进行中</option><option value="done">已完成</option></select></label>
        <label className="field-label">类别<Input list="growth-categories" value={editFields.category} onChange={(event) => setField("category", event.target.value)} /><datalist id="growth-categories">{categories.map((name) => <option key={name} value={name} />)}</datalist></label>
        <label className="field-label">上级事项<select value={editFields.parentId ?? ""} disabled={editFields.level === "goal"} onChange={(event) => setField("parentId", event.target.value || null)}><option value="">无上级事项</option>{records.filter((item) => item.id !== editRecordId && (editFields.level === "project" ? item.level === "goal" : item.level === "project")).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label className="field-label">优先级<select value={editFields.priority} onChange={(event) => setField("priority", Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label className="field-label">开始时间<Input value={editFields.startText} onChange={(event) => setField("startText", event.target.value)} placeholder="可写模糊日期" /></label><label className="field-label">截止日期<Input type="date" value={editFields.dueDate} onChange={(event) => setField("dueDate", event.target.value)} /></label><label className="field-label">完成时间<Input value={editFields.completedText} onChange={(event) => setField("completedText", event.target.value)} /></label>
        <label className="field-label">工作量单位<Input value={editFields.progressUnit} onChange={(event) => setField("progressUnit", event.target.value)} placeholder="页、篇、小时、个" /></label>
        <label className="field-label">目标工作量<Input type="number" min="0" step="any" value={editFields.targetAmount ?? ""} onChange={(event) => setField("targetAmount", event.target.value === "" ? null : Number(event.target.value))} /></label>
        <label className="field-label">已有完成量<Input type="number" min="0" step="any" value={editFields.initialAmount} onChange={(event) => setField("initialAmount", Number(event.target.value))} /></label>
        <label className="field-label">步骤权重<Input type="number" min="0.1" step="any" value={editFields.progressWeight} onChange={(event) => setField("progressWeight", Number(event.target.value))} /></label>
        <label className="field-label">预计分钟<Input type="number" min="0" value={editFields.estimatedMinutes ?? ""} onChange={(event) => setField("estimatedMinutes", event.target.value === "" ? null : Number(event.target.value))} /></label>
        <label className="field-label wide">详细笔记<Textarea rows={3} value={editFields.notes} onChange={(event) => setField("notes", event.target.value)} /></label><label className="field-label wide">成果<Textarea rows={2} value={editFields.outcome} onChange={(event) => setField("outcome", event.target.value)} /></label>
        <label className="field-label wide">相关链接<Textarea rows={2} value={editFields.links.join("\n")} onChange={(event) => setField("links", event.target.value.split("\n").map((part) => part.trim()).filter(Boolean))} /></label>
        <label className="check-label"><input type="checkbox" checked={editFields.paused} disabled={editFields.status !== "ongoing"} onChange={(event) => setField("paused", event.target.checked)} />已暂停</label><label className="check-label"><input type="checkbox" checked={editFields.archived} onChange={(event) => setField("archived", event.target.checked)} />已归档</label></div>
      <div className="composer-actions"><Button disabled={busy} onClick={saveManual}>{busy ? "保存中…" : "保存修改"}</Button><Button variant="outline" onClick={() => setEditFields(null)}>取消</Button></div>
    </section></div>}

    {assistantOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAssistantOpen(false); }}><section className="modal-card assistant-card" role="dialog" aria-modal="true" aria-labelledby="assistant-title">
      <div className="modal-heading"><div><p className="eyebrow">AI · 网页模型配置</p><h2 id="assistant-title">{assistantTarget === "daily" ? "AI 推荐每日任务" : "AI 帮助整理成长记录"}</h2></div><button className="icon-button" onClick={() => setAssistantOpen(false)} aria-label="关闭"><X size={18} /></button></div>
      <p className="privacy-note">{activeModel ? `当前使用 ${activeModel.name} · ${activeModel.selectedModel}。生成内容先供你审核。` : "尚未连接并验证可用模型。ChatGPT Plus 的网页订阅登录目前尚未接通。"}</p>
      <Button variant="outline" onClick={() => setModelModal(true)}>打开模型配置</Button>
      {assistantTarget === "daily" && <div className="daily-settings assistant-settings"><label className="field-label">今天可用时间（分钟）<Input type="number" min="0" max="1440" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><label className="field-label">今天的重点<Input value={focus} onChange={(event) => setFocus(event.target.value)} /></label></div>}
      <label className="field-label">{assistantTarget === "daily" ? "补充今天的情况" : "你想记录或整理什么？"}<Textarea rows={5} value={assistantPrompt} onChange={(event) => setAssistantPrompt(event.target.value)} placeholder={assistantTarget === "daily" ? "例如：下午有课，今天先推进文献阅读，也要留出时间锻炼。" : "例如：昨天读完 8 篇文献，下周一前要提交初稿。"} /></label>
      <div className="assistant-footer"><span>当前上下文 {assistantTarget === "records" ? records.length + " 项" : (data?.daily.carryovers.length ?? 0) + " 项可顺延"}</span><Button disabled={busy || !activeModel} onClick={assistantTarget === "daily" ? generateDaily : generateRecordDraft}><Sparkles size={16} />{busy ? "整理中…" : "生成并预览"}</Button></div>
    </section></div>}

    {modelModal && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModelModal(false); }}><section className="modal-card model-config-card" role="dialog" aria-modal="true" aria-labelledby="model-config-title">
      <div className="modal-heading"><div><p className="eyebrow">模型订阅 · 云端连接</p><h2 id="model-config-title">模型配置</h2></div><button className="icon-button" onClick={() => setModelModal(false)} aria-label="关闭"><X size={18} /></button></div>
      <p className="privacy-note">这里只接受所列服务的订阅令牌，并在云端加密保存。保存后须实际测试模型调用才会启用。令牌不会进入网页备份。</p>
      <div className="pair-box"><strong>ChatGPT Plus</strong><p className="muted-copy">你目前的 Plus 订阅尚不能在这个网站直接登录调用。pi-ai 的 OAuth 登录要求 Node 环境；目前的 Sites 网站没有相应云端 Node 登录服务。这里不会要求你填写 ChatGPT 密码或把 Plus 当作普通 API 余额。</p></div>
      <div className="model-config-fields"><label className="field-label">订阅服务<select value={modelProviderChoice} onChange={(event) => { const selected = modelProviders.find((provider) => provider.id === event.target.value); setModelProviderChoice(selected?.id ?? ""); setModelChoice(selected?.selectedModel || selected?.models[0]?.id || ""); setModelToken(""); }}><option value="">请选择</option>{modelProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
        <label className="field-label">模型<select value={modelChoice} onChange={(event) => setModelChoice(event.target.value)}><option value="">请选择</option>{configuredProvider?.models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="field-label wide">订阅令牌<Input type="password" autoComplete="off" value={modelToken} onChange={(event) => setModelToken(event.target.value)} placeholder={configuredProvider?.connected ? "已保存；需要更换时输入新令牌" : "粘贴服务商提供的订阅令牌"} /></label>
      </div>
      <p className="model-connection-status">状态：{configuredProvider?.verified ? "实际调用已验证" : configuredProvider?.connected ? "已保存，待测试" : "尚未连接"}{configuredProvider?.isDefault ? " · 当前选用" : ""}</p>
      <div className="inline-actions model-config-actions"><Button disabled={busy || !modelProviderChoice || !modelChoice || !modelToken.trim()} onClick={() => changeModelConfiguration("connect")}>保存令牌</Button><Button variant="outline" disabled={busy || !configuredProvider?.connected} onClick={() => changeModelConfiguration("select")}>选用此模型</Button><Button variant="outline" disabled={busy || !configuredProvider?.connected} onClick={() => changeModelConfiguration("test")}>测试连接</Button><Button variant="ghost" disabled={busy || !configuredProvider?.connected} onClick={() => changeModelConfiguration("disconnect")}>移除连接</Button></div>
    </section></div>}

    {draftModal && selectedDraft && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraftModal(false); }}><section className="modal-card draft-card" role="dialog" aria-modal="true" aria-labelledby="draft-title">
      <div className="modal-heading"><div><p className="eyebrow">逐项核对 · 正式记录尚未改变</p><h2 id="draft-title">整理结果预览</h2></div><button className="icon-button" onClick={() => setDraftModal(false)} aria-label="关闭"><X size={18} /></button></div>
      <label className="field-label">原始叙述<Textarea rows={3} value={sourceText} onChange={(event) => setSourceText(event.target.value)} /></label><div className="changes-heading"><strong>拟变更事项</strong><Button variant="outline" size="sm" onClick={() => setChanges((items) => [...items, { kind: "create", clientKey: crypto.randomUUID(), fields: blankFields() }])}><Plus size={15} />添加事项</Button></div>
      {changes.map((change, index) => { const record = records.find((item) => item.id === change.recordId); const fields = { ...blankFields(), ...(record ?? {}), ...(change.fields ?? {}) } as GrowthFields;
        return <article className="change-card" key={(change.clientKey ?? change.recordId ?? "new") + index}><div className="change-card-head"><span>变更 {index + 1}</span>
          <select value={change.kind} onChange={(event) => { const kind = event.target.value as DraftChange["kind"]; changeAt(index, kind === "create" ? { kind, clientKey: crypto.randomUUID(), recordId: undefined, baseVersion: undefined, fields: blankFields() } : { kind, clientKey: undefined, fields: kind === "progress" ? undefined : change.fields }); }}>
            <option value="create">新增事项</option><option value="update">修改事项</option><option value="progress">追加进展</option></select><button className="icon-button" onClick={() => setChanges((items) => items.filter((_, i) => i !== index))} aria-label="移除"><X size={16} /></button></div>
          {change.kind !== "create" && <label className="field-label">已有事项<select value={change.recordId ?? ""} onChange={(event) => { const chosen = records.find((item) => item.id === event.target.value); changeAt(index, { recordId: chosen?.id, baseVersion: chosen?.version, fields: change.kind === "update" && chosen ? { ...chosen } : undefined }); }}><option value="">选择事项</option>{records.map((item) => <option key={item.id} value={item.id}>{item.title} · {statusLabel(item.status)}</option>)}</select></label>}
          {change.kind === "progress" ? <label className="field-label">进展内容<Textarea rows={3} value={change.progressText ?? ""} onChange={(event) => changeAt(index, { progressText: event.target.value })} /></label> : <div className="editor-grid">
            <label className="field-label wide">名称<Input value={fields.title} onChange={(event) => fieldAt(index, "title", event.target.value)} /></label><label className="field-label">类别<Input value={fields.category} onChange={(event) => fieldAt(index, "category", event.target.value)} /></label>
            <label className="field-label">状态<select value={fields.status} onChange={(event) => fieldAt(index, "status", event.target.value)}><option value="planned">待进行</option><option value="ongoing">进行中</option><option value="done">已完成</option></select></label>
            <label className="field-label">层级<select value={fields.level} onChange={(event) => fieldAt(index, "level", event.target.value)}><option value="goal">目标</option><option value="project">项目</option><option value="step">步骤 / 独立事项</option></select></label>
            <label className="field-label">上级事项<select value={fields.parentId ?? ""} disabled={fields.level === "goal"} onChange={(event) => fieldAt(index, "parentId", event.target.value || null)}><option value="">无上级事项</option>{records.filter((item) => item.id !== record?.id && (fields.level === "project" ? item.level === "goal" : item.level === "project")).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}{changes.filter((item) => item.kind === "create" && item.clientKey !== change.clientKey && item.fields?.level === (fields.level === "project" ? "goal" : "project")).map((item) => <option key={item.clientKey} value={"temp:" + item.clientKey}>本草稿：{item.fields?.title || "新建事项"}</option>)}</select></label>
            <label className="field-label">开始时间<Input value={fields.startText} onChange={(event) => fieldAt(index, "startText", event.target.value)} placeholder="可写模糊日期" /></label><label className="field-label">截止日期<Input type="date" value={fields.dueDate} onChange={(event) => fieldAt(index, "dueDate", event.target.value)} /></label><label className="field-label">完成时间<Input value={fields.completedText} onChange={(event) => fieldAt(index, "completedText", event.target.value)} /></label>
            <label className="field-label">优先级<select value={fields.priority} onChange={(event) => fieldAt(index, "priority", Number(event.target.value))}>{[1,2,3,4,5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="field-label">单位<Input value={fields.progressUnit} onChange={(event) => fieldAt(index, "progressUnit", event.target.value)} /></label><label className="field-label">目标量<Input type="number" min="0" step="any" value={fields.targetAmount ?? ""} onChange={(event) => fieldAt(index, "targetAmount", event.target.value === "" ? null : Number(event.target.value))} /></label>
            <label className="field-label">已有完成量<Input type="number" min="0" step="any" value={fields.initialAmount} onChange={(event) => fieldAt(index, "initialAmount", Number(event.target.value))} /></label><label className="field-label">步骤权重<Input type="number" min="0.1" step="any" value={fields.progressWeight} onChange={(event) => fieldAt(index, "progressWeight", Number(event.target.value))} /></label><label className="field-label">预计分钟<Input type="number" min="0" value={fields.estimatedMinutes ?? ""} onChange={(event) => fieldAt(index, "estimatedMinutes", event.target.value === "" ? null : Number(event.target.value))} /></label>
            <label className="field-label wide">详细笔记<Textarea rows={2} value={fields.notes} onChange={(event) => fieldAt(index, "notes", event.target.value)} /></label><label className="field-label wide">成果<Textarea rows={2} value={fields.outcome} onChange={(event) => fieldAt(index, "outcome", event.target.value)} /></label><label className="field-label wide">相关链接<Textarea rows={2} value={fields.links.join("\n")} onChange={(event) => fieldAt(index, "links", event.target.value.split("\n").map((part) => part.trim()).filter(Boolean))} /></label>
            <label className="check-label"><input type="checkbox" checked={fields.paused} disabled={fields.status !== "ongoing"} onChange={(event) => fieldAt(index, "paused", event.target.checked)} />已暂停</label><label className="check-label"><input type="checkbox" checked={fields.archived} onChange={(event) => fieldAt(index, "archived", event.target.checked)} />已归档</label>
          </div>}
          <label className="field-label">事情发生时间<Input value={change.occurredText ?? ""} onChange={(event) => changeAt(index, { occurredText: event.target.value })} placeholder="可填模糊时间" /></label>
        </article>;
      })}
      <label className="field-label">还需要澄清的问题<Textarea rows={questions.length ? 2 : 1} value={questions.join("\n")} onChange={(event) => setQuestions(event.target.value.split("\n").filter(Boolean))} placeholder="确认前解决问题，或删除已解决的问题。" /></label>
      <div className="composer-actions"><Button disabled={busy || !changes.length} onClick={saveDraft}>{busy ? "保存中…" : "保存草稿"}</Button><Button variant="outline" disabled={busy || selectedDraft.status !== "pending" || questions.length > 0 || selectedDraft.revision !== draftRevision} onClick={commitDraft}>确认并写入</Button>{selectedDraft.status === "pending" && <Button variant="ghost" disabled={busy} onClick={cancelDraft}>取消草稿</Button>}</div>
      {selectedDraft.status !== "pending" && <p className="muted-copy">这份草稿已处理，不能再次写入。</p>}
    </section></div>}
  </SidebarProvider>;
}
