import { useCallback, useEffect, useMemo, useState } from 'react';

type Section = 'daily' | 'completed' | 'in_progress' | 'planned' | 'settings';
type Item = { id: string; version:number; title: string; category?: string; status: string; description: string; priority: number; started_on?: string | null; due_on?: string | null; completed_on?: string | null; progress_percent?: number | null; progress_note?: string; progress_source?: 'user_reported' | 'ai_estimate' | null; progress_updated_at?: string | null; next_action?: string; link?: string; goalTitle?: string | null; canUndo?: boolean; lastAction?: string; archived_at?: string | null };
type Task = { id: string; title: string; estimate_minutes: number; actual_minutes?: number | null; priority: number; completion_criteria: string; item_id?: string | null; itemTitle?: string | null; status: string; continued_from?:string|null;continued_from_date?:string|null;continued_to_date?:string|null;continued_to_title?:string|null };
type DailySuggestion = { id: string | null; op:'keep'|'update'|'create'|'defer';sourceTaskId:string|null;sourceDate:string|null; title: string; estimateMinutes: number; priority: number; completionCriteria: string; itemId: string | null; reason:string };
type GrowthSuggestion = { id: string | null; op: string; title: string; category: string; status: string; description: string; priority: number; startedOn: string | null; dueOn: string | null; completedOn: string | null; progressPercent: number | null; progressNote: string; progressSource: 'user_reported' | 'ai_estimate' | null; nextAction: string; link: string; goalTitle: string };
type Attachment = { id:string;filename:string;mimeType:string;size:number;url:string };
type AttachmentMeta = {id?:string;filename:string;mimeType:string;size:number};
type Draft = { id: string; section: string; rawInput: string; attachments?:Attachment[];attachmentMeta?:AttachmentMeta[];proposal: { clarification: string; failed?:boolean;rawResult?:string;basis?:{date:string;budgetMinutes:number;completedUsed:number;taskSnapshots?:Task[];previousTaskSnapshots?:Task[]};tasks?: DailySuggestion[]; suggestions?: GrowthSuggestion[] } };
type AppState = { date: string; plan: { budget_minutes: number }; tasks: Task[]; items: Item[]; archivedItems: Item[]; categories: { id: string; name: string }[]; goals: { id: string; title: string }[]; pendingDrafts: { id: string; section: string; raw_input: string; proposal: string;attachment_ids:string;attachment_meta:string;attachments:Attachment[];attachmentMeta:AttachmentMeta[]; created_at: string }[] };
type LoginPrompt = { id: string; type: 'text' | 'select' | 'secret' | 'manual_code'; message: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] };
type LoginSnapshot = { attemptId: string | null; phase: 'idle' | 'starting' | 'waiting' | 'exchanging' | 'saving' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'; authUrl?: string; instructions?: string; message?: string; error?: string; prompt?: LoginPrompt; expiresAt?: number; diagnostic?: Diagnostic };
type Diagnostic = { stage: string; code: string; httpStatus?: number; requestId?: string; message: string; advice: string; at: string };
type AiState = { eligible: boolean; eligibility: string; activeKey?: string; accounts: { key: string; label: string; loggedIn: boolean }[]; scopes: string[]; verified?: { model: string; at: string }; diagnostics: Diagnostic[]; configured: boolean; login: LoginSnapshot; provider: string; selectedModel: string; models: { id: string; name: string }[]; network?: { source: string; httpProxy: boolean; httpsProxy: boolean; ready: boolean; error?: string } };

const blankState: AppState = { date: new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}), plan: { budget_minutes: 720 }, tasks: [], items: [], archivedItems: [], categories: [], goals: [], pendingDrafts: [] };
const nav: { id: Section; icon: string; label: string }[] = [
  { id: 'daily', icon: '◷', label: '每日任务' }, { id: 'completed', icon: '✓', label: '已完成' },
  { id: 'in_progress', icon: '↗', label: '进行中' }, { id: 'planned', icon: '✳', label: '待进行' },
];
const fmtHours = (minutes: number) => `${Math.floor(minutes / 60)}小时${minutes % 60 ? ` ${minutes % 60}分` : ''}`;
const fmtDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...options?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const d = data.diagnostic as Diagnostic | undefined; throw new Error(d ? `${data.error} [${d.stage} · ${d.code}${d.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}${d.requestId ? ` · 请求 ${d.requestId}` : ''}] ${d.advice}` : data.error ?? '请求失败，请稍后再试。'); }
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
  const [files,setFiles]=useState<File[]>([]);
  const [uploadedFiles,setUploadedFiles]=useState<Attachment[]>([]);
  const [itemEditor,setItemEditor]=useState<{item:Item|null;section:Section}|null>(null);
  const [taskEditor,setTaskEditor]=useState<{task:Task|null;date:string}|null>(null);
  const [promptAnswer, setPromptAnswer] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testResult, setTestResult] = useState('');

  const refresh = useCallback(async (targetDate = date) => {
    try { setData(await api<AppState>(`/api/state?date=${encodeURIComponent(targetDate)}`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : '无法连接本机服务。'); }
    finally { setLoading(false); }
  }, [date]);
  const refreshAi = useCallback(async () => { try { const status = await api<AiState>('/api/ai/status'); setAi(status); setLogin(status.login); } catch (e) { setError(`界面刷新：${e instanceof Error ? e.message : '模型状态读取失败'}`); } }, []);
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
  const cancelledTasks=data.tasks.filter(task=>task.status==='cancelled');
  const plannedMinutes = openTasks.reduce((sum, task) => sum + task.estimate_minutes, 0);
  const usedMinutes = doneTasks.reduce((sum, task) => sum + (task.actual_minutes ?? task.estimate_minutes), 0);
  const overBudget = plannedMinutes + usedMinutes > data.plan.budget_minutes;
  const activeSection = section === 'settings' ? '模型配置' : nav.find((item) => item.id === section)?.label ?? '每日任务';
  const visibleItems = useMemo(() => section === 'daily' || section === 'settings' ? [] : data.items.filter((item) => item.status === section), [data.items, section]);

  const propose = async () => {
    if (!input.trim()&&!files.length&&!uploadedFiles.length&&section!=='daily') return;
    setBusy(true); setError(''); setNotice('');
    try {
      let uploaded=uploadedFiles;
      if(files.length){const form=new FormData();for(const file of files)form.append('files',file);const response=await fetch('/api/attachments',{method:'POST',body:form});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.diagnostic?`${data.error} [${data.diagnostic.stage} · ${data.diagnostic.code}] ${data.diagnostic.advice}`:data.error??'附件上传失败。');uploaded=[...uploaded,...(data.attachments as Attachment[])];setUploadedFiles(uploaded);setFiles([]);}
      const result = await api<{ draft: Draft;error?:{message:string} }>('/api/ai/propose', { method: 'POST', body: JSON.stringify({ section: section === 'daily' ? 'daily' : section, date, budgetMinutes:data.plan.budget_minutes, input, attachmentIds:uploaded.map(file=>file.id) }) });
      setDraft(result.draft); setInput(''); setFiles([]);setUploadedFiles([]);if(result.error)setError(result.error.message);await refresh(date);
    } catch (e) { setError(e instanceof Error ? e.message : 'AI 整理失败。'); }
    finally { setBusy(false); }
  };

  const retryDraft=async(target:Draft)=>{setBusy(true);try{const result=await api<{draft:Draft;error?:{message:string}}>(`/api/drafts/${target.id}/retry`,{method:'POST',body:JSON.stringify({input:target.rawInput})});setDraft(result.draft);if(result.error)setError(result.error.message);else setError('');await refresh(date);}catch(e){setError(e instanceof Error?e.message:'重新整理失败，草稿仍保留。');}finally{setBusy(false);}};

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = draft.section === 'daily' ? { date:draft.proposal.basis?.date??date, tasks: draft.proposal.tasks } : { suggestions: draft.proposal.suggestions };
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
      await api(`/api/plan/${date}`, { method: 'PATCH', body: JSON.stringify({ budgetMinutes: Math.round(hours * 60) }) });
      await refresh(date);
    } catch (e) { setError(e instanceof Error ? e.message : '预算更新失败。'); }
  };

  const removeDraftAttachment=async(target:Draft,attachment:Attachment)=>{await api(`/api/drafts/${target.id}/attachments/${attachment.id}`,{method:'DELETE'});setDraft({...target,attachments:(target.attachments??[]).filter(file=>file.id!==attachment.id),attachmentMeta:(target.attachmentMeta??[]).filter(file=>file.id!==attachment.id)});await refresh(date);};
  const reattachDraftFiles=async(target:Draft,filesToAttach:File[])=>{setBusy(true);let uploadedFiles:Attachment[]=[];try{const form=new FormData();for(const file of filesToAttach)form.append('files',file);const response=await fetch('/api/attachments',{method:'POST',body:form});const uploaded=await response.json().catch(()=>({}));if(!response.ok)throw new Error(uploaded.diagnostic?`${uploaded.error} [${uploaded.diagnostic.stage} · ${uploaded.diagnostic.code}] ${uploaded.diagnostic.advice}`:uploaded.error??'附件上传失败。');uploadedFiles=uploaded.attachments as Attachment[];const result=await api<{attachments:Attachment[];attachmentMeta:AttachmentMeta[]}>(`/api/drafts/${target.id}/attachments`,{method:'POST',body:JSON.stringify({attachmentIds:uploadedFiles.map(file=>file.id)})});setDraft({...target,attachments:result.attachments,attachmentMeta:result.attachmentMeta});await refresh(date);}catch(error){for(const file of uploadedFiles)await fetch(`/api/attachments/${file.id}`,{method:'DELETE'}).catch(()=>{});throw error;}finally{setBusy(false);}};

  const saveTask=async(value:{title:string;estimateMinutes:number;priority:number;completionCriteria:string;itemId:string|null})=>{
    if(!taskEditor)return;
    try{if(taskEditor.task)await api(`/api/tasks/${taskEditor.task.id}`,{method:'PATCH',body:JSON.stringify(value)});else await api('/api/tasks',{method:'POST',body:JSON.stringify({date:taskEditor.date,...value})});setTaskEditor(null);await refresh(taskEditor.date);}
    catch(e){setError(e instanceof Error?e.message:'任务保存失败，请检查输入后重试。');}
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

  const editTask=(task:Task)=>setTaskEditor({task,date});

  const cancelTask = async (task: Task) => {
    if (!window.confirm(`将「${task.title}」移至已取消任务？`)) return;
    try { await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) }); await refresh(date); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); }
  };

  const undoItem = async (item: Item) => {
    if (!window.confirm(item.lastAction === 'created' ? `撤销新增「${item.title}」？这条记录会移入归档。` : `撤销「${item.title}」最近一次变更？`)) return;
    try { await api(`/api/items/${item.id}/undo`, { method: 'POST', body: JSON.stringify({expectedVersion:item.version}) }); await refresh(date); setNotice('已撤销最近一次变更。'); }
    catch (e) { setError(e instanceof Error ? e.message : '无法撤销该变更。'); }
  };

  const startLogin = async () => {
    if (loginActive) return;
    setError(''); setPromptAnswer(''); setLogin({ attemptId: null, phase: 'starting', message: '正在启动授权…' });
    try { const result = await api<{ login: LoginSnapshot }>('/api/ai/login', { method: 'POST', body: '{}' }); setLogin(result.login); await refreshAi(); }
    catch (e) { setLogin({ attemptId: null, phase: 'failed', error: e instanceof Error ? e.message : '无法启动授权，请重试。' }); }
  };

  const saveItem=async(value:Record<string,unknown>)=>{
    if(!itemEditor)return;
    try{const url=itemEditor.item?`/api/items/${itemEditor.item.id}`:'/api/items';await api(url,{method:itemEditor.item?'PATCH':'POST',body:JSON.stringify(itemEditor.item?{...value,expectedVersion:itemEditor.item.version}:value)});setItemEditor(null);await refresh(date);setNotice(itemEditor.item?'事项已修改。':'事项已添加。');}
    catch(e){setError(e instanceof Error?e.message:'事项保存失败，已保留编辑内容。');throw e;}
  };
  const archiveItem=async(item:Item)=>{if(!window.confirm(`归档「${item.title}」？`))return;try{await api(`/api/items/${item.id}/archive`,{method:'POST',body:JSON.stringify({expectedVersion:item.version})});await refresh(date);}catch(e){setError(e instanceof Error?e.message:'归档失败。');}};
  const restoreItem=async(item:Item)=>{try{await api(`/api/items/${item.id}/restore`,{method:'POST',body:JSON.stringify({expectedVersion:item.version,title:item.title,category:item.category,status:item.status,description:item.description,priority:item.priority,startedOn:item.started_on,dueOn:item.due_on,completedOn:item.completed_on,progressPercent:item.progress_percent,progressNote:item.progress_note,nextAction:item.next_action,link:item.link,goalTitle:item.goalTitle})});await refresh(date);}catch(e){setError(e instanceof Error?e.message:'恢复失败。');}};

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
      <div className="brand"><div className="brand-mark"><img src="/favicon.svg" alt="" /></div><div><strong>昭濂</strong><small>个人成长平台</small></div></div>
      <div className="side-caption">成长空间</div>
      <nav className="side-nav" aria-label="主导航">{nav.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => { setSection(item.id); setDraft(null); setError(''); }}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.id !== 'daily' && <span className="nav-count">{data.items.filter((entry) => entry.status === item.id).length}</span>}</button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-note"><span className="note-spark">✦</span><p>每天前进一步<br /><b>也算在成长</b></p></div>
      <button className={`nav-item settings-nav ${section === 'settings' ? 'active' : ''}`} onClick={() => { setSection('settings'); setDraft(null); }}><span className="nav-icon">⚙</span><span>设置</span><span className={`connection-dot ${ai?.configured ? 'online' : ''}`} /></button>
      <div className="local-label"><span className="local-dot" />数据仅保存在这台电脑</div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumbs"><span>昭濂个人成长平台</span><span className="crumb-sep">/</span><strong>{activeSection}</strong></div><div className="topbar-right">{section !== 'settings' && <label className="date-control"><span>▦</span><input aria-label="选择日期" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}<button className="avatar" title="本地个人空间"><img src="/favicon.svg" alt="昭濂平台" /></button></div></header>
      <div className="page-content">
        {error && <div className="toast error-toast" role="alert"><span>!</span>{error}<button onClick={() => setError('')}>×</button></div>}
        {notice && <div className="toast success-toast" role="status"><span>✓</span>{notice}<button onClick={() => setNotice('')}>×</button></div>}
        {section !== 'settings' && data.pendingDrafts.length > 0 && <details className="network-status"><summary>保留的输入与建议（{data.pendingDrafts.length}）</summary>{data.pendingDrafts.map(saved => <div key={saved.id}><p>{new Date(saved.created_at).toLocaleString('zh-CN')} · {saved.section==='ai_failed_result'?'AI 结果校验失败':saved.section==='daily'?'每日任务建议':'等待确认'}</p>{saved.section==='ai_failed_result'?<details><summary>查看保留的原始输入与结果</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{saved.raw_input+'\n'+saved.proposal}</pre></details>:<button className="outline-button" onClick={()=>{try{setDraft({id:saved.id,section:saved.section,rawInput:saved.raw_input,attachments:saved.attachments,attachmentMeta:saved.attachmentMeta,proposal:JSON.parse(saved.proposal)});}catch{setError('业务校验：无法读取保留的建议。');}}}>继续检查建议</button>}</div>)}</details>}
        {loading ? <div className="loading-state"><span className="spinner" />正在打开你的成长空间…</div> : section === 'settings' ? <SettingsPanel ai={ai} login={login} loginActive={loginActive} promptAnswer={promptAnswer} setPromptAnswer={setPromptAnswer} startLogin={startLogin} sendAuthAnswer={sendAuthAnswer} cancelLogin={cancelLogin} setAi={setAi} refreshAi={refreshAi} downloadBackup={downloadBackup} restoreBackup={restoreBackup} setTestResult={setTestResult} testResult={testResult} /> : section === 'daily' ? <DailyPanel date={date} data={data} dailyTasks={dailyTasks} openTasks={openTasks} doneTasks={doneTasks} cancelledTasks={cancelledTasks} plannedMinutes={plannedMinutes} usedMinutes={usedMinutes} overBudget={overBudget} input={input} setInput={setInput} files={files} setFiles={setFiles} uploadedFiles={uploadedFiles} setUploadedFiles={setUploadedFiles} propose={propose} busy={busy} newTask={()=>setTaskEditor({task:null,date})} updateBudget={updateBudget} toggleTask={toggleTask} editTask={editTask} cancelTask={cancelTask} /> : <GrowthPanel section={section} items={visibleItems} archivedItems={data.archivedItems.filter(item=>item.status===section)} categories={data.categories.map(entry=>entry.name)} input={input} setInput={setInput} files={files} setFiles={setFiles} uploadedFiles={uploadedFiles} setUploadedFiles={setUploadedFiles} propose={propose} busy={busy} onUndo={undoItem} onEdit={item=>setItemEditor({item,section})} onNew={()=>setItemEditor({item:null,section})} onArchive={archiveItem} onRestore={restoreItem} />}
      </div>
      {draft && <DraftModal draft={draft} setDraft={setDraft} onConfirm={saveDraft} onDismiss={dismissDraft} onRetry={()=>retryDraft(draft)} onReattach={filesToAttach=>reattachDraftFiles(draft,filesToAttach)} onRemoveAttachment={attachment=>removeDraftAttachment(draft,attachment)} busy={busy} categories={data.categories.map((entry) => entry.name)} items={[...data.items, ...data.archivedItems]} />}
      {itemEditor&&<ItemEditor key={itemEditor.item?.id??'new-item'} initial={itemEditor.item} section={itemEditor.section} categories={data.categories.map(entry=>entry.name)} goals={data.goals.map(entry=>entry.title)} onClose={()=>setItemEditor(null)} onSave={saveItem}/>}
      {taskEditor&&<TaskEditor key={taskEditor.task?.id??`new-task-${taskEditor.date}`} initial={taskEditor.task} items={data.items} onClose={()=>setTaskEditor(null)} onSave={saveTask}/>}
    </main>
  </div>;
}

