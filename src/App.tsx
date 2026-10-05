import { useCallback, useEffect, useMemo, useState } from 'react';

type Section = 'daily' | 'completed' | 'in_progress' | 'planned' | 'settings';
type Item = { id: string; title: string; category?: string; status: string; description: string; priority: number; started_on?: string | null; due_on?: string | null; completed_on?: string | null; progress_percent?: number | null; progress_note?: string; progress_source?: 'user_reported' | 'ai_estimate' | null; progress_updated_at?: string | null; next_action?: string; link?: string; goalTitle?: string | null; canUndo?: boolean; lastAction?: string; archived_at?: string | null };
type Task = { id: string; title: string; estimate_minutes: number; actual_minutes?: number | null; priority: number; completion_criteria: string; item_id?: string | null; itemTitle?: string | null; status: string };
type DailySuggestion = { id?: string; title: string; estimateMinutes: number; priority: number; completionCriteria: string; itemId: string | null };
type GrowthSuggestion = { id: string | null; op: string; title: string; category: string; status: string; description: string; priority: number; startedOn: string | null; dueOn: string | null; completedOn: string | null; progressPercent: number | null; progressNote: string; progressSource: 'user_reported' | 'ai_estimate' | null; nextAction: string; link: string; goalTitle: string };
type Draft = { id: string; section: string; rawInput: string; proposal: { clarification: string; tasks?: DailySuggestion[]; suggestions?: GrowthSuggestion[] } };
type AppState = { date: string; plan: { budget_minutes: number }; tasks: Task[]; items: Item[]; archivedItems: Item[]; categories: { id: string; name: string }[]; goals: { id: string; title: string }[]; pendingDrafts: { id: string }[] };
type LoginPrompt = { id: string; type: 'text' | 'select' | 'secret' | 'manual_code'; message: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] };
type LoginSnapshot = { attemptId: string | null; phase: 'idle' | 'starting' | 'waiting' | 'exchanging' | 'saving' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'; authUrl?: string; instructions?: string; message?: string; error?: string; prompt?: LoginPrompt; expiresAt?: number };
type AiState = { configured: boolean; login: LoginSnapshot; provider: string; selectedModel: string; models: { id: string; name: string }[]; network?: { source: string; httpProxy: boolean; httpsProxy: boolean; ready: boolean; error?: string } };

const blankState: AppState = { date: new Date().toLocaleDateString('en-CA'), plan: { budget_minutes: 720 }, tasks: [], items: [], archivedItems: [], categories: [], goals: [], pendingDrafts: [] };
const nav: { id: Section; icon: string; label: string }[] = [
  { id: 'daily', icon: '◷', label: '每日任务' }, { id: 'completed', icon: '✓', label: '已完成' },
  { id: 'in_progress', icon: '↗', label: '进行中' }, { id: 'planned', icon: '✳', label: '待进行' },
];
const fmtHours = (minutes: number) => `${Math.floor(minutes / 60)}小时${minutes % 60 ? ` ${minutes % 60}分` : ''}`;
const fmtDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...options?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? '请求失败，请稍后再试。');
  return data as T;
}

