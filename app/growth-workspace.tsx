"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen, CheckCircle2, Clock3, Download, ExternalLink, FolderTree,
  History, Inbox, Plus, Search, Upload, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  DEFAULT_CATEGORIES, dueLabel, levelLabel, statusLabel,
  type DraftChange, type GrowthDraft, type GrowthFields, type GrowthHistory,
  type GrowthRecord, type GrowthStatus,
} from "@/lib/growth";

type View = "updates" | GrowthStatus;
type Snapshot = {
  records: GrowthRecord[]; drafts: GrowthDraft[]; history: GrowthHistory[];
  browserToken: string; viewer: string;
};

const labels: Record<View, string> = {
  updates: "每日更新", done: "已完成", ongoing: "进行中", planned: "待进行",
};
const icons = { updates: Inbox, done: CheckCircle2, ongoing: Clock3, planned: BookOpen };
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const blankFields = (): GrowthFields => ({
  title: "", level: "step", category: "其他", status: "planned", parentId: null,
  notes: "", outcome: "", links: [], startText: "", dueDate: "", completedText: "",
  paused: false, archived: false,
});
const blankChange = (): DraftChange => ({ kind: "create", clientKey: crypto.randomUUID(), fields: blankFields() });
function findProgress(record: GrowthRecord, history: GrowthHistory[]) {
  const entry = history.find((item) => item.recordId === record.id && item.action === "progress");
  if (!entry) return "";
  try { return String((JSON.parse(entry.afterJson) as { progressText?: string }).progressText ?? ""); }
  catch { return ""; }
}