function PageHeading({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle: string; right?: React.ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{right}</div>;
}

function AttachmentPreview({file,src}:{file:File;src?:string}){const [local,setLocal]=useState('');useEffect(()=>{if(src)return;const url=URL.createObjectURL(file);setLocal(url);return()=>URL.revokeObjectURL(url);},[file,src]);return file.type.startsWith('image/')&&<img className="attachment-thumb" src={src??local} alt="附件预览"/>;}
function AiComposer({ value, setValue, files,setFiles,uploadedFiles,setUploadedFiles,onSubmit, busy, title, placeholder, allowEmpty=false }: { value: string; setValue: (value: string) => void;files:File[];setFiles:(files:File[])=>void;uploadedFiles:Attachment[];setUploadedFiles:(files:Attachment[])=>void; onSubmit: () => void; busy: boolean; title: string; placeholder: string;allowEmpty?:boolean }) {
  const fileInput=useState<HTMLInputElement|null>(null);
  const appendFiles=(incoming:FileList|File[])=>{const next=Array.from(incoming);const allowed=['png','jpg','jpeg','webp','pdf','docx','txt','md','markdown'];const bad=next.find(f=>!allowed.includes(f.name.split('.').pop()?.toLowerCase()??''));if(bad){window.alert(`暂不支持 ${bad.name}。`);return;}if(next.some(f=>f.size>10*1024*1024)||[...files,...uploadedFiles.map(f=>({size:f.size} as File)),...next].reduce((sum,f)=>sum+f.size,0)>20*1024*1024){window.alert('每个附件最多 10 MiB，所有附件合计最多 20 MiB。');return;}if(files.length+uploadedFiles.length+next.length>5){window.alert('一次最多添加 5 个文件。');return;}setFiles([...files,...next.map(f=>f.name?f:new File([f],`截图-${Date.now()}.png`,{type:f.type||'image/png'}))]);};
  const removeUploaded=async(file:Attachment)=>{try{const response=await fetch(`/api/attachments/${file.id}`,{method:'DELETE'});if(!response.ok)throw new Error('删除失败');setUploadedFiles(uploadedFiles.filter(item=>item.id!==file.id));}catch{window.alert('附件删除失败，请重试。');}};
  return <section className="ai-composer"><div className="composer-top"><span className="ai-spark">✦</span><div><strong>{title}</strong><small>AI 会先整理成建议，由你确认后保存</small></div><span className="powered-tag">AI 助手</span></div><div className="composer-input" onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();appendFiles(event.dataTransfer.files);}}><textarea value={value} onChange={e=>setValue(e.target.value)} onPaste={event=>{const pasted=Array.from(event.clipboardData.items).filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter((file):file is File=>!!file);if(pasted.length){event.preventDefault();appendFiles(pasted);}}} placeholder={placeholder} rows={3}/><input ref={el=>fileInput[1](el)} className="visually-hidden" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.markdown" onChange={event=>{if(event.target.files)appendFiles(event.target.files);event.target.value='';}}/><div className="composer-footer"><span>{title==='每日任务'?'设置预算后，AI 根据进行中事项的紧急程度生成任务。':'可输入文字、粘贴截图或拖入文件（PNG/JPG/WebP/PDF/DOCX/TXT/MD）'}</span><div className="composer-buttons"><button type="button" className="outline-button attach-button" onClick={()=>fileInput[0]?.click()}>＋ 添加图片或文件</button><button className="primary-button" onClick={onSubmit} disabled={busy||(!allowEmpty&&!value.trim()&&!files.length&&!uploadedFiles.length)}>{busy?<><span className="button-spinner"/>正在整理</>:title==='每日任务'?<>✦ 生成今日任务 <span>↗</span></>:<>✦ 整理建议 <span>↗</span></>}</button></div></div>{(files.length+uploadedFiles.length)>0&&<div className="attachment-list">{files.map((file,index)=><div className="attachment-chip" key={`${file.name}-${index}`}><AttachmentPreview file={file}/><span>{file.name}<small>{(file.size/1024/1024).toFixed(1)} MiB · 待上传</small></span><button aria-label="移除附件" onClick={()=>setFiles(files.filter((_,i)=>i!==index))}>×</button></div>)}{uploadedFiles.map(file=><div className="attachment-chip" key={file.id}><AttachmentPreview file={new File([],file.filename,{type:file.mimeType})} src={file.mimeType.startsWith('image/')?file.url:undefined}/><span>{file.filename}<small>{(file.size/1024/1024).toFixed(1)} MiB · 已上传到本机</small></span><button aria-label="移除附件" onClick={()=>void removeUploaded(file)}>×</button></div>)}</div>}</div></section>;
}