export default function App() {
  const [section, setSection] = useState<Section>('daily');
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }));
  const [data, setData] = useState<AppState>(blankState);
  const [ai, setAi] = useState<AiState | null>(null);
  const [login, setLogin] = useState<LoginSnapshot>({ attemptId: null, phase: 'idle' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [input, setInput] = useState('');
  const [promptAnswer, setPromptAnswer] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addTask, setAddTask] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMinutes, setNewMinutes] = useState(60);
  const [testResult, setTestResult] = useState('');

  const refresh = useCallback(async (targetDate = date) => {
    try { setData(await api<AppState>(`/api/state?date=${encodeURIComponent(targetDate)}`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : '无法连接本机服务。'); }
    finally { setLoading(false); }
  }, [date]);
  const refreshAi = useCallback(async () => { try { const status = await api<AiState>('/api/ai/status'); setAi(status); setLogin(status.login); } catch { /* show via main status */ } }, []);
  useEffect(() => { void refresh(date); void refreshAi(); }, [date, refresh, refreshAi]);

  const loginActive = ['starting', 'waiting', 'exchanging', 'saving'].includes(login.phase);
  useEffect(() => {
    if (section !== 'settings' || !loginActive) return;
    void refreshAi();
    const timer = window.setInterval(() => { void refreshAi(); }, 700);
    return () => window.clearInterval(timer);
  }, [section, loginActive, refreshAi]);

  useEffect(() => {
    if (section !== 'in_progress') return;
    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void refresh(date);
    };
    if (document.visibilityState === 'visible') void refresh(date);
    const timer = window.setInterval(refreshWhenActive, 30_000);
    window.addEventListener('focus', refreshWhenActive);
    document.addEventListener('visibilitychange', refreshWhenActive);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshWhenActive); document.removeEventListener('visibilitychange', refreshWhenActive); };
  }, [section, date, refresh]);

  const dailyTasks = data.tasks.filter((task) => task.status !== 'cancelled');
  const openTasks = dailyTasks.filter((task) => task.status === 'open');
  const doneTasks = dailyTasks.filter((task) => task.status === 'done');
  const plannedMinutes = openTasks.reduce((sum, task) => sum + task.estimate_minutes, 0);
  const usedMinutes = doneTasks.reduce((sum, task) => sum + (task.actual_minutes ?? task.estimate_minutes), 0);
  const overBudget = plannedMinutes > data.plan.budget_minutes;
  const activeSection = section === 'settings' ? '模型配置' : nav.find((item) => item.id === section)?.label ?? '每日任务';
  const visibleItems = useMemo(() => section === 'daily' || section === 'settings' ? [] : data.items.filter((item) => item.status === section), [data.items, section]);

  const propose = async () => {
    if (!input.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ draft: Draft }>('/api/ai/propose', { method: 'POST', body: JSON.stringify({ section: section === 'daily' ? 'daily' : section, date, input }) });
      setDraft(result.draft); setInput('');
    } catch (e) { setError(e instanceof Error ? e.message : 'AI 整理失败。'); }
    finally { setBusy(false); }
  };

  const proposeReplan = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<{ draft: Draft }>('/api/ai/propose', { method: 'POST', body: JSON.stringify({ section: 'daily_replan', date, input: input.trim() || '请在保留所有任务的前提下压缩到当天预算以内。' }) });
      setDraft(result.draft);
    } catch (e) { setError(e instanceof Error ? e.message : 'AI 调整失败。'); }
    finally { setBusy(false); }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = draft.section === 'daily' ? { date, tasks: draft.proposal.tasks } : { suggestions: draft.proposal.suggestions };
      const result = await api<{ applied?: number; dismissed?: boolean }>(`/api/drafts/${draft.id}/apply`, { method: 'POST', body: JSON.stringify(body) });
      setDraft(null); setNotice(result.dismissed ? '已忽略这条建议。' : `已确认并保存 ${result.applied ?? 0} 项。`); await refresh(date);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试。'); }
    finally { setBusy(false); }
  };

  const dismissDraft = async () => {
    if (!draft) return;
    try { await api(`/api/drafts/${draft.id}/apply`, { method: 'POST', body: JSON.stringify({ accepted: false }) }); setDraft(null); await refresh(date); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); }
  };

  const updateBudget = async (hours: number) => {
    try {
      await api(`/api/plan/${date}`, { method: 'PATCH', body: JSON.stringify({ budgetMinutes: hours * 60 }) });
      await refresh(date);
    } catch (e) { setError(e instanceof Error ? e.message : '预算更新失败。'); }
  };

  const createTask = async () => {
    if (!newTitle.trim()) return;
    try {
      await api('/api/tasks', { method: 'POST', body: JSON.stringify({ date, title: newTitle.trim(), estimateMinutes: newMinutes, priority: 2, completionCriteria: '', itemId: null }) });
      setNewTitle(''); setAddTask(false); await refresh(date);
    } catch (e) { setError(e instanceof Error ? e.message : '任务添加失败。'); }
  };

  const toggleTask = async (task: Task) => {
    let actualMinutes = task.actual_minutes;
    if (task.status === 'open') {
      const answer = window.prompt('记录实际投入分钟数（可留空，默认使用预计用时）：', String(task.estimate_minutes));
      if (answer === null) return;
      actualMinutes = answer.trim() ? Number(answer) : null;
      if (actualMinutes !== null && (!Number.isInteger(actualMinutes) || actualMinutes < 0)) { setError('实际用时请输入 0 或更大的整数分钟。'); return; }
    }
    try { await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: task.status === 'done' ? 'open' : 'done', actualMinutes }) }); await refresh(date); }
    catch (e) { setError(e instanceof Error ? e.message : '任务更新失败。'); }
  };

  const editTask = async (task: Task) => {
    const title = window.prompt('任务名称', task.title);
    if (title === null || !title.trim()) return;
    const minutesText = window.prompt('预计投入分钟', String(task.estimate_minutes));
    if (minutesText === null) return;
    const estimateMinutes = Number(minutesText);
    if (!Number.isInteger(estimateMinutes) || estimateMinutes < 5 || estimateMinutes > 720) { setError('预计用时请输入 5 到 720 的整数分钟。'); return; }
    try { await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim(), estimateMinutes }) }); await refresh(date); }
    catch (e) { setError(e instanceof Error ? e.message : '任务修改失败。'); }
  };

  const cancelTask = async (task: Task) => {
    if (!window.confirm(`将「${task.title}」移至已取消任务？`)) return;
    try { await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) }); await refresh(date); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); }
  };

  const undoItem = async (item: Item) => {
    if (!window.confirm(item.lastAction === 'created' ? `撤销新增「${item.title}」？这条记录会移入归档。` : `撤销「${item.title}」最近一次变更？`)) return;
    try { await api(`/api/items/${item.id}/undo`, { method: 'POST', body: '{}' }); await refresh(date); setNotice('已撤销最近一次变更。'); }
    catch (e) { setError(e instanceof Error ? e.message : '无法撤销该变更。'); }
  };

  const startLogin = async () => {
    if (loginActive) return;
    setError(''); setPromptAnswer(''); setLogin({ attemptId: null, phase: 'starting', message: '正在启动授权…' });
    try { const result = await api<{ login: LoginSnapshot }>('/api/ai/login', { method: 'POST', body: '{}' }); setLogin(result.login); await refreshAi(); }
    catch (e) { setLogin({ attemptId: null, phase: 'failed', error: e instanceof Error ? e.message : '无法启动授权，请重试。' }); }
  };

  const sendAuthAnswer = async () => {
    if (!login.attemptId || !login.prompt?.id) return;
    try { await api('/api/ai/reply', { method: 'POST', body: JSON.stringify({ attemptId: login.attemptId, promptId: login.prompt.id, value: promptAnswer }) }); setPromptAnswer(''); setLogin({ ...login, phase: 'exchanging', prompt: undefined, message: '正在处理授权信息…' }); }
    catch (e) { setLogin({ ...login, error: e instanceof Error ? e.message : '授权输入已失效，请重新开始。' }); }
  };

  const cancelLogin = async () => {
    if (!login.attemptId) return;
    try { const result = await api<{ login: LoginSnapshot }>('/api/ai/cancel', { method: 'POST', body: JSON.stringify({ attemptId: login.attemptId }) }); setLogin(result.login); }
    catch (e) { setLogin({ ...login, error: e instanceof Error ? e.message : '取消授权失败，请重试。' }); }
  };

  const downloadBackup = async () => {
    const response = await fetch('/api/backup');
    if (!response.ok) { setError('创建备份失败。'); return; }
    const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'personal-growth-backup.json'; anchor.click(); URL.revokeObjectURL(url);
  };

  const restoreBackup = async (file?: File) => {
    if (!file) return;
    if (!window.confirm('恢复备份会替换这台电脑上现有的成长记录，确定继续吗？')) return;
    try { const backup = JSON.parse(await file.text()); await api('/api/backup/restore', { method: 'POST', body: JSON.stringify({ backup }) }); await refresh(date); setNotice('备份已恢复。'); }
    catch (e) { setError(e instanceof Error ? e.message : '备份恢复失败，现有记录未更改。'); }
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span>昭</span></div><div><strong>昭濂</strong><small>个人成长平台</small></div></div>
      <div className="side-caption">成长空间</div>
      <nav className="side-nav" aria-label="主导航">{nav.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => { setSection(item.id); setDraft(null); setError(''); }}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id !== 'daily' && <span className="nav-count">{data.items.filter((entry) => entry.status === item.id).length}</span>}</button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-note"><span className="note-spark">✦</span><p>每天前进一步<br /><b>也算在成长</b></p></div>
      <button className={`nav-item settings-nav ${section === 'settings' ? 'active' : ''}`} onClick={() => { setSection('settings'); setDraft(null); }}><span className="nav-icon">⚙</span><span>设置</span><span className={`connection-dot ${ai?.configured ? 'online' : ''}`} /></button>
      <div className="local-label"><span className="local-dot" />数据仅保存在这台电脑</div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>昭濂个人成长平台</span><span className="crumb-sep">/</span><strong>{activeSection}</strong></div><div className="topbar-right">{section !== 'settings' && <label className="date-control"><span>▦</span><input aria-label="选择日期" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}<button className="avatar" title="本地个人空间">昭</button></div></header>
      <div className="page-content">
        {error && <div className="toast error-toast" role="alert"><span>!</span>{error}<button onClick={() => setError('')}>×</button></div>}
        {notice && <div className="toast success-toast" role="status"><span>✓</span>{notice}<button onClick={() => setNotice('')}>×</button></div>}
        {loading ? <div className="loading-state"><span className="spinner" />正在打开你的成长空间…</div> : section === 'settings' ? <SettingsPanel ai={ai} login={login} loginActive={loginActive} promptAnswer={promptAnswer} setPromptAnswer={setPromptAnswer} startLogin={startLogin} sendAuthAnswer={sendAuthAnswer} cancelLogin={cancelLogin} setAi={setAi} refreshAi={refreshAi} downloadBackup={downloadBackup} restoreBackup={restoreBackup} setTestResult={setTestResult} testResult={testResult} /> : section === 'daily' ? <DailyPanel date={date} data={data} dailyTasks={dailyTasks} openTasks={openTasks} doneTasks={doneTasks} plannedMinutes={plannedMinutes} usedMinutes={usedMinutes} overBudget={overBudget} input={input} setInput={setInput} propose={propose} proposeReplan={proposeReplan} busy={busy} addTask={addTask} setAddTask={setAddTask} newTitle={newTitle} setNewTitle={setNewTitle} newMinutes={newMinutes} setNewMinutes={setNewMinutes} createTask={createTask} updateBudget={updateBudget} toggleTask={toggleTask} editTask={editTask} cancelTask={cancelTask} /> : <GrowthPanel section={section} items={visibleItems} input={input} setInput={setInput} propose={propose} busy={busy} onUndo={undoItem} />}
      </div>
      {draft && <DraftModal draft={draft} setDraft={setDraft} onConfirm={saveDraft} onDismiss={dismissDraft} busy={busy} categories={data.categories.map((entry) => entry.name)} items={[...data.items, ...data.archivedItems]} />}
    </main>
  </div>;
}