export default function GrowthWorkspace() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("updates");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部类别");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [sourceText, setSourceText] = useState("");
  const [changes, setChanges] = useState<DraftChange[]>([blankChange()]);
  const [questions, setQuestions] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (openId?: string) => {
    const response = await fetch("/api/growth", { cache: "no-store" });
    const payload = await response.json() as Snapshot & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "无法读取记录");
    setData(payload);
    const id = openId ?? new URLSearchParams(window.location.search).get("draft");
    if (id) {
      const found = payload.drafts.find((d) => d.id === id);
      if (found) {
        setDraftId(found.id); setRevision(found.revision); setSourceText(found.sourceText);
        setChanges(found.changes); setQuestions(found.questions); setDirty(false); setView("updates");
      }
    }
  }, []);

  useEffect(() => { load().catch((e: Error) => setError(e.message)); }, [load]);

  useEffect(() => {
    type Context = { registerTool: (tool: {
      name: string; title: string; description: string; inputSchema: object;
      annotations: { readOnlyHint: boolean }; execute: (input: unknown) => unknown;
    }, options: { signal: AbortSignal }) => void | Promise<void> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tool = {
      name: "stage_growth_update", title: "填写成长更新草稿",
      description: "在每日更新页面填写一条尚未保存的成长事项，留给本人核对。不会修改数据库。",
      inputSchema: { type: "object", properties: {
        sourceText: { type: "string" }, title: { type: "string" },
        category: { type: "string" }, status: { type: "string", enum: ["planned", "ongoing", "done"] },
      }, required: ["sourceText", "title"], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: (input: unknown) => {
        if (!input || typeof input !== "object") throw new Error("输入无效");
        const value = input as Record<string, unknown>;
        if (typeof value.sourceText !== "string" || !value.sourceText.trim() || typeof value.title !== "string" || !value.title.trim())
          throw new Error("请提供原始叙述和事项名称");
        const status = ["planned", "ongoing", "done"].includes(String(value.status)) ? value.status as GrowthStatus : "planned";
        setDraftId(null); setRevision(null); setSourceText(value.sourceText.slice(0, 10000));
        setChanges([{ kind: "create", clientKey: crypto.randomUUID(), fields: {
          ...blankFields(), title: value.title.slice(0, 120), category: String(value.category || "其他").slice(0, 40), status,
        } }]);
        setQuestions([]); setDirty(true); setView("updates");
        return { staged: true, message: "已填写到每日更新，请本人核对并保存草稿。" };
      },
    };
    try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* Unsupported browser. */ }
    return () => lifecycle.abort();
  }, []);

  const selectedDraft = data?.drafts.find((d) => d.id === draftId) ?? null;
  const selectedRecord = data?.records.find((r) => r.id === selectedRecordId) ?? null;
  const categories = useMemo(() => [...new Set([...DEFAULT_CATEGORIES, ...(data?.records.map((r) => r.category) ?? [])])], [data]);
  const pending = data?.drafts.filter((d) => d.status === "pending") ?? [];
  const list = useMemo(() => {
    const items = data?.records.filter((r) => r.status === view && (showArchived || !r.archived) &&
      (category === "全部类别" || r.category === category) &&
      (!query || [r.title, r.category, r.notes, r.outcome].some((part) => part.toLocaleLowerCase().includes(query.toLocaleLowerCase())))) ?? [];
    return items.sort((a, b) => view === "ongoing"
      ? (a.paused ? 1 : 0) - (b.paused ? 1 : 0) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999")
      : b.updatedAt.localeCompare(a.updatedAt));
  }, [data, view, showArchived, category, query]);

  const clearForm = () => {
    setDraftId(null); setRevision(null); setSourceText(""); setChanges([blankChange()]);
    setQuestions([]); setDirty(false); setMessage(""); setError("");
    window.history.replaceState(null, "", "/");
  };
  const chooseDraft = (draft: GrowthDraft) => {
    setDraftId(draft.id); setRevision(draft.revision); setSourceText(draft.sourceText);
    setChanges(draft.changes); setQuestions(draft.questions); setDirty(false);
    setView("updates"); setMessage(""); setError("");
    window.history.replaceState(null, "", `/?draft=${encodeURIComponent(draft.id)}`);
  };
  const startCorrection = (record: GrowthRecord, patch?: Partial<GrowthFields>) => {
    setDraftId(null); setRevision(null); setSourceText(`更正或更新「${record.title}」`);
    setChanges([{ kind: "update", recordId: record.id, baseVersion: record.version,
      fields: { title: record.title, level: record.level, category: record.category, status: record.status,
        parentId: record.parentId, notes: record.notes, outcome: record.outcome, links: record.links,
        startText: record.startText, dueDate: record.dueDate, completedText: record.completedText,
        paused: record.paused, archived: record.archived, ...patch } }]);
    setQuestions([]); setDirty(true); setView("updates"); setError(""); setMessage("");
    window.history.replaceState(null, "", "/");
  };
  const startProgress = (record: GrowthRecord) => {
    setDraftId(null); setRevision(null); setSourceText(`记录「${record.title}」的新进展`);
    setChanges([{ kind: "progress", recordId: record.id, baseVersion: record.version, progressText: "", occurredText: today() }]);
    setQuestions([]); setDirty(true); setView("updates"); setError(""); setMessage("");
  };
  const changeAt = (index: number, patch: Partial<DraftChange>) => {
    setChanges((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item)); setDirty(true);
  };
  const fieldAt = (index: number, field: keyof GrowthFields, value: unknown) => {
    setChanges((items) => items.map((item, i) => i === index
      ? { ...item, fields: { ...item.fields, [field]: value } } : item)); setDirty(true);
  };
  const request = async (path: string, body: unknown) => {
    if (!data) throw new Error("页面尚未准备好");
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "x-growth-token": data.browserToken }, body: JSON.stringify(body) });
    const payload = await response.json() as { error?: string; draft?: GrowthDraft; ok?: boolean };
    if (!response.ok) throw new Error(payload.error ?? "操作失败");
    return payload;
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const result = await request("/api/growth", { action: "saveDraft", id: draftId, expectedRevision: revision,
      sourceText, changes, questions });
    if (result.draft) {
      await load(result.draft.id); setMessage("草稿已保存。确认前，正式记录不会改变。");
      window.history.replaceState(null, "", `/?draft=${encodeURIComponent(result.draft.id)}`);
    }
  });
  const commit = () => run(async () => {
    if (!draftId || revision === null) return;
    await request("/api/growth", { action: "commitDraft", id: draftId, revision });
    clearForm(); await load(); setMessage("已确认，成长记录已更新。");
  });
  const cancel = () => run(async () => {
    if (!draftId || revision === null) return;
    await request("/api/growth", { action: "cancelDraft", id: draftId, revision });
    clearForm(); await load(); setMessage("草稿已取消。");
  });
  const restore = (file: File) => run(async () => {
    if (!data) return;
    const response = await fetch("/api/backup", { method: "POST", headers: { "Content-Type": "application/json", "x-growth-token": data.browserToken }, body: await file.text() });
    const payload = await response.json() as { error?: string };
    if (!response.ok) throw new Error(payload.error ?? "恢复失败");
    await load(); setMessage("备份已恢复。");
  });

  const completionSuggestions = data?.records.filter((r) => {
    if (r.archived || r.status === "done" || r.level === "step") return false;
    const children = data.records.filter((child) => child.parentId === r.id && !child.archived);
    return children.length > 0 && children.every((child) => child.status === "done");
  }) ?? [];

  return <SidebarProvider style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
    <Sidebar collapsible="offcanvas" className="growth-sidebar">
      <SidebarHeader className="brand-block"><span className="brand-mark"><FolderTree size={21} /></span><span><strong>个人成长平台</strong><small>我的成长档案</small></span></SidebarHeader>
      <SidebarContent className="nav-section"><p className="nav-caption">工作台</p><SidebarMenu>
        {(["updates", "done", "ongoing", "planned"] as View[]).map((key) => {
          const Icon = icons[key];
          const count = key === "updates" ? pending.length : data?.records.filter((r) => r.status === key && !r.archived).length ?? 0;
          return <SidebarMenuItem key={key}><SidebarMenuButton onClick={() => { setView(key); setSelectedRecordId(null); setError(""); }} isActive={view === key} className="growth-nav-button">
            <Icon size={18} /><span>{labels[key]}</span><em>{count}</em>
          </SidebarMenuButton></SidebarMenuItem>;
        })}
      </SidebarMenu></SidebarContent>
      <SidebarFooter className="nav-footer"><span className="footer-user">{data?.viewer ?? "个人空间"}</span><span>数据保存在云端</span></SidebarFooter>
    </Sidebar>
    <SidebarInset className="growth-main">
      <header className="topbar"><SidebarTrigger className="menu-trigger" aria-label="打开导航" /><div className="topbar-context">{labels[view]}<span> / {today()}</span></div><div className="topbar-status"><span className="status-dot" />私有空间</div></header>
      <div className="content-shell">
        {error && <div role="alert" className="feedback error">{error}<button onClick={() => setError("")} aria-label="关闭错误"><X size={16} /></button></div>}
        {message && <div role="status" className="feedback success">{message}<button onClick={() => setMessage("")} aria-label="关闭提示"><X size={16} /></button></div>}
        {!data ? <div className="loading-panel">正在读取成长记录…</div> : view === "updates"
          ? <>
            <div className="page-heading"><div><p className="eyebrow">记录与整理</p><h1>每日更新</h1><p>今天、过去和未来的事情，都可以从这里整理。</p></div><a className="chatgpt-link" href="https://chatgpt.com/" target="_blank" rel="noreferrer">打开 ChatGPT <ExternalLink size={16} /></a></div>
            <div className="update-grid">
              <section className="panel composer-panel"><div className="panel-heading"><div><h2>{draftId ? "核对更新草稿" : "写下新的更新"}</h2><p>{draftId ? "调整内容，保存草稿后再确认" : "手动补录或纠错；也可在 ChatGPT 中 @个人成长平台"}</p></div><Button variant="ghost" onClick={clearForm}>新草稿</Button></div>
                {selectedDraft && <div className="draft-source">来源：{selectedDraft.source === "chatgpt" ? "ChatGPT 整理" : "手动补录"} · 修订 {selectedDraft.revision}</div>}
                <label className="field-label">原始叙述<Textarea value={sourceText} onChange={(e) => { setSourceText(e.target.value); setDirty(true); }} placeholder="例如：去年完成了机器学习课程；目前在做文献综述，11月30日前完成初稿；以后想参加数据建模竞赛。" rows={4} /></label>
                <div className="changes-heading"><strong>拟变更内容</strong><Button variant="outline" size="sm" onClick={() => { setChanges((items) => [...items, blankChange()]); setDirty(true); }}><Plus size={15} /> 添加事项</Button></div>
                {changes.map((change, index) => {
                  const existing = data.records.find((r) => r.id === change.recordId);
                  const fields = { ...blankFields(), ...(existing ?? {}), ...(change.fields ?? {}) } as GrowthFields;
                  const parents = data.records.filter((r) => fields.level === "project" ? r.level === "goal" : r.level === "project");
                  return <div className="change-card" key={`${change.clientKey ?? change.recordId ?? "new"}-${index}`}>
                    <div className="change-card-head"><span>变更 {index + 1}</span><div className="inline-actions"><select value={change.kind} onChange={(e) => { const kind = e.target.value as DraftChange["kind"]; changeAt(index, kind === "create" ? { kind, clientKey: crypto.randomUUID(), recordId: undefined, baseVersion: undefined, fields: blankFields() } : { kind, clientKey: undefined, fields: kind === "progress" ? undefined : change.fields }); }} aria-label="变更类型"><option value="create">新事项</option><option value="update">修改事项</option><option value="progress">追加进展</option></select><button className="icon-button" onClick={() => { setChanges((items) => items.filter((_, i) => i !== index)); setDirty(true); }} aria-label={`移除变更 ${index + 1}`}><X size={16} /></button></div></div>
                    {change.kind !== "create" && <label className="field-label">已有事项<select value={change.recordId ?? ""} onChange={(e) => { const record = data.records.find((r) => r.id === e.target.value); changeAt(index, { recordId: record?.id, baseVersion: record?.version, fields: change.kind === "update" && record ? { ...record } : undefined }); }}><option value="">请选择事项</option>{data.records.map((record) => <option key={record.id} value={record.id}>{record.title} · {statusLabel(record.status)}</option>)}</select></label>}
                    {change.kind === "progress" ? <label className="field-label">进展内容<Textarea value={change.progressText ?? ""} onChange={(e) => changeAt(index, { progressText: e.target.value })} rows={3} placeholder="具体做了什么，有什么结果？" /></label> : <div className="editor-grid">
                      <label className="field-label wide">名称<Input value={fields.title} onChange={(e) => fieldAt(index, "title", e.target.value)} placeholder="课程、技能、项目或步骤名称" /></label>
                      <label className="field-label">层级<select value={fields.level} onChange={(e) => { fieldAt(index, "level", e.target.value); fieldAt(index, "parentId", null); }}><option value="goal">目标</option><option value="project">项目</option><option value="step">步骤 / 独立事项</option></select></label>
                      <label className="field-label">分区<select value={fields.status} onChange={(e) => { fieldAt(index, "status", e.target.value); if (e.target.value !== "ongoing") fieldAt(index, "paused", false); }}><option value="planned">待进行</option><option value="ongoing">进行中</option><option value="done">已完成</option></select></label>
                      <label className="field-label">类别<Input list="growth-categories" value={fields.category} onChange={(e) => fieldAt(index, "category", e.target.value)} /><datalist id="growth-categories">{categories.map((name) => <option key={name} value={name} />)}</datalist></label>
                      <label className="field-label">上级事项<select value={fields.parentId ?? ""} onChange={(e) => fieldAt(index, "parentId", e.target.value || null)} disabled={fields.level === "goal"}><option value="">无上级</option>{parents.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}{changes.filter((c) => c.kind === "create" && c.clientKey && c !== change).map((c) => <option key={c.clientKey} value={`temp:${c.clientKey}`}>本草稿新建：{c.fields?.title ?? "未命名"}</option>)}</select></label>
                      <label className="field-label">开始时间<Input value={fields.startText} onChange={(e) => fieldAt(index, "startText", e.target.value)} placeholder="如 2025 年春" /></label>
                      <label className="field-label">截止日期<Input type="date" value={fields.dueDate} onChange={(e) => fieldAt(index, "dueDate", e.target.value)} /></label>
                      <label className="field-label">完成时间<Input value={fields.completedText} onChange={(e) => fieldAt(index, "completedText", e.target.value)} placeholder="可填模糊时间" /></label>
                      <label className="field-label wide">详细笔记<Textarea value={fields.notes} onChange={(e) => fieldAt(index, "notes", e.target.value)} rows={2} placeholder="课程成绩、论文阶段等写在这里" /></label>
                      <label className="field-label wide">成果<Textarea value={fields.outcome} onChange={(e) => fieldAt(index, "outcome", e.target.value)} rows={2} /></label>
                      <label className="field-label wide">相关链接<Textarea value={fields.links.join("\n")} onChange={(e) => fieldAt(index, "links", e.target.value.split("\n").map((link) => link.trim()).filter(Boolean))} rows={2} placeholder="每行一个 http 或 https 链接" /></label>
                      <label className="check-label"><input type="checkbox" checked={fields.paused} disabled={fields.status !== "ongoing"} onChange={(e) => fieldAt(index, "paused", e.target.checked)} /> 已暂停</label>
                      <label className="check-label"><input type="checkbox" checked={fields.archived} onChange={(e) => fieldAt(index, "archived", e.target.checked)} /> 已放弃 / 归档</label>
                    </div>}
                    <label className="field-label">事情发生时间<Input value={change.occurredText ?? ""} onChange={(e) => changeAt(index, { occurredText: e.target.value })} placeholder="如 2025 年春；留空则不指定" /></label>
                  </div>;
                })}
                <label className="field-label">仍需澄清的问题<Textarea value={questions.join("\n")} onChange={(e) => { setQuestions(e.target.value.split("\n").filter(Boolean)); setDirty(true); }} rows={questions.length ? 2 : 1} placeholder="如有疑问，每行一条；解决后删去问题再保存" /></label>
                <div className="composer-actions"><Button disabled={busy || changes.length === 0} onClick={save}>{busy ? "处理中…" : draftId ? "保存修改" : "保存草稿"}</Button><Button variant="outline" disabled={busy || !draftId || dirty || questions.length > 0 || selectedDraft?.status !== "pending"} onClick={commit}>确认写入记录</Button>{draftId && selectedDraft?.status === "pending" && <Button variant="ghost" disabled={busy} onClick={cancel}>取消草稿</Button>}</div>
                {dirty && draftId && <p className="helper-text">内容已改动，请先保存草稿。</p>}
              </section>
              <aside className="right-stack"><section className="panel"><div className="panel-heading"><h2>待确认 <span className="count-badge">{pending.length}</span></h2></div>{pending.length ? <div className="pending-list">{pending.map((draft) => <button key={draft.id} className={`pending-item ${draftId === draft.id ? "active" : ""}`} onClick={() => chooseDraft(draft)}><strong>{draft.sourceText.slice(0, 54)}</strong><span>{draft.source === "chatgpt" ? "ChatGPT 整理" : "手动补录"} · {new Date(draft.updatedAt).toLocaleDateString("zh-CN")}</span></button>)}</div> : <Empty className="compact-empty"><EmptyHeader><EmptyTitle>暂无待确认内容</EmptyTitle><EmptyDescription>在 ChatGPT 描述情况，或直接从左侧补录。</EmptyDescription></EmptyHeader></Empty>}</section>
                {completionSuggestions.length > 0 && <section className="panel suggestion-panel"><h2>可检查的完成建议</h2>{completionSuggestions.map((record) => <button key={record.id} className="suggestion-row" onClick={() => startCorrection(record, { status: "done", paused: false })}>「{record.title}」的已列步骤均完成，检查是否也要标为已完成</button>)}</section>}
                <section className="panel history-panel"><div className="panel-heading"><h2>最近更新</h2><History size={18} /></div>{data.history.length ? data.history.slice(0, 8).map((item) => <div className="history-row" key={item.id}><span>{data.records.find((r) => r.id === item.recordId)?.title ?? "已归档事项"}</span><small>{item.occurredText || new Date(item.createdAt).toLocaleDateString("zh-CN")} · {item.action === "create" ? "新建" : item.action === "progress" ? "进展" : "更正"}</small></div>) : <p className="muted-copy">确认后的更新会显示在这里。</p>}</section>
                <section className="panel backup-panel"><h2>数据备份</h2><p>下载包含事项、草稿和历史的完整备份。建议每周保存一次。</p><a className="backup-link" href="/api/backup"><Download size={16} /> 下载 JSON 备份</a>{data.records.length === 0 && data.drafts.length === 0 && data.history.length === 0 && <label className="restore-link"><Upload size={16} /> 恢复到空数据库<input type="file" accept="application/json,.json" onChange={(e) => { const file = e.target.files?.[0]; if (file) restore(file); }} /></label>}</section>
              </aside>
            </div>
          </>
          : <><div className="page-heading"><div><p className="eyebrow">成长档案</p><h1>{labels[view]}</h1><p>{view === "ongoing" ? "关注当前进展与截止时间。" : view === "done" ? "回看已经取得的成果。" : "整理还未开始的方向和计划。"}</p></div><Button variant="outline" onClick={() => { clearForm(); setView("updates"); }}>去每日更新 <Plus size={16} /></Button></div>
            <div className="filter-bar"><div className="search-box"><Search size={17} /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称、笔记和成果" aria-label="搜索事项" /></div><select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="按类别筛选"><option>全部类别</option>{categories.map((c) => <option key={c}>{c}</option>)}</select><label className="check-label archived-filter"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />显示归档</label></div>
            <div className="records-layout"><section className="record-list">{list.length ? list.map((record) => {
              const parent = data.records.find((r) => r.id === record.parentId);
              const progress = findProgress(record, data.history);
              return <button key={record.id} className={`record-card ${selectedRecordId === record.id ? "selected" : ""}`} onClick={() => setSelectedRecordId(record.id)}><div className="record-top"><span className="category-pill">{record.category}</span><span className="record-level">{levelLabel(record.level)}</span></div><h2>{record.title}</h2>{parent && <p className="parent-line">属于：{parent.title}</p>}{progress && <p className="progress-line">最近进展：{progress}</p>}<div className="record-bottom"><span>{view === "ongoing" ? dueLabel(record, today()) : record.archived ? "已归档" : record.completedText || record.startText || statusLabel(record.status)}</span><span>查看详情</span></div></button>;
            }) : <Empty className="list-empty"><EmptyHeader><EmptyTitle>这里还没有事项</EmptyTitle><EmptyDescription>从“每日更新”记录，或调整筛选条件。</EmptyDescription></EmptyHeader></Empty>}</section>
              <aside className="panel detail-panel">{selectedRecord && selectedRecord.status === view ? <><div className="detail-head"><span className="category-pill">{selectedRecord.category}</span><span>{levelLabel(selectedRecord.level)}</span></div><h2>{selectedRecord.title}</h2><p className="detail-status">{statusLabel(selectedRecord.status)}{selectedRecord.paused ? " · 已暂停" : ""}{selectedRecord.archived ? " · 已归档" : ""}</p><dl className="detail-grid"><dt>上级事项</dt><dd>{data.records.find((r) => r.id === selectedRecord.parentId)?.title ?? "无"}</dd><dt>开始时间</dt><dd>{selectedRecord.startText || "未记录"}</dd><dt>截止时间</dt><dd>{selectedRecord.dueDate || "未设截止日期"}</dd><dt>完成时间</dt><dd>{selectedRecord.completedText || "未记录"}</dd></dl>{selectedRecord.notes && <div className="detail-block"><h3>详细笔记</h3><p>{selectedRecord.notes}</p></div>}{selectedRecord.outcome && <div className="detail-block"><h3>成果</h3><p>{selectedRecord.outcome}</p></div>}{selectedRecord.links.length > 0 && <div className="detail-block"><h3>相关链接</h3>{selectedRecord.links.map((link) => <a key={link} href={link} target="_blank" rel="noreferrer">{link}<ExternalLink size={14} /></a>)}</div>}<div className="detail-block"><h3>更新记录</h3>{data.history.filter((item) => item.recordId === selectedRecord.id).slice(0, 8).map((item) => <p className="detail-history" key={item.id}>{item.occurredText || new Date(item.createdAt).toLocaleDateString("zh-CN")} · {item.action === "progress" ? (() => { try { return String((JSON.parse(item.afterJson) as { progressText?: string }).progressText ?? "新增进展"); } catch { return "新增进展"; } })() : item.action === "create" ? "创建事项" : "更新事项"}</p>)}</div><div className="detail-actions"><Button onClick={() => startCorrection(selectedRecord)}>去每日更新更正</Button><Button variant="outline" onClick={() => startProgress(selectedRecord)}>记录进展</Button></div></> : <div className="detail-empty"><FolderTree size={34} /><h2>选择一条事项</h2><p>在这里查看关联、成果和更新历史。</p></div>}</aside>
            </div>
          </>}
      </div>
    </SidebarInset>
  </SidebarProvider>;
}