function DailyPanel(props: {
  date: string; data: AppState; dailyTasks: Task[]; openTasks: Task[]; doneTasks: Task[];cancelledTasks:Task[]; plannedMinutes: number; usedMinutes: number; overBudget: boolean;
  input: string; setInput: (value: string) => void;files:File[];setFiles:(files:File[])=>void;uploadedFiles:Attachment[];setUploadedFiles:(files:Attachment[])=>void; propose: () => void; busy: boolean;newTask:()=>void;
  updateBudget: (hours: number) => void; toggleTask: (task: Task) => void; editTask: (task: Task) => void; cancelTask: (task: Task) => void;
}) {
  const { data, date, openTasks, doneTasks,cancelledTasks, plannedMinutes, usedMinutes, overBudget } = props;
  const progress = data.plan.budget_minutes ? Math.min(100, Math.round(usedMinutes / data.plan.budget_minutes * 100)) : 0;
  return <>
    <PageHeading eyebrow="YOUR DAILY RHYTHM · DAILY BUDGET" title="每日任务" subtitle={`${fmtDate(date)} · 先定时间预算，再决定今天做什么。`} right={<button className="outline-button" onClick={props.newTask}>＋ 手动添加</button>} />
    <div className="daily-overview">
      <div className="budget-card"><div className="budget-orbit orbit-one"/><div className="budget-orbit orbit-two"/><div className="budget-content"><div className="budget-label">今日时间预算 <span className="budget-info" title="休息时间不计入任务预算">i</span></div><div className="budget-value"><strong>{fmtHours(data.plan.budget_minutes)}</strong><label><select aria-label="调整每日预算" value={data.plan.budget_minutes/60} onChange={e=>props.updateBudget(Number(e.target.value))}>{Array.from({length:24},(_,index)=>12-index*.5).map(hours=><option value={hours} key={hours}>{hours%1?`${hours} 小时`:`${hours} 小时`}</option>)}</select><span>⌄</span></label></div><div className="budget-hint">默认 12 小时 · 可按半小时调整</div><div className="budget-track"><span style={{width:`${progress}%`}}/></div><div className="budget-stats"><span><b>{fmtHours(usedMinutes)}</b>已投入</span><span><b>{fmtHours(plannedMinutes)}</b>待完成</span></div></div><div className="budget-art" aria-hidden="true"><div className="art-sun"/><div className="art-hill hill-back"/><div className="art-hill hill-front"/><div className="art-star star-a">✦</div><div className="art-star star-b">✦</div></div></div>
      <div className="mini-stats"><div className="mini-stat"><span className="stat-icon pale-blue">◷</span><div><small>计划任务</small><strong>{openTasks.length + doneTasks.length}<em> 项</em></strong></div><span className="stat-arrow">↗</span></div><div className="mini-stat"><span className="stat-icon pale-green">✓</span><div><small>已经完成</small><strong>{doneTasks.length}<em> 项</em></strong></div><span className="stat-arrow">↗</span></div><div className="mini-stat"><span className="stat-icon pale-lilac">⚑</span><div><small>实际投入</small><strong>{fmtHours(usedMinutes)}</strong></div><span className="stat-arrow">↗</span></div></div>
    </div>
    {overBudget&&<div className="budget-warning"><span>!</span><div><strong>今日任务超出预算 {fmtHours(plannedMinutes+usedMinutes-data.plan.budget_minutes)}</strong><small>已完成用时按实际记录核算；已有任务保留。重新规划后由你确认调整。</small></div><button className="outline-button" disabled={props.busy} onClick={props.propose}>重新规划未完成任务</button></div>}
    <div className="daily-section-heading"><div><h2>今天要做的事</h2><p>只列任务和预计用时，不安排具体时段</p></div><span className="task-count-pill">{doneTasks.length} / {openTasks.length+doneTasks.length} 完成</span></div>
    <div className="task-list">{props.dailyTasks.length===0?<div className="empty-state task-empty"><div className="empty-illustration"><span>✧</span><span>◷</span><span>✦</span></div><strong>今天还没有任务</strong><p>设置上方时间预算，让 AI 参考你的进行中事项生成今日任务；也可以手动添加。</p></div>:props.dailyTasks.map(task=><article className={`task-row ${task.status==='done'?'task-done':''}`} key={task.id}><button className={`task-check ${task.status==='done'?'checked':''}`} aria-label={task.status==='done'?'标记未完成':'标记已完成'} onClick={()=>props.toggleTask(task)}>{task.status==='done'?'✓':''}</button><div className="task-main"><div className="task-title-line"><strong>{task.title}</strong>{task.priority===1&&<span className="priority-tag">优先</span>}</div><div className="task-meta">{task.completion_criteria&&<span>{task.completion_criteria}</span>}{task.itemTitle&&<span className="linked-item">↗ {task.itemTitle}</span>}{task.continued_from&&<span className="linked-item">从 {task.continued_from_date??'历史日期'} 接续</span>}</div></div><div className="task-time"><span>◷ {fmtHours(task.estimate_minutes)}</span>{task.actual_minutes!=null&&<small>实际 {fmtHours(task.actual_minutes)}</small>}</div>{task.status==='open'&&<div className="task-actions"><button className="icon-button" aria-label="编辑任务" title="编辑任务" onClick={()=>props.editTask(task)}>✎</button><button className="icon-button cancel-task" aria-label="取消任务" title="取消任务" onClick={()=>props.cancelTask(task)}>···</button></div>}</article>)}</div>
    {cancelledTasks.length>0&&<details className="deferred-list"><summary>已暂缓或取消（{cancelledTasks.length}）</summary>{cancelledTasks.map(task=><div className="deferred-row" key={task.id}><span>{task.title}<small>{fmtHours(task.estimate_minutes)} · {task.continued_to_date?`已接续到 ${task.continued_to_date}`:'保留在这一天的历史中'}</small></span><span className="deferred-status">暂缓</span></div>)}</details>}
    <AiComposer value={props.input} setValue={props.setInput} files={props.files} setFiles={props.setFiles} uploadedFiles={props.uploadedFiles} setUploadedFiles={props.setUploadedFiles} onSubmit={props.propose} busy={props.busy} allowEmpty title="每日任务" placeholder="可补充今天的固定安排、精力情况或特别要求；也可以直接生成。AI 会先阅读你的紧急事项。" />
  </>;
}