function PageHeading({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle: string; right?: React.ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{right}</div>;
}

function AiComposer({ value, setValue, onSubmit, busy, title, placeholder }: { value: string; setValue: (value: string) => void; onSubmit: () => void; busy: boolean; title: string; placeholder: string }) {
  return <section className="ai-composer"><div className="composer-top"><span className="ai-spark">✦</span><div><strong>{title}</strong><small>AI 会先整理成建议，由你确认后保存</small></div><span className="powered-tag">AI 助手</span></div><div className="composer-input"><textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} rows={3} /><div className="composer-footer"><span>写下进展、计划，或需要修正的信息</span><button className="primary-button" onClick={onSubmit} disabled={busy || !value.trim()}>{busy ? <><span className="button-spinner" />正在整理</> : <>✦ 整理建议 <span>↗</span></>}</button></div></div></section>;
}

function DailyPanel(props: {
  date: string; data: AppState; dailyTasks: Task[]; openTasks: Task[]; doneTasks: Task[]; plannedMinutes: number; usedMinutes: number; overBudget: boolean;
  input: string; setInput: (value: string) => void; propose: () => void; proposeReplan: () => void; busy: boolean; addTask: boolean; setAddTask: (value: boolean) => void;
  newTitle: string; setNewTitle: (value: string) => void; newMinutes: number; setNewMinutes: (value: number) => void; createTask: () => void;
  updateBudget: (hours: number) => void; toggleTask: (task: Task) => void; editTask: (task: Task) => void; cancelTask: (task: Task) => void;
}) {
  const { data, date, openTasks, doneTasks, plannedMinutes, usedMinutes, overBudget } = props;
  const progress = data.plan.budget_minutes ? Math.min(100, Math.round(usedMinutes / data.plan.budget_minutes * 100)) : 0;
  return <>
    <PageHeading eyebrow="YOUR DAILY RHYTHM · {12 HOURS} DAILY BUDGET" title="每日任务" subtitle={`${fmtDate(date)} · 把重要的事，一件一件做好。`} right={<button className="outline-button" onClick={() => props.setAddTask(true)}>＋ 手动添加</button>} />
    <div className="daily-overview">
      <div className="budget-card"><div className="budget-orbit orbit-one"/><div className="budget-orbit orbit-two"/><div className="budget-content"><div className="budget-label">今日时间预算 <span className="budget-info" title="休息时间不计入任务预算">i</span></div><div className="budget-value"><strong>{fmtHours(data.plan.budget_minutes)}</strong><label><select aria-label="调整每日预算" value={Math.round(data.plan.budget_minutes / 60)} onChange={(e) => props.updateBudget(Number(e.target.value))}>{Array.from({ length: 12 }, (_, index) => 12 - index).map((hours) => <option value={hours} key={hours}>{hours} 小时</option>)}</select><span>⌄</span></label></div><div className="budget-hint">默认 12 小时 · 可按当天情况调整</div><div className="budget-track"><span style={{ width: `${progress}%` }} /></div><div className="budget-stats"><span><b>{fmtHours(usedMinutes)}</b>已投入</span><span><b>{fmtHours(plannedMinutes)}</b>待完成</span></div></div><div className="budget-art" aria-hidden="true"><div className="art-sun"/><div className="art-hill hill-back"/><div className="art-hill hill-front"/><div className="art-star star-a">✦</div><div className="art-star star-b">✦</div></div></div>
      <div className="mini-stats"><div className="mini-stat"><span className="stat-icon pale-blue">◷</span><div><small>计划任务</small><strong>{openTasks.length + doneTasks.length}<em> 项</em></strong></div><span className="stat-arrow">↗</span></div><div className="mini-stat"><span className="stat-icon pale-green">✓</span><div><small>已经完成</small><strong>{doneTasks.length}<em> 项</em></strong></div><span className="stat-arrow">↗</span></div><div className="mini-stat"><span className="stat-icon pale-lilac">⚑</span><div><small>实际投入</small><strong>{fmtHours(usedMinutes)}</strong></div><span className="stat-arrow">↗</span></div></div>
    </div>
    {overBudget && <div className="budget-warning"><span>!</span><div><strong>待完成任务超出当天预算 {fmtHours(plannedMinutes - data.plan.budget_minutes)}</strong><small>现有任务已保留。AI 只会建议缩短预计时长，确认后才会应用。</small></div><button className="outline-button" disabled={props.busy} onClick={props.proposeReplan}>{props.busy ? '正在整理…' : '✦ 建议缩减'}</button></div>}
    <div className="daily-section-heading"><div><h2>今天要做的事</h2><p>完成后打勾，记录实际投入时间</p></div><span className="task-count-pill">{doneTasks.length} / {openTasks.length + doneTasks.length} 完成</span></div>
    <div className="task-list">{props.dailyTasks.length === 0 ? <div className="empty-state task-empty"><div className="empty-illustration"><span>✧</span><span>◷</span><span>✦</span></div><strong>今天还没有任务</strong><p>告诉 AI 你今天想推进的事情，或者手动添加一项任务。</p><button className="text-button" onClick={() => document.querySelector<HTMLTextAreaElement>('.ai-composer textarea')?.focus()}>开始安排今天 →</button></div> : props.dailyTasks.map((task) => <article className={`task-row ${task.status === 'done' ? 'task-done' : ''}`} key={task.id}><button className={`task-check ${task.status === 'done' ? 'checked' : ''}`} aria-label={task.status === 'done' ? '标记未完成' : '标记已完成'} onClick={() => props.toggleTask(task)}>{task.status === 'done' ? '✓' : ''}</button><div className="task-main"><div className="task-title-line"><strong>{task.title}</strong>{task.priority === 1 && <span className="priority-tag">优先</span>}</div><div className="task-meta">{task.completion_criteria && <span>{task.completion_criteria}</span>}{task.itemTitle && <span className="linked-item">↗ {task.itemTitle}</span>}</div></div><div className="task-time"><span>◷ {fmtHours(task.estimate_minutes)}</span>{task.actual_minutes != null && <small>实际 {fmtHours(task.actual_minutes)}</small>}</div>{task.status === 'open' && <div className="task-actions"><button className="icon-button" aria-label="编辑任务" title="编辑任务" onClick={() => props.editTask(task)}>✎</button><button className="icon-button cancel-task" aria-label="取消任务" title="取消任务" onClick={() => props.cancelTask(task)}>···</button></div>}</article>)}</div>
    {props.addTask && <div className="inline-add"><input autoFocus value={props.newTitle} onChange={(e) => props.setNewTitle(e.target.value)} placeholder="例如：完成论文实验记录" onKeyDown={(e) => e.key === 'Enter' && props.createTask()} /><label>预计 <input type="number" min={5} max={720} value={props.newMinutes} onChange={(e) => props.setNewMinutes(Number(e.target.value))} /> 分钟</label><button className="primary-button" onClick={props.createTask}>添加任务</button><button className="icon-button" onClick={() => props.setAddTask(false)}>×</button></div>}
    <AiComposer value={props.input} setValue={props.setInput} onSubmit={props.propose} busy={props.busy} title="让 AI 帮你安排今天" placeholder="例如：上午想先做实验，下午有两小时课程复习，论文今天要完成一部分……" />
  </>;
}