function GrowthPanel({ section, items, archivedItems, categories, input, setInput, files, setFiles, uploadedFiles, setUploadedFiles, propose, busy, onUndo, onEdit, onNew, onArchive, onRestore }: { section: Section; items: Item[]; archivedItems:Item[];categories:string[];input: string;setInput: (value: string) => void;files:File[];setFiles:(files:File[])=>void;uploadedFiles:Attachment[];setUploadedFiles:(files:Attachment[])=>void;propose: () => void; busy: boolean; onUndo: (item: Item) => void;onEdit:(item:Item)=>void;onNew:()=>void;onArchive:(item:Item)=>void;onRestore:(item:Item)=>void }) {
  const [categoryFilter, setCategoryFilter] = useState('全部分类');
  const details = section === 'completed' ? { title: '已完成', eyebrow: 'MILESTONES & ACHIEVEMENTS', subtitle: '每一段走过的路，都值得被好好记下。', prompt: '告诉 AI 你完成了什么，或想修正哪段经历。', placeholder: '可以输入经历、粘贴截图，或拖入课程证明、文档等附件。', empty: '完成的课程、技能和经历都会在这里留下印记。' } : section === 'in_progress' ? { title: '进行中', eyebrow: 'IN MOTION · KEEP GOING', subtitle: '正在投入的努力，会慢慢长成成果。', prompt: '告诉 AI 你最近的进展', placeholder: '例如：实验基本完成，整理完 3 组数据；下一步写结果部分。AI 会提出进度估算供你确认。', empty: '记下目前在推进的学习、科研和工作。' } : { title: '待进行', eyebrow: 'UP NEXT · MAKE IT REAL', subtitle: '把未来想做的事放在这里，等你准备好就出发。', prompt: '告诉 AI 你接下来的计划', placeholder: '可以描述想做的计划、启动条件，也可以附上相关资料。', empty: '先把想做的事情放进来，之后再逐步安排。' };
  const allCategories = Array.from(new Set([...categories,...items.map((item) => item.category ?? '其他')]));
  const visible = categoryFilter === '全部分类' ? items : items.filter((item) => (item.category ?? '其他') === categoryFilter);
  return <><PageHeading eyebrow={details.eyebrow} title={details.title} subtitle={details.subtitle} right={<button className="primary-button" onClick={onNew}>＋ 手动新增</button>} /><AiComposer value={input} setValue={setInput} files={files} setFiles={setFiles} uploadedFiles={uploadedFiles} setUploadedFiles={setUploadedFiles} onSubmit={propose} busy={busy} title={details.prompt} placeholder={details.placeholder} /><div className="growth-section-heading"><div><h2>{details.title}记录</h2><p>记录可直接编辑；AI 整理结果需要你确认后才会写入</p></div><label className="filter-select"><select aria-label="按分类筛选" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}><option>全部分类</option>{allCategories.map((category) => <option key={category}>{category}</option>)}</select><span>⌄</span></label></div><div className="growth-grid">{items.length === 0 ? <div className="empty-state growth-empty"><div className="growth-empty-icon">✦</div><strong>这里还没有记录</strong><p>{details.empty}</p><button className="outline-button" onClick={onNew}>手动新增一项</button></div> : visible.length === 0 ? <div className="empty-state growth-empty"><strong>这个分类还没有记录</strong><p>试试其他分类。</p></div> : visible.map((item) => <GrowthCard key={item.id} item={item} onUndo={() => onUndo(item)} onEdit={()=>onEdit(item)} onArchive={()=>onArchive(item)} />)}</div>{archivedItems.length>0&&<details className="archived-list"><summary>已归档（{archivedItems.length}）</summary><div className="archived-items">{archivedItems.map(item=><div key={item.id}><span>{item.title}</span><small>{item.category??'其他'}</small><button className="text-button" onClick={()=>onRestore(item)}>恢复</button></div>)}</div></details>}</>;
}

function GrowthCard({ item, onUndo,onEdit,onArchive }: { item: Item; onUndo: () => void;onEdit:()=>void;onArchive:()=>void }) {
  const [menuOpen,setMenuOpen]=useState(false);
  const date = item.status === 'completed' ? item.completed_on : item.due_on;
  const dateLabel = item.status === 'completed' ? '完成于' : '截止';
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { if (item.status !== 'in_progress') return; const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer); }, [item.status]);
  const deadline = item.due_on ? new Date(`${item.due_on}T23:59:59+08:00`).getTime() : null;
  const remaining = deadline === null ? null : deadline - clock;
  const countdown = remaining === null ? '截止日期待补充' : remaining < 0 ? `已逾期 ${formatRemaining(-remaining)}` : remaining < 24 * 60 * 60_000 ? `今天截止 · 剩余 ${formatRemaining(remaining)}` : `剩余 ${formatRemaining(remaining)}`;
  return <article className="growth-card"><div className="growth-card-top"><span className={`category-badge category-${item.category === '科研' ? 'research' : item.category === '课程' ? 'course' : item.category === '技能' ? 'skill' : 'other'}`}>{item.category ?? '其他'}</span><div className="card-actions">{item.canUndo && <button className="undo-button" onClick={onUndo}>↶ {item.lastAction === 'created' ? '撤销新增' : '撤销修改'}</button>}<span className="priority-dots" title={`优先级 ${item.priority}`}>{[1,2,3].map((n) => <i key={n} className={n >= item.priority ? 'filled' : ''} />)}</span><button className="icon-button" title="编辑事项" aria-label="编辑事项" onClick={onEdit}>✎</button><div className="card-menu-wrap"><button className="icon-button" title="更多操作" aria-label="更多操作" aria-expanded={menuOpen} onClick={()=>setMenuOpen(!menuOpen)}>···</button>{menuOpen&&<div className="card-menu"><button onClick={()=>{setMenuOpen(false);onArchive();}}>归档事项</button></div>}</div></div></div><h3>{item.title}</h3>{item.description && <p className="growth-description">{item.description}</p>}{item.status === 'in_progress' && <div className="item-progress-panel"><div className="item-deadline"><span>截止日期</span><strong>{item.due_on ?? '待补充'}</strong><b className={remaining !== null && remaining < 0 ? 'deadline-overdue' : remaining !== null && remaining < 24 * 60 * 60_000 ? 'deadline-urgent' : ''}>{countdown}</b></div><div className="progress-label"><span>实时进度</span><strong>{item.progress_percent == null ? '待补充' : `${item.progress_percent}%`}</strong></div><div className="item-progress-track"><span style={{ width: `${item.progress_percent ?? 0}%` }} /></div>{item.progress_note && <p className="progress-note">{item.progress_note}</p>}<div className="progress-footnote"><span>{item.progress_source === 'ai_estimate' ? 'AI 估算 · 已确认' : item.progress_source === 'user_reported' ? '本人更新' : '来源待补充'}</span>{item.progress_updated_at && <time>更新于 {new Date(item.progress_updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</div></div>}{item.next_action && item.status === 'in_progress' && <div className="next-action"><span>下一步</span><span>{item.next_action}</span></div>}{item.status === 'in_progress' && !item.next_action && <div className="next-action"><span>下一步</span><span>待补充</span></div>}<div className="growth-card-footer"><div className="growth-card-dates">{item.status !== 'in_progress' && date && <span>▦ {dateLabel} {date}</span>}{item.started_on && item.status !== 'completed' && <span>开始于 {item.started_on}</span>}</div>{item.goalTitle && <span className="goal-chip">◎ {item.goalTitle}</span>}{item.link && <a href={item.link} target="_blank" rel="noreferrer" className="external-link">查看链接 ↗</a>}</div></article>;
}

function formatRemaining(milliseconds: number) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${mins}分` : `${mins}分钟`;
}

function ItemEditor({initial,section,categories,goals,onClose,onSave}:{initial:Item|null;section:Section;categories:string[];goals:string[];onClose:()=>void;onSave:(value:Record<string,unknown>)=>Promise<void>}) {
  const [form,setForm]=useState({title:initial?.title??'',category:initial?.category??'其他',status:initial?.status??(section==='settings'?'planned':section),description:initial?.description??'',priority:initial?.priority??2,startedOn:initial?.started_on??'',dueOn:initial?.due_on??'',completedOn:initial?.completed_on??'',progressPercent:initial?.progress_percent==null?'':String(initial.progress_percent),progressNote:initial?.progress_note??'',nextAction:initial?.next_action??'',link:initial?.link??'',goalTitle:initial?.goalTitle??''});
  const [saving,setSaving]=useState(false),[localError,setLocalError]=useState('');
  const change=(key:keyof typeof form,value:string|number)=>setForm(current=>({...current,[key]:value}));
  const submit=async(event:React.FormEvent)=>{event.preventDefault();setLocalError('');if(form.status==='in_progress'&&(!form.dueOn||form.progressPercent==='')){setLocalError('进行中事项需要填写截止日期和完成进度。');return;}if(form.link&&!/^https?:\/\//i.test(form.link)){setLocalError('链接请以 http:// 或 https:// 开头。');return;}setSaving(true);try{await onSave({...form,progressPercent:form.progressPercent===''?null:Number(form.progressPercent),startedOn:form.startedOn||null,dueOn:form.dueOn||null,completedOn:form.completedOn||null});}catch(error){setLocalError(error instanceof Error?error.message:'保存失败，表单内容仍保留。');}finally{setSaving(false);}};
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><form className="editor-modal" role="dialog" aria-modal="true" onSubmit={submit}><header className="modal-header"><div className="review-icon">✎</div><div><div className="eyebrow">{initial?'手动编辑':'手动新增'}</div><h2>{initial?'编辑成长事项':'添加成长事项'}</h2></div><button type="button" className="icon-button modal-close" onClick={onClose} aria-label="关闭">×</button></header><div className="editor-body"><div className="editor-grid">
    <label className="wide-field">事项名称<input required maxLength={180} value={form.title} onChange={event=>change('title',event.target.value)} autoFocus /></label>
    <label>分类<input list="item-categories" maxLength={60} value={form.category} onChange={event=>change('category',event.target.value)} /><datalist id="item-categories">{Array.from(new Set([...categories,'课程','技能','科研','竞赛','实习','其他'])).map(value=><option key={value} value={value}/>)}</datalist></label>
    <label>状态<select value={form.status} onChange={event=>change('status',event.target.value)}><option value="completed">已完成</option><option value="in_progress">进行中</option><option value="planned">待进行</option></select></label>
    <label>优先级<select value={form.priority} onChange={event=>change('priority',Number(event.target.value))}><option value={1}>高</option><option value={2}>中</option><option value={3}>低</option></select></label>
    <label>开始日期<input type="date" value={form.startedOn} onChange={event=>change('startedOn',event.target.value)} /></label>
    <label>截止日期<input type="date" required={form.status==='in_progress'} value={form.dueOn} onChange={event=>change('dueOn',event.target.value)} /></label>
    {form.status==='completed'&&<label>完成日期<input type="date" value={form.completedOn} onChange={event=>change('completedOn',event.target.value)} /></label>}
    {form.status==='in_progress'&&<><label>完成进度（%）<input type="number" min={0} max={100} step={1} required value={form.progressPercent} onChange={event=>change('progressPercent',event.target.value)} placeholder="例如 35" /></label><label className="wide-field">最新进展<input value={form.progressNote} maxLength={500} onChange={event=>change('progressNote',event.target.value)} placeholder="记录当前完成情况" /></label><label className="wide-field">下一步行动<input value={form.nextAction} maxLength={500} onChange={event=>change('nextAction',event.target.value)} placeholder="接下来准备做什么？" /></label></>}
    <label className="wide-field">事项说明<textarea rows={3} maxLength={4000} value={form.description} onChange={event=>change('description',event.target.value)} /></label>
    <label>长期目标<input list="item-goals" value={form.goalTitle} maxLength={180} onChange={event=>change('goalTitle',event.target.value)} placeholder="可新建目标" /><datalist id="item-goals">{goals.map(goal=><option key={goal} value={goal}/>)}</datalist></label>
    <label>相关链接<input type="url" maxLength={1000} value={form.link} onChange={event=>change('link',event.target.value)} placeholder="https://…" /></label>
  </div>{localError&&<div className="inline-error" role="alert">{localError}</div>}</div><footer className="modal-footer"><button type="button" className="subtle-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving?'正在保存…':'保存事项'}</button></footer></form></div>;
}

function TaskEditor({initial,items,onClose,onSave}:{initial:Task|null;items:Item[];onClose:()=>void;onSave:(value:{title:string;estimateMinutes:number;priority:number;completionCriteria:string;itemId:string|null})=>Promise<void>}) {
  const [title,setTitle]=useState(initial?.title??''),[estimate,setEstimate]=useState(initial?.estimate_minutes??60),[priority,setPriority]=useState(initial?.priority??2),[criteria,setCriteria]=useState(initial?.completion_criteria??''),[itemId,setItemId]=useState(initial?.item_id??''),[saving,setSaving]=useState(false),[localError,setLocalError]=useState('');
  const submit=async(event:React.FormEvent)=>{event.preventDefault();if(!title.trim()){setLocalError('请填写任务名称。');return;}setSaving(true);setLocalError('');try{await onSave({title:title.trim(),estimateMinutes:estimate,priority,completionCriteria:criteria,itemId:itemId||null});}catch(error){setLocalError(error instanceof Error?error.message:'任务保存失败，表单内容仍保留。');}finally{setSaving(false);}};
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>event.target===event.currentTarget&&onClose()}><form className="editor-modal compact-editor" role="dialog" aria-modal="true" onSubmit={submit}><header className="modal-header"><div className="review-icon">◷</div><div><div className="eyebrow">每日任务</div><h2>{initial?'编辑任务':'手动添加任务'}</h2></div><button type="button" className="icon-button modal-close" onClick={onClose} aria-label="关闭">×</button></header><div className="editor-body"><div className="editor-grid"><label className="wide-field">任务名称<input required maxLength={180} value={title} onChange={event=>setTitle(event.target.value)} autoFocus /></label><label>预计用时（分钟）<input type="number" min={5} max={720} step={5} value={estimate} onChange={event=>setEstimate(Number(event.target.value))} /></label><label>优先级<select value={priority} onChange={event=>setPriority(Number(event.target.value))}><option value={1}>高</option><option value={2}>中</option><option value={3}>低</option></select></label><label className="wide-field">完成标准<textarea rows={2} maxLength={500} value={criteria} onChange={event=>setCriteria(event.target.value)} placeholder="做到什么程度算完成？" /></label><label className="wide-field">关联成长事项<select value={itemId} onChange={event=>setItemId(event.target.value)}><option value="">不关联</option>{items.filter(item=>!item.archived_at).map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div>{localError&&<div className="inline-error" role="alert">{localError}</div>}</div><footer className="modal-footer"><button type="button" className="subtle-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving?'正在保存…':'保存任务'}</button></footer></form></div>;
}

function DraftModal({draft,setDraft,onConfirm,onDismiss,onRetry,onReattach,onRemoveAttachment,busy,categories,items}:{draft:Draft;setDraft:(draft:Draft|null)=>void;onConfirm:()=>void;onDismiss:()=>void;onRetry:()=>void;onReattach:(files:File[])=>Promise<void>;onRemoveAttachment:(attachment:Attachment)=>Promise<void>;busy:boolean;categories:string[];items:Item[]}) {
  const [reattachFiles,setReattachFiles]=useState<File[]>([]),[attachError,setAttachError]=useState('');
  const updateTask=(index:number,patch:Partial<DailySuggestion>)=>setDraft({...draft,proposal:{...draft.proposal,tasks:draft.proposal.tasks?.map((task,i)=>i===index?{...task,...patch}:task)}});
  const updateItem=(index:number,key:keyof GrowthSuggestion,value:string|number|null)=>setDraft({...draft,proposal:{...draft.proposal,suggestions:draft.proposal.suggestions?.map((item,i)=>i===index?{...item,[key]:value}:item)}});
  const tasks=draft.proposal.tasks??[],suggestions=draft.proposal.suggestions??[],failed=!!draft.proposal.failed,isLegacy=draft.section==='daily_replan'||(draft.section==='daily'&&!draft.proposal.basis);
  const doneUsed=draft.proposal.basis?.completedUsed??0,budget=draft.proposal.basis?.budgetMinutes??0;
  const planned=tasks.filter(task=>task.op!=='defer').reduce((sum,task)=>sum+task.estimateMinutes,doneUsed);
  const activeProgressIncomplete=suggestions.some(item=>item.status==='in_progress'&&item.op!=='archive'&&(!item.dueOn||item.progressPercent==null||!item.progressSource||(item.progressSource==='ai_estimate'&&!item.progressNote.trim())));
  const setProgress=(index:number,raw:string)=>{const value=raw===''?null:Number(raw);const current=suggestions[index];const next=suggestions.map((item,i)=>i===index?{...item,progressPercent:value,...(value!==current.progressPercent?{progressSource:'user_reported' as const,progressNote:''}:{})}:item);setDraft({...draft,proposal:{...draft.proposal,suggestions:next}});};
  const dailyInvalid=!tasks.length||planned>budget||tasks.some(task=>task.op==='create'&&task.id!==null||task.op!=='create'&&task.id===null);
  const reattach=async()=>{try{setAttachError('');await onReattach(reattachFiles);setReattachFiles([]);}catch(error){setAttachError(error instanceof Error?error.message:'附件重新添加失败，请重试。');}};
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>event.target===event.currentTarget&&setDraft(null)}><section className="review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><header className="modal-header"><div className="review-icon">✦</div><div><div className="eyebrow">{failed?'待重试草稿':'建议 · 等待确认'}</div><h2 id="review-title">{draft.section==='daily'?'确认今日任务':'看看整理结果'}</h2></div><button className="icon-button modal-close" onClick={()=>setDraft(null)} aria-label="关闭">×</button></header><div className="modal-body">
    {draft.rawInput&&<details className="draft-source"><summary>查看原始输入</summary><p>{draft.rawInput}</p></details>}
    {!!draft.attachmentMeta?.length&&<div className="draft-attachments"><strong>输入附件</strong>{draft.attachmentMeta.map((meta,index)=>{const file=draft.attachments?.find(att=>meta.id?att.id===meta.id:att.filename===meta.filename);return <div className="draft-attachment" key={`${meta.id??meta.filename}-${index}`}><span>{meta.filename}<small>{(meta.size/1024/1024).toFixed(1)} MiB {file?'· 可重试':'· 备份未包含原件，需要重新附加'}</small></span>{file&&<><a href={file.url} target="_blank" rel="noreferrer">预览</a><button className="text-button" onClick={()=>void onRemoveAttachment(file).catch(error=>setAttachError(error instanceof Error?error.message:'附件移除失败。'))}>移除</button></>}</div>;})}{draft.attachmentMeta.some(meta=>!draft.attachments?.some(file=>meta.id?file.id===meta.id:file.filename===meta.filename))&&<div className="reattach-row"><input type="file" multiple accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.md,.markdown" onChange={event=>{if(event.target.files)setReattachFiles(Array.from(event.target.files));event.target.value='';}}/><button className="outline-button" disabled={busy||!reattachFiles.length} onClick={()=>void reattach()}>{busy?'正在上传…':'重新附加所需文件'}</button></div>}</div>}{attachError&&<div className="inline-error" role="alert">{attachError}</div>}
    {draft.proposal.clarification&&<div className="clarification-box"><span>?</span>{draft.proposal.clarification}</div>}
    {failed&&<><div className="inline-error" role="alert">AI 处理未完成；输入和附件仍保留。可以修改文字或移除附件后重试。</div><label className="draft-input-editor">原始文字<input value={draft.rawInput} maxLength={8000} onChange={event=>setDraft({...draft,rawInput:event.target.value})} placeholder="可留空并只用附件重新整理" /></label>{draft.proposal.rawResult&&<details className="draft-source"><summary>查看校验失败的模型结果</summary><pre>{draft.proposal.rawResult}</pre></details>}<button className="outline-button" disabled={busy} onClick={onRetry}>{busy?'正在重新处理…':'重新整理此草稿'}</button></>}
    {isLegacy&&!failed&&<div className="clarification-box"><span>!</span>这是旧版每日建议，不能直接应用。请关闭后重新生成今日任务。</div>}
    {!failed&&(draft.section==='daily'&&!isLegacy?<><div className="review-intro"><strong>{tasks.length} 项任务建议</strong><span>完成用时 {fmtHours(doneUsed)} + 待办 {fmtHours(planned-doneUsed)} / 预算 {fmtHours(budget)}</span></div>{tasks.map((task,index)=><div className={`proposal-card daily-proposal ${task.op==='defer'?'proposal-deferred':''}`} key={`${task.id??'new'}-${index}`}><div className="proposal-top"><span className="operation-label">{task.op==='create'?'新增':task.op==='update'?'调整':task.op==='defer'?'暂缓':'保留'}</span>{task.op==='create'&&<button className="icon-button" aria-label="移除新任务" onClick={()=>setDraft({...draft,proposal:{...draft.proposal,tasks:tasks.filter((_,i)=>i!==index)}})}>×</button>}</div><label className="proposal-title-label">任务名称<input className="proposal-title-input" value={task.title} readOnly={task.op==='keep'||task.op==='defer'} onChange={event=>updateTask(index,{title:event.target.value,op:task.id?'update':'create'})}/></label><div className="proposal-fields"><label>处理方式<select value={task.op} onChange={event=>updateTask(index,{op:event.target.value as DailySuggestion['op']})}>{task.id===null?<option value="create">新增</option>:<><option value="keep">保留</option><option value="update">调整</option><option value="defer">暂缓</option></>}</select></label><label>预计用时（分钟）<input type="number" min={5} max={720} step={5} disabled={task.op==='keep'||task.op==='defer'} value={task.estimateMinutes} onChange={event=>updateTask(index,{estimateMinutes:Number(event.target.value),op:task.id?'update':'create'})}/></label><label>优先级<select disabled={task.op==='keep'||task.op==='defer'} value={task.priority} onChange={event=>updateTask(index,{priority:Number(event.target.value),op:task.id?'update':'create'})}><option value={1}>高</option><option value={2}>中</option><option value={3}>低</option></select></label><label className="criteria-field">完成标准<input disabled={task.op==='keep'||task.op==='defer'} value={task.completionCriteria} onChange={event=>updateTask(index,{completionCriteria:event.target.value,op:task.id?'update':'create'})}/></label></div>{task.itemId&&<div className="proposal-linked">关联事项：{items.find(item=>item.id===task.itemId)?.title??'成长事项'}</div>}{task.sourceTaskId&&<p className="candidate-source-note">来源：{task.sourceDate??"历史日期"} 未完成任务。确认后会移入今天，原记录保留在原日期。</p>}{task.reason&&<p className="recommendation-reason">推荐原因：{task.reason}</p>}</div>)}{tasks.length===0&&<div className="empty-suggestion">没有任务建议。你可以返回重新补充要求。</div>}{planned>budget&&<div className="clarification-box progress-required-warning"><span>!</span>建议总用时超过预算。请调整、暂缓或删除新任务后再确认。</div>}</>:draft.section!=='daily'&&!isLegacy?<><div className="review-intro"><strong>{suggestions.length} 项记录建议</strong><span>所有内容由你确认后写入</span></div>{suggestions.map((item,index)=>{const old=item.id?items.find(record=>record.id===item.id):undefined;return <div className="proposal-card growth-proposal" key={`${index}-${item.title}`}><div className="proposal-top"><span className={`operation-label operation-${item.op}`}>{({create:'新增',update:'更新',move:'变更状态',archive:'归档',restore:'恢复'} as Record<string,string>)[item.op]??item.op}</span><button className="icon-button" aria-label="移除该建议" onClick={()=>setDraft({...draft,proposal:{...draft.proposal,suggestions:suggestions.filter((_,i)=>i!==index)}})}>×</button></div><div className="proposal-fields"><label className="wide-field">名称<input value={item.title} onChange={event=>updateItem(index,'title',event.target.value)}/></label><label>分类<input list="proposal-categories" value={item.category} onChange={event=>updateItem(index,'category',event.target.value)}/><datalist id="proposal-categories">{Array.from(new Set([...categories,item.category])).map(category=><option key={category} value={category}/>)}</datalist></label><label>状态<select value={item.status} onChange={event=>updateItem(index,'status',event.target.value)}><option value="completed">已完成</option><option value="in_progress">进行中</option><option value="planned">待进行</option></select></label><label className="wide-field">说明<input value={item.description} onChange={event=>updateItem(index,'description',event.target.value)}/></label><label className="wide-field">下一步<input value={item.nextAction} onChange={event=>updateItem(index,'nextAction',event.target.value)}/></label><label>开始日期<input type="date" value={item.startedOn??''} onChange={event=>updateItem(index,'startedOn',event.target.value||null)}/></label><label>{item.status==='completed'?'完成日期':'截止日期'}<input type="date" required={item.status==='in_progress'} value={(item.status==='completed'?item.completedOn:item.dueOn)??''} onChange={event=>updateItem(index,item.status==='completed'?'completedOn':'dueOn',event.target.value||null)}/></label>{item.status==='in_progress'&&item.op!=='archive'&&<><label>完成进度（%）<input type="number" min={0} max={100} value={item.progressPercent??''} onChange={event=>setProgress(index,event.target.value)}/></label><label>进度来源<select value={item.progressSource??''} onChange={event=>updateItem(index,'progressSource',event.target.value||null)}><option value="">未设置</option><option value="user_reported">本人报告</option><option value="ai_estimate">AI 估算（已确认）</option></select></label><label className="wide-field">进展说明 / 估算依据<textarea rows={2} value={item.progressNote} onChange={event=>updateItem(index,'progressNote',event.target.value)}/></label><div className="proposal-progress-context">原进度：{old?.progress_percent==null?'待补充':`${old.progress_percent}%`} → 新进度：{item.progressPercent==null?'待补充':`${item.progressPercent}%`}<br/>原截止：{old?.due_on??'待补充'} → 新截止：{item.dueOn??'待补充'}</div></>}</div></div>;})}{activeProgressIncomplete&&<div className="clarification-box progress-required-warning"><span>!</span>进行中事项需要补齐截止日期、进度和进度来源后才能保存。AI 估算还需填写估算依据。</div>}</>:null)}
    </div><footer className="modal-footer"><button className="subtle-button" onClick={onDismiss} disabled={busy}>忽略草稿</button><button className="primary-button" disabled={busy||failed||isLegacy||(draft.section==='daily'?dailyInvalid:!suggestions.length||activeProgressIncomplete)} onClick={onConfirm}>{busy?'正在保存…':<>确认并保存 <span>→</span></>}</button></footer></section></div>;
}

function SettingsPanel(props: { ai: AiState | null; login: LoginSnapshot; loginActive: boolean; promptAnswer: string; setPromptAnswer: (value: string) => void; startLogin: () => void; sendAuthAnswer: () => void; cancelLogin: () => void; setAi: (value: AiState | null) => void; refreshAi: () => void; downloadBackup: () => void; restoreBackup: (file?: File) => void; setTestResult: (value: string) => void; testResult: string }) {
  const [testing, setTesting] = useState(false);
  const test = async () => { setTesting(true); props.setTestResult(''); try { const result = await api<{ message: string }>('/api/ai/test', { method: 'POST', body: '{}' }); props.setTestResult(result.message); await props.refreshAi(); } catch (e) { props.setTestResult(e instanceof Error ? e.message : '测试失败'); } finally { setTesting(false); props.refreshAi(); } };
  const connected = props.ai?.configured ?? false;
  const phaseLabel: Record<LoginSnapshot['phase'], string> = { idle: '未连接', starting: '正在启动授权', waiting: '等待浏览器授权', exchanging: '正在换取令牌', saving: '正在保存凭证', succeeded: '已授权', failed: '授权失败', cancelled: '已取消', timed_out: '授权超时' };
  const prompt = props.login.prompt;
  return <><PageHeading eyebrow="PREFERENCES & DATA" title="设置" subtitle="管理模型授权，并为成长记录准备一份安全备份。" /><div className="settings-layout"><section className="settings-card model-card"><div className="settings-card-heading"><div className="settings-icon blue-setting">✦</div><div><h2>模型配置</h2><p>使用你的 ChatGPT 订阅连接 AI 助手</p></div><span className={`connection-status ${connected ? 'connected' : ''}`}><i />{connected ? (props.ai?.verified?.model === props.ai?.selectedModel ? '已验证可调用' : '已登录 · 调用待验证') : phaseLabel[props.login.phase]}</span></div><div className="provider-row"><div className="openai-mark">✳</div><div className="provider-info"><strong>OpenAI · ChatGPT</strong><small>凭据加密保存在本机，加密密钥由 Windows 系统钥匙串保护</small></div><span className="provider-protocol">OAuth</span></div>
    <div className="network-status">{props.ai?.eligibility ?? '正在读取应用资格…'} · 仅本机客户端<br/>需要符合官方条件的 Plus / Pro 账号；身份登录与订阅用量授权分别检查。<a href="https://developers.openai.com/siwc/quickstart" target="_blank" rel="noreferrer">官方接入范围 ↗</a></div>
    {props.ai && props.ai.accounts.length > 0 && <label className="model-picker">当前账号注册<select value={props.ai.activeKey ?? ''} disabled={props.loginActive || testing} onChange={async e => { try { props.setAi(await api<AiState>('/api/ai/account', { method: 'POST', body: JSON.stringify({ key: e.target.value }) })); props.setTestResult(''); } catch(error) { props.setTestResult(String(error)); } }}>{props.ai.accounts.map(account => <option key={account.key} value={account.key}>{account.label} · {account.loggedIn ? '已登录' : '已断开'}</option>)}</select></label>}
    {connected && <div className="network-status">实际授予的权限：{props.ai?.scopes.join(' · ') || '无'}<br/>{props.ai?.verified ? '最近一次完整调用验证：' + new Date(props.ai.verified.at).toLocaleString('zh-CN') + ' · ' + props.ai.verified.model : '尚未完成实际模型调用验证。'}</div>}
    {props.ai?.network && <div className={`network-status ${props.ai.network.ready ? '' : 'network-status-error'}`}><span>出站网络：{props.ai.network.source}</span><span>{props.ai.network.httpProxy || props.ai.network.httpsProxy ? '已启用代理' : '未检测到代理'}</span>{!props.ai.network.ready && <strong>{props.ai.network.error}</strong>}</div>}
    {connected && !props.ai?.scopes.includes('chatgpt.tokens.use.direct') && <button className="outline-button" disabled={props.loginActive} onClick={async () => { try { await api('/api/ai/login', {method:'POST',body:JSON.stringify({reconsent:true})}); await props.refreshAi(); } catch(error) { props.setTestResult(String(error)); } }}>在官方页面启用订阅用量权限</button>}
    {props.loginActive && <div className="auth-progress"><span className="spinner"/><div><strong>{props.login.message ?? '正在启动 ChatGPT 授权…'}</strong><small>{props.login.instructions ?? (props.login.phase === 'waiting' ? '等待浏览器授权完成。' : props.login.phase === 'exchanging' ? '浏览器回调已收到，正在向 OpenAI 换取令牌。' : props.login.phase === 'saving' ? '令牌已取得，正在将凭证保存至本机钥匙串。' : '授权完成后会自动更新连接状态。')}</small></div></div>}
    {props.login.authUrl && props.loginActive && <div className="auth-url-panel"><a className="primary-button auth-link-button" href={props.login.authUrl} target="_blank" rel="noreferrer">打开 ChatGPT 授权页面 ↗</a><span>如果没有自动打开，请点击此按钮继续。</span></div>}
    {prompt && <div className="auth-reply"><label>{prompt.message || '请完成授权输入'}{prompt.type === 'select' && prompt.options?.length ? <select value={props.promptAnswer} onChange={(e) => props.setPromptAnswer(e.target.value)}>{prompt.options.map((option) => <option key={option.id} value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}</select> : <input value={props.promptAnswer} placeholder={prompt.placeholder} onChange={(e) => props.setPromptAnswer(e.target.value)} type={prompt.type === 'secret' ? 'password' : 'text'} onKeyDown={(e) => e.key === 'Enter' && props.sendAuthAnswer()} />}</label><button className="primary-button" onClick={props.sendAuthAnswer} disabled={!props.promptAnswer.trim()}>提交</button></div>}
    {props.login.error && <div className="inline-error" role="alert">{props.login.error}</div>}
    {props.login.phase === 'succeeded' && <div className="inline-success" role="status">✓ {props.login.message ?? 'ChatGPT 授权成功。可使用“测试连接”验证实际模型调用。'}</div>}
    {props.login.phase === 'cancelled' && <div className="auth-cancelled" role="status">{props.login.message}</div>}
    {connected && <label className="model-picker">使用模型<select value={props.ai!.selectedModel} onChange={async (e) => { try { const status = await api<AiState>('/api/ai/model', { method: 'PATCH', body: JSON.stringify({ modelId: e.target.value }) }); props.setAi(status); } catch (error) { alert(error instanceof Error ? error.message : '模型切换失败'); } }}><option value={props.ai!.selectedModel}>{props.ai!.models.find((model) => model.id === props.ai!.selectedModel)?.name ?? props.ai!.selectedModel}</option>{props.ai!.models.filter((model) => model.id !== props.ai!.selectedModel).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>}
    <div className="model-actions">{!connected && <><button className="primary-button" disabled={props.loginActive || !props.ai?.eligible} onClick={props.startLogin}>{props.login.phase === 'starting' ? '正在启动授权…' : 'Continue with ChatGPT →'}</button>{props.loginActive && <button className="outline-button" onClick={props.cancelLogin}>取消授权</button>}</>}{connected && <><button className="outline-button" disabled={testing} onClick={async () => { try { props.setAi(await api<AiState>('/api/ai/models', { method: 'POST', body: '{}' })); props.setTestResult('模型列表已刷新；尚未进行推理测试。'); } catch(error) { props.setTestResult(String(error)); props.refreshAi(); } }}>获取 / 刷新账号模型</button><button className="outline-button" onClick={test} disabled={testing}>{testing ? '测试中…' : '发送无隐私测试（少量额度）'}</button><button className="text-button disconnect-button" onClick={async () => { try { const result = await api<{ message: string }>('/api/ai/logout', { method: 'POST', body: '{}' }); props.setTestResult(result.message); await props.refreshAi(); } catch (error) { props.setTestResult(error instanceof Error ? error.message : '退出登录失败'); } }}>退出登录</button></>}</div>
    {!props.loginActive && props.ai?.eligible && <div className="model-actions"><button className="text-button" onClick={props.startLogin}>重新授权当前注册</button><button className="text-button" onClick={async () => { try { await api('/api/ai/login', { method: 'POST', body: JSON.stringify({ fresh: true }) }); await props.refreshAi(); } catch(error) { props.setTestResult(String(error)); } }}>添加另一个账号注册</button></div>}
    {props.login.diagnostic && <p className="inline-error">{props.login.diagnostic.stage} · {props.login.diagnostic.code} · HTTP {props.login.diagnostic.httpStatus ?? '—'} · 请求 ID {props.login.diagnostic.requestId ?? '—'}<br/>{props.login.diagnostic.advice}</p>}
    {!!props.ai?.diagnostics.length && <details className="network-status"><summary>最近的脱敏诊断（不含令牌和个人输入）</summary>{props.ai.diagnostics.slice(-6).reverse().map((entry, index) => <p key={index}>{entry.at} · {entry.stage} · {entry.code} · HTTP {entry.httpStatus ?? '—'} · 请求 ID {entry.requestId ?? '—'}<br/>{entry.message} {entry.advice}</p>)}</details>}
    <p className="backup-description">测试仅发送“Connection test. No personal data.”，不会上传成长记录。AI 整理支持文字、图片、PDF、DOCX、TXT 和 Markdown 临时附件；模型不支持的类型会明确报错。<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">查看 ChatGPT 用量和应用权限 ↗</a></p>
    {props.testResult && <div className={props.testResult.startsWith('已验证可调用') ? 'inline-success' : 'inline-error'} role="status">{props.testResult.startsWith('已验证可调用') ? '✓ ' : ''}{props.testResult}</div>}<div className="privacy-note"><span>♢</span>只把你确认的内容保存为记录。授权凭证不会进入备份或 GitHub 仓库。</div></section><section className="settings-card backup-card"><div className="settings-card-heading"><div className="settings-icon pale-green">⇵</div><div><h2>数据备份与迁移</h2><p>保存成长记录，或在另一台电脑恢复</p></div></div><div className="backup-description">备份包含成长事项、日任务和历史，不含 ChatGPT 授权信息。建议定期下载一份，换电脑时重新登录模型即可。</div><div className="backup-actions"><button className="primary-button" onClick={props.downloadBackup}>↓ 下载数据备份</button><label className="outline-button import-button">↑ 从备份恢复<input type="file" accept="application/json,.json" onChange={(e) => { void props.restoreBackup(e.target.files?.[0]); e.target.value = ''; }} /></label></div><div className="backup-path"><span className="local-dot"/>本机数据库自动保存在 Windows 用户数据目录</div></section><section className="settings-card about-card"><div className="settings-card-heading"><div className="settings-icon pale-lilac">⌘</div><div><h2>项目与同步</h2><p>代码可以通过 GitHub 在不同电脑间同步</p></div></div><p>此应用在本机运行。GitHub 用于保存源代码，成长记录请使用上方备份功能迁移。</p><div className="about-chip-row"><span>本地 SQLite</span><span>默认北京时间</span><span>仅本机访问</span></div></section></div></>;
}