function GrowthPanel({ section, items, input, setInput, propose, busy, onUndo }: { section: Section; items: Item[]; input: string; setInput: (value: string) => void; propose: () => void; busy: boolean; onUndo: (item: Item) => void }) {
  const [categoryFilter, setCategoryFilter] = useState('全部分类');
  const details = section === 'completed' ? { title: '已完成', eyebrow: 'MILESTONES & ACHIEVEMENTS', subtitle: '每一段走过的路，都值得被好好记下。', prompt: '告诉 AI 你完成了什么，或想修正哪段经历。', placeholder: '例如：2025 年秋季学期完成了高等数学，成绩 92 分；上个月参加了校级数学建模竞赛并获得二等奖。', empty: '完成的课程、技能和经历都会在这里留下印记。' } : section === 'in_progress' ? { title: '进行中', eyebrow: 'IN MOTION · KEEP GOING', subtitle: '正在投入的努力，会慢慢长成成果。', prompt: '告诉 AI 你最近的进展', placeholder: '例如：正在做毕业论文的实验部分，预计 6 月 15 日前完成；本周做了三组对照实验，下一步整理数据。', empty: '记下目前在推进的学习、科研和工作。' } : { title: '待进行', eyebrow: 'UP NEXT · MAKE IT REAL', subtitle: '把未来想做的事放在这里，等你准备好就出发。', prompt: '告诉 AI 你接下来的计划', placeholder: '例如：希望暑假开始系统学习 Python；打算申请明年的暑期科研项目，启动时间大约在 3 月。', empty: '先把想做的事情放进来，之后再逐步安排。' };
  const categories = Array.from(new Set(items.map((item) => item.category ?? '其他')));
  const visible = categoryFilter === '全部分类' ? items : items.filter((item) => (item.category ?? '其他') === categoryFilter);
  return <><PageHeading eyebrow={details.eyebrow} title={details.title} subtitle={details.subtitle} right={<span className="section-total"><strong>{items.length}</strong><span>项记录</span></span>} /><AiComposer value={input} setValue={setInput} onSubmit={propose} busy={busy} title={details.prompt} placeholder={details.placeholder} /><div className="growth-section-heading"><div><h2>{details.title}记录</h2><p>通过上方 AI 输入区整理、修正或变更状态</p></div><label className="filter-select"><select aria-label="按分类筛选" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}><option>全部分类</option>{categories.map((category) => <option key={category}>{category}</option>)}</select><span>⌄</span></label></div><div className="growth-grid">{items.length === 0 ? <div className="empty-state growth-empty"><div className="growth-empty-icon">✦</div><strong>这里还没有记录</strong><p>{details.empty}</p><span>从上方输入一段内容，AI 会帮你整理</span></div> : visible.length === 0 ? <div className="empty-state growth-empty"><strong>这个分类还没有记录</strong><p>试试其他分类。</p></div> : visible.map((item) => <GrowthCard key={item.id} item={item} onUndo={() => onUndo(item)} />)}</div></>;
}

function GrowthCard({ item, onUndo }: { item: Item; onUndo: () => void }) {
  const date = item.status === 'completed' ? item.completed_on : item.due_on;
  const dateLabel = item.status === 'completed' ? '完成于' : '截止';
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { if (item.status !== 'in_progress') return; const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer); }, [item.status]);
  const deadline = item.due_on ? new Date(`${item.due_on}T23:59:59+08:00`).getTime() : null;
  const remaining = deadline === null ? null : deadline - clock;
  const countdown = remaining === null ? '截止日期待补充' : remaining < 0 ? `已逾期 ${formatRemaining(-remaining)}` : remaining < 24 * 60 * 60_000 ? `今天截止 · 剩余 ${formatRemaining(remaining)}` : `剩余 ${formatRemaining(remaining)}`;
  return <article className="growth-card"><div className="growth-card-top"><span className={`category-badge category-${item.category === '科研' ? 'research' : item.category === '课程' ? 'course' : item.category === '技能' ? 'skill' : 'other'}`}>{item.category ?? '其他'}</span><div className="card-actions">{item.canUndo && <button className="undo-button" onClick={onUndo}>↶ {item.lastAction === 'created' ? '撤销新增' : '撤销修改'}</button>}<span className="priority-dots" title={`优先级 ${item.priority}`}>{[1,2,3].map((n) => <i key={n} className={n >= item.priority ? 'filled' : ''} />)}</span></div></div><h3>{item.title}</h3>{item.description && <p className="growth-description">{item.description}</p>}{item.status === 'in_progress' && <div className="item-progress-panel"><div className="item-deadline"><span>截止日期</span><strong>{item.due_on ?? '待补充'}</strong><b className={remaining !== null && remaining < 0 ? 'deadline-overdue' : remaining !== null && remaining < 24 * 60 * 60_000 ? 'deadline-urgent' : ''}>{countdown}</b></div><div className="progress-label"><span>实时进度</span><strong>{item.progress_percent == null ? '待补充' : `${item.progress_percent}%`}</strong></div><div className="item-progress-track"><span style={{ width: `${item.progress_percent ?? 0}%` }} /></div>{item.progress_note && <p className="progress-note">{item.progress_note}</p>}<div className="progress-footnote"><span>{item.progress_source === 'ai_estimate' ? 'AI 估算 · 已确认' : item.progress_source === 'user_reported' ? '本人更新' : '来源待补充'}</span>{item.progress_updated_at && <time>更新于 {new Date(item.progress_updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</div></div>}{item.next_action && item.status === 'in_progress' && <div className="next-action"><span>下一步</span><span>{item.next_action}</span></div>}{item.status === 'in_progress' && !item.next_action && <div className="next-action"><span>下一步</span><span>待补充</span></div>}<div className="growth-card-footer"><div className="growth-card-dates">{item.status !== 'in_progress' && date && <span>▦ {dateLabel} {date}</span>}{item.started_on && item.status !== 'completed' && <span>开始于 {item.started_on}</span>}</div>{item.goalTitle && <span className="goal-chip">◎ {item.goalTitle}</span>}{item.link && <a href={item.link} target="_blank" rel="noreferrer" className="external-link">查看链接 ↗</a>}</div></article>;
}

function formatRemaining(milliseconds: number) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${mins}分` : `${mins}分钟`;
}

function DraftModal({ draft, setDraft, onConfirm, onDismiss, busy, categories, items }: { draft: Draft; setDraft: (draft: Draft | null) => void; onConfirm: () => void; onDismiss: () => void; busy: boolean; categories: string[]; items: Item[] }) {
  const updateTask = (index: number, key: keyof DailySuggestion, value: string | number) => setDraft({ ...draft, proposal: { ...draft.proposal, tasks: draft.proposal.tasks?.map((task, i) => i === index ? { ...task, [key]: value } : task) } });
  const updateItem = (index: number, key: keyof GrowthSuggestion, value: string | number | null) => setDraft({ ...draft, proposal: { ...draft.proposal, suggestions: draft.proposal.suggestions?.map((item, i) => i === index ? { ...item, [key]: value } : item) } });
  const removeAt = (index: number) => setDraft({ ...draft, proposal: { ...draft.proposal, tasks: draft.proposal.tasks?.filter((_, i) => i !== index), suggestions: draft.proposal.suggestions?.filter((_, i) => i !== index) } });
  const tasks = draft.proposal.tasks ?? [];
  const suggestions = draft.proposal.suggestions ?? [];
  const total = tasks.reduce((sum, task) => sum + task.estimateMinutes, 0);
  const isReplan = draft.section === 'daily_replan';
  const currentTasks = (draft.proposal as Draft['proposal'] & { currentTasks?: Task[] }).currentTasks ?? [];
  const activeProgressIncomplete = suggestions.some((item) => item.status === 'in_progress' && item.op !== 'archive' && (!item.dueOn || item.progressPercent == null || !item.progressSource || (item.progressSource === 'ai_estimate' && !item.progressNote.trim())));
  const setProgress = (index: number, raw: string) => {
    const value = raw === '' ? null : Number(raw);
    const current = suggestions[index];
    const changedByUser = value !== current.progressPercent;
    setDraft({ ...draft, proposal: { ...draft.proposal, suggestions: suggestions.map((item, i) => i === index ? { ...item, progressPercent: value, ...(changedByUser ? { progressSource: 'user_reported', progressNote: '' } : {}) } : item) } });
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setDraft(null)}><section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><header className="modal-header"><div className="review-icon">✦</div><div><div className="eyebrow">AI 建议 · 等待确认</div><h2 id="review-title">看看整理结果</h2></div><button className="icon-button modal-close" onClick={() => setDraft(null)} aria-label="关闭">×</button></header><div className="modal-body">{draft.proposal.clarification && <div className="clarification-box"><span>?</span>{draft.proposal.clarification}</div>}{draft.section === 'daily' || isReplan ? <><div className="review-intro"><strong>{isReplan ? `${tasks.length} 项任务时长调整` : `${tasks.length} 项任务建议`}</strong><span>{isReplan ? '只调整预计时长，不删除任务' : `合计 ${fmtHours(total)}`}</span></div>{tasks.map((task, index) => <div className="proposal-card" key={`${index}-${task.id ?? task.title}`}><div className="proposal-top"><span className="proposal-index">{String(index + 1).padStart(2, '0')}</span>{!isReplan && <button className="icon-button" aria-label="移除该建议" onClick={() => removeAt(index)}>×</button>}</div><input className="proposal-title-input" value={isReplan ? (currentTasks.find((entry) => entry.id === task.id)?.title ?? '已有任务') : task.title} readOnly={isReplan} onChange={(e) => updateTask(index, 'title', e.target.value)} /><div className="proposal-fields"><label>预计分钟<input type="number" min={5} max={720} value={task.estimateMinutes} onChange={(e) => updateTask(index, 'estimateMinutes', Number(e.target.value))} /></label>{!isReplan && <><label>优先级<select value={task.priority} onChange={(e) => updateTask(index, 'priority', Number(e.target.value))}><option value={1}>高</option><option value={2}>中</option><option value={3}>低</option></select></label><label className="criteria-field">完成标准<input value={task.completionCriteria} onChange={(e) => updateTask(index, 'completionCriteria', e.target.value)} placeholder="怎样算完成？" /></label></>}</div>{!isReplan && task.itemId && <div className="proposal-linked">关联事项：{items.find((item) => item.id === task.itemId)?.title ?? '成长事项'}</div>}</div>)}{tasks.length === 0 && <div className="empty-suggestion">没有具体任务建议。可以重新补充今天要推进的内容。</div>}</> : <><div className="review-intro"><strong>{suggestions.length} 项记录建议</strong><span>所有内容由你确认后写入</span></div>{suggestions.map((item,index) => { const old = item.id ? items.find((record) => record.id === item.id) : undefined; return <div className="proposal-card growth-proposal" key={`${index}-${item.title}`}><div className="proposal-top"><span className={`operation-label operation-${item.op}`}>{({create:'新增', update:'更新', move:'变更状态', archive:'归档', restore:'恢复'} as Record<string,string>)[item.op] ?? item.op}</span><button className="icon-button" aria-label="移除该建议" onClick={() => removeAt(index)}>×</button></div><div className="proposal-fields"><label className="wide-field">名称<input value={item.title} onChange={(e) => updateItem(index, 'title', e.target.value)} /></label><label>分类<select value={item.category} onChange={(e) => updateItem(index, 'category', e.target.value)}>{Array.from(new Set([...categories,item.category])).map((category) => <option key={category}>{category}</option>)}</select></label><label>状态<select value={item.status} onChange={(e) => updateItem(index, 'status', e.target.value)}><option value="completed">已完成</option><option value="in_progress">进行中</option><option value="planned">待进行</option></select></label><label className="wide-field">说明<input value={item.description} onChange={(e) => updateItem(index, 'description', e.target.value)} /></label><label className="wide-field">下一步<input value={item.nextAction} onChange={(e) => updateItem(index, 'nextAction', e.target.value)} placeholder="待补充" /></label><label>开始日期<input type="date" value={item.startedOn ?? ''} onChange={(e) => updateItem(index, 'startedOn', e.target.value || null)} /></label><label>{item.status === 'completed' ? '完成日期' : '截止日期'}<input required={item.status === 'in_progress'} type="date" value={(item.status === 'completed' ? item.completedOn : item.dueOn) ?? ''} onChange={(e) => updateItem(index, item.status === 'completed' ? 'completedOn' : 'dueOn', e.target.value || null)} /></label>{item.op !== 'create' && <label className="wide-field">应用到<select value={item.id ?? ''} onChange={(e) => updateItem(index, 'id', e.target.value)}>{items.map((record) => <option key={record.id} value={record.id}>{record.title}</option>)}</select></label>}{item.status === 'in_progress' && item.op !== 'archive' && <><label>完成进度（%）<input type="number" min={0} max={100} value={item.progressPercent ?? ''} onChange={(e) => setProgress(index, e.target.value)} placeholder="待补充" /></label><label>进度来源<select value={item.progressSource ?? ''} onChange={(e) => updateItem(index, 'progressSource', e.target.value || null)}><option value="">未设置</option><option value="user_reported">本人报告</option><option value="ai_estimate">AI 估算（已确认）</option></select></label><label className="wide-field">进展说明 / 估算依据<textarea rows={2} value={item.progressNote} onChange={(e) => updateItem(index, 'progressNote', e.target.value)} placeholder={item.progressSource === 'ai_estimate' ? '说明 AI 根据哪些已完成里程碑估算' : '记录最近进展或估算依据'} /></label><div className="proposal-progress-context">原进度：{old?.progress_percent == null ? '待补充' : `${old.progress_percent}%`} → 建议进度：{item.progressPercent == null ? '待补充' : `${item.progressPercent}%`}<br />原截止：{old?.due_on ?? '待补充'} → 建议截止：{item.dueOn ?? '待补充'}{item.progressSource === 'ai_estimate' && <><br /><b>这是 AI 估算值，确认后会保留“已确认估算”标识。</b></>}</div></>}</div></div>; })}{activeProgressIncomplete && <div className="clarification-box progress-required-warning"><span>!</span>进行中事项必须补齐截止日期、进度和进度来源后才能保存。AI 估算还需要写明依据。</div>}</>}</div><footer className="modal-footer"><button className="subtle-button" onClick={onDismiss}>忽略建议</button><button className="primary-button" disabled={busy || (draft.section === 'daily' || isReplan ? !tasks.length : !suggestions.length || activeProgressIncomplete)} onClick={onConfirm}>{busy ? '正在保存…' : <>确认并保存 <span>→</span></>}</button></footer></section></div>;
}

function SettingsPanel(props: { ai: AiState | null; login: LoginSnapshot; loginActive: boolean; promptAnswer: string; setPromptAnswer: (value: string) => void; startLogin: () => void; sendAuthAnswer: () => void; cancelLogin: () => void; setAi: (value: AiState | null) => void; refreshAi: () => void; downloadBackup: () => void; restoreBackup: (file?: File) => void; setTestResult: (value: string) => void; testResult: string }) {
  const [testing, setTesting] = useState(false);
  const test = async () => { setTesting(true); props.setTestResult(''); try { const result = await api<{ message: string }>('/api/ai/test', { method: 'POST', body: '{}' }); props.setTestResult(result.message); } catch (e) { props.setTestResult(e instanceof Error ? e.message : '测试失败'); } finally { setTesting(false); } };
  const connected = props.ai?.configured ?? false;
  const phaseLabel: Record<LoginSnapshot['phase'], string> = { idle: '未连接', starting: '正在启动授权', waiting: '等待浏览器授权', exchanging: '正在换取令牌', saving: '正在保存凭证', succeeded: '已授权', failed: '授权失败', cancelled: '已取消', timed_out: '授权超时' };
  const prompt = props.login.prompt;
  return <><PageHeading eyebrow="PREFERENCES & DATA" title="设置" subtitle="管理模型授权，并为成长记录准备一份安全备份。" /><div className="settings-layout"><section className="settings-card model-card"><div className="settings-card-heading"><div className="settings-icon blue-setting">✦</div><div><h2>模型配置</h2><p>使用你的 ChatGPT 订阅连接 AI 助手</p></div><span className={`connection-status ${connected ? 'connected' : ''}`}><i />{connected ? '已授权' : phaseLabel[props.login.phase]}</span></div><div className="provider-row"><div className="openai-mark">✳</div><div className="provider-info"><strong>OpenAI · ChatGPT</strong><small>授权信息安全保存在这台电脑的系统钥匙串中</small></div><span className="provider-protocol">OAuth</span></div>
    {props.ai?.network && <div className={`network-status ${props.ai.network.ready ? '' : 'network-status-error'}`}><span>出站网络：{props.ai.network.source}</span><span>{props.ai.network.httpProxy || props.ai.network.httpsProxy ? '已启用代理' : '未检测到代理'}</span>{!props.ai.network.ready && <strong>{props.ai.network.error}</strong>}</div>}
    {props.loginActive && <div className="auth-progress"><span className="spinner"/><div><strong>{props.login.message ?? '正在启动 ChatGPT 授权…'}</strong><small>{props.login.instructions ?? (props.login.phase === 'waiting' ? '等待浏览器授权完成。' : props.login.phase === 'exchanging' ? '浏览器回调已收到，正在向 OpenAI 换取令牌。' : props.login.phase === 'saving' ? '令牌已取得，正在将凭证保存至本机钥匙串。' : '授权完成后会自动更新连接状态。')}</small></div></div>}
    {props.login.authUrl && props.loginActive && <div className="auth-url-panel"><a className="primary-button auth-link-button" href={props.login.authUrl} target="_blank" rel="noreferrer">打开 ChatGPT 授权页面 ↗</a><span>如果没有自动打开，请点击此按钮继续。</span></div>}
    {prompt && <div className="auth-reply"><label>{prompt.message || '请完成授权输入'}{prompt.type === 'select' && prompt.options?.length ? <select value={props.promptAnswer} onChange={(e) => props.setPromptAnswer(e.target.value)}>{prompt.options.map((option) => <option key={option.id} value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}</select> : <input value={props.promptAnswer} placeholder={prompt.placeholder} onChange={(e) => props.setPromptAnswer(e.target.value)} type={prompt.type === 'secret' ? 'password' : 'text'} onKeyDown={(e) => e.key === 'Enter' && props.sendAuthAnswer()} />}</label><button className="primary-button" onClick={props.sendAuthAnswer} disabled={!props.promptAnswer.trim()}>提交</button></div>}
    {props.login.error && <div className="inline-error" role="alert">{props.login.error}</div>}
    {props.login.phase === 'succeeded' && <div className="inline-success" role="status">✓ {props.login.message ?? 'ChatGPT 授权成功。可使用“测试连接”验证实际模型调用。'}</div>}
    {props.login.phase === 'cancelled' && <div className="auth-cancelled" role="status">{props.login.message}</div>}
    {connected && <label className="model-picker">使用模型<select value={props.ai!.selectedModel} onChange={async (e) => { try { const status = await api<AiState>('/api/ai/model', { method: 'PATCH', body: JSON.stringify({ modelId: e.target.value }) }); props.setAi(status); } catch (error) { alert(error instanceof Error ? error.message : '模型切换失败'); } }}><option value={props.ai!.selectedModel}>{props.ai!.models.find((model) => model.id === props.ai!.selectedModel)?.name ?? props.ai!.selectedModel}</option>{props.ai!.models.filter((model) => model.id !== props.ai!.selectedModel).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>}
    <div className="model-actions">{!connected && <><button className="primary-button" disabled={props.loginActive} onClick={props.startLogin}>{props.login.phase === 'starting' ? '正在启动授权…' : '使用 ChatGPT 登录 →'}</button>{props.loginActive && <button className="outline-button" onClick={props.cancelLogin}>取消授权</button>}</>}{connected && <><button className="outline-button" onClick={test} disabled={testing}>{testing ? '测试中…' : '测试模型调用'}</button><button className="text-button disconnect-button" onClick={async () => { try { await api('/api/ai/logout', { method: 'POST', body: '{}' }); props.setTestResult(''); await props.refreshAi(); } catch (error) { props.setTestResult(error instanceof Error ? error.message : '退出登录失败'); } }}>退出登录</button></>}</div>
    {props.testResult && <div className={props.testResult === '连接成功' ? 'inline-success' : 'inline-error'} role="status">{props.testResult === '连接成功' ? '✓ ' : ''}{props.testResult}</div>}<div className="privacy-note"><span>♢</span>只把你确认的内容保存为记录。授权凭证不会进入备份或 GitHub 仓库。</div></section><section className="settings-card backup-card"><div className="settings-card-heading"><div className="settings-icon pale-green">⇵</div><div><h2>数据备份与迁移</h2><p>保存成长记录，或在另一台电脑恢复</p></div></div><div className="backup-description">备份包含成长事项、日任务和历史，不含 ChatGPT 授权信息。建议定期下载一份，换电脑时重新登录模型即可。</div><div className="backup-actions"><button className="primary-button" onClick={props.downloadBackup}>↓ 下载数据备份</button><label className="outline-button import-button">↑ 从备份恢复<input type="file" accept="application/json,.json" onChange={(e) => { void props.restoreBackup(e.target.files?.[0]); e.target.value = ''; }} /></label></div><div className="backup-path"><span className="local-dot"/>本机数据库自动保存在 Windows 用户数据目录</div></section><section className="settings-card about-card"><div className="settings-card-heading"><div className="settings-icon pale-lilac">⌘</div><div><h2>项目与同步</h2><p>代码可以通过 GitHub 在不同电脑间同步</p></div></div><p>此应用在本机运行。GitHub 用于保存源代码，成长记录请使用上方备份功能迁移。</p><div className="about-chip-row"><span>本地 SQLite</span><span>默认北京时间</span><span>仅本机访问</span></div></section></div></>;
}
