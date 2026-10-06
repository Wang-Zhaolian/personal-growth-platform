import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { db, dataDir, now } from './db.js';
import { AIError } from './ai-errors.js';

const attachmentDir = join(dataDir, 'ai-attachments');
mkdirSync(attachmentDir, { recursive: true });
const mib = 1024 * 1024;
export const uploadAttachments = multer({ storage: multer.memoryStorage(), limits: { files: 5, fileSize: 10 * mib, fields: 0 } }).array('files', 5);

const types: Record<string, { mime: string; kind: 'png'|'jpeg'|'webp'|'pdf'|'docx'|'text' }> = {
  '.png': { mime: 'image/png', kind: 'png' }, '.jpg': { mime: 'image/jpeg', kind: 'jpeg' }, '.jpeg': { mime: 'image/jpeg', kind: 'jpeg' },
  '.webp': { mime: 'image/webp', kind: 'webp' }, '.pdf': { mime: 'application/pdf', kind: 'pdf' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx' },
  '.txt': { mime: 'text/plain', kind: 'text' }, '.md': { mime: 'text/markdown', kind: 'text' }, '.markdown': { mime: 'text/markdown', kind: 'text' },
};
export type SavedAttachment = { id: string; filename: string; mimeType: string; size: number; url: string };
type UploadFile = { originalname: string; buffer: Buffer; size: number };

function validate(file: UploadFile, type: NonNullable<typeof types[string]>) {
  const b = file.buffer;
  const valid = type.kind === 'png' ? b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : type.kind === 'jpeg' ? b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    : type.kind === 'webp' ? b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP'
    : type.kind === 'pdf' ? b.toString('ascii',0,5) === '%PDF-'
    : type.kind === 'docx' ? b.toString('ascii',0,2) === 'PK' && b.includes(Buffer.from('word/document.xml'))
    : !b.includes(0) && (() => { try { new TextDecoder('utf-8',{fatal:true}).decode(b); return true; } catch { return false; } })();
  if (!valid) throw new AIError('附件校验','attachment_content_mismatch',`「${basename(file.originalname)}」的内容与文件类型不符。`,'请重新选择未损坏的 PNG、JPG、WebP、PDF、DOCX、TXT 或 Markdown 文件。');
}

export function saveUploads(input: unknown): SavedAttachment[] {
  const files = (Array.isArray(input) ? input : []) as UploadFile[];
  if (files.length > 5) throw new AIError('附件校验','too_many_attachments','一次最多添加 5 个文件。');
  if (files.reduce((sum,file)=>sum+file.size,0) > 20*mib) throw new AIError('附件校验','attachment_total_too_large','本次附件合计不能超过 20 MiB。');
  const prepared = files.map((file) => {
    const ext=extname(file.originalname).toLowerCase(), type=types[ext];
    if (!type) throw new AIError('附件校验','unsupported_attachment_type',`不支持「${basename(file.originalname)}」。`,'支持 PNG、JPG、WebP、PDF、DOCX、TXT 和 Markdown。');
    validate(file,type);
    return { id: randomUUID(), filename: basename(file.originalname).slice(0,180), mimeType:type.mime, size:file.size, diskName:`${randomUUID()}.bin`, buffer:file.buffer };
  });
  const written:string[]=[];
  try {
    for (const file of prepared) { writeFileSync(join(attachmentDir,file.diskName),file.buffer,{flag:'wx',mode:0o600}); written.push(file.diskName); }
    db.transaction(()=>{
      const insert=db.prepare('INSERT INTO ai_attachments(id,draft_id,filename,mime_type,size,disk_name,created_at) VALUES(?,NULL,?,?,?,?,?)');
      for (const file of prepared) insert.run(file.id,file.filename,file.mimeType,file.size,file.diskName,now());
    }).immediate();
  } catch(error) { for (const name of written) try { unlinkSync(join(attachmentDir,name)); } catch {} throw error; }
  return prepared.map(({id,filename,mimeType,size})=>({id,filename,mimeType,size,url:`/api/attachments/${id}`}));
}

export function listAttachments(ids: string[]): SavedAttachment[] {
  if (!ids.length) return [];
  const found = db.prepare(`SELECT id,filename,mime_type AS mimeType,size FROM ai_attachments WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as Omit<SavedAttachment,'url'>[];
  if (found.length !== new Set(ids).size) throw new AIError('附件校验','attachment_expired','有附件已不存在，请重新附加后再试。');
  const byId=new Map(found.map(file=>[file.id,file]));
  return ids.map(id=>{const file=byId.get(id)!;return {...file,url:`/api/attachments/${id}`};});
}

export function attachToDraft(draftId:string,ids:string[]) {
  const available=listAttachments(ids);
  if(available.length>5||available.reduce((sum,file)=>sum+file.size,0)>20*mib) throw new AIError('附件校验','attachment_total_too_large','草稿附件合计不能超过 20 MiB。');
  if (!ids.length) return available;
  const update=db.prepare('UPDATE ai_attachments SET draft_id=? WHERE id=? AND (draft_id IS NULL OR draft_id=?)');
  const trx=db.transaction(()=>{for(const id of ids){const result=update.run(draftId,id,draftId);if(result.changes!==1) throw new AIError('附件校验','attachment_in_use','有附件已关联到另一条待处理记录。','重新上传该附件后重试。');}});
  trx.immediate();
  db.prepare('UPDATE ai_drafts SET attachment_ids=?,attachment_meta=? WHERE id=?').run(JSON.stringify(ids),JSON.stringify(available.map(({id,filename,mimeType,size})=>({id,filename,mimeType,size}))),draftId);
  return available;
}

export function draftAttachments(draftId:string):SavedAttachment[] {
  return (db.prepare('SELECT id,filename,mime_type AS mimeType,size FROM ai_attachments WHERE draft_id=? ORDER BY created_at,id').all(draftId) as Omit<SavedAttachment,'url'>[])
    .map(file=>({...file,url:`/api/attachments/${file.id}`}));
}

export function readAttachment(fileId:string) {
  const row=db.prepare('SELECT filename,mime_type AS mimeType,size,disk_name AS diskName FROM ai_attachments WHERE id=?').get(fileId) as {filename:string;mimeType:string;size:number;diskName:string}|undefined;
  if(!row) throw new AIError('附件读取','attachment_not_found','待处理附件已不存在。','请重新附加文件后重试。');
  const path=join(attachmentDir,row.diskName);
  if(!existsSync(path)) throw new AIError('附件读取','attachment_missing','待处理附件文件无法读取。','请重新附加文件后重试。');
  return {...row,buffer:readFileSync(path)};
}

function removeStoredFile(diskName:string) {
  try { unlinkSync(join(attachmentDir,diskName)); return true; }
  catch(error) { return (error as NodeJS.ErrnoException).code==='ENOENT'; }
}

export function cleanupDraftAttachments(draftId:string) {
  const rows=db.prepare('SELECT id,disk_name AS diskName FROM ai_attachments WHERE draft_id=?').all(draftId) as {id:string;diskName:string}[];
  db.prepare("UPDATE ai_drafts SET attachment_ids='[]' WHERE id=?").run(draftId);
  for(const row of rows) if(removeStoredFile(row.diskName)) db.prepare('DELETE FROM ai_attachments WHERE id=?').run(row.id);
}

export function purgeAllAttachments() {
  const rows=db.prepare('SELECT id,disk_name AS diskName FROM ai_attachments').all() as {id:string;diskName:string}[];
  const tracked=new Set(rows.map(row=>row.diskName));
  for(const row of rows) if(removeStoredFile(row.diskName)) db.prepare('DELETE FROM ai_attachments WHERE id=?').run(row.id);
  for(const name of readdirSync(attachmentDir).filter(name=>name.endsWith('.bin')&&!tracked.has(name))) removeStoredFile(name);
}

export function retryAttachmentCleanup() {
  const cutoff=new Date(Date.now()-24*60*60_000).toISOString();
  const rows=db.prepare("SELECT a.id,a.disk_name AS diskName FROM ai_attachments a LEFT JOIN ai_drafts d ON d.id=a.draft_id WHERE d.status IN ('applied','dismissed') OR (a.draft_id IS NULL AND a.created_at<?)").all(cutoff) as {id:string;diskName:string}[];
  for(const row of rows) if(removeStoredFile(row.diskName)) db.prepare('DELETE FROM ai_attachments WHERE id=?').run(row.id);
}
retryAttachmentCleanup();
const cleanupTimer=setInterval(retryAttachmentCleanup,60_000);cleanupTimer.unref();

export function removeDraftAttachment(draftId:string,fileId:string) {
  const row=db.prepare('SELECT disk_name AS diskName FROM ai_attachments WHERE id=? AND draft_id=?').get(fileId,draftId) as {diskName:string}|undefined;
  if(!row) throw new AIError('附件删除','attachment_not_found','找不到这条草稿中的附件。');
  const draft=db.prepare('SELECT attachment_ids,attachment_meta FROM ai_drafts WHERE id=?').get(draftId) as {attachment_ids:string;attachment_meta:string}|undefined;
  const next=(JSON.parse(draft?.attachment_ids ?? '[]') as string[]).filter(id=>id!==fileId);
  const meta=(JSON.parse(draft?.attachment_meta??'[]') as {id?:string}[]).filter(file=>file.id!==fileId);
  if(!removeStoredFile(row.diskName)) throw new AIError('附件删除','attachment_cleanup_failed','附件暂时无法删除。','请关闭占用文件的程序后重试；后台会继续尝试清理。');
  db.transaction(()=>{db.prepare('DELETE FROM ai_attachments WHERE id=?').run(fileId);db.prepare('UPDATE ai_drafts SET attachment_ids=?,attachment_meta=?,updated_at=? WHERE id=?').run(JSON.stringify(next),JSON.stringify(meta),now(),draftId);}).immediate();
}

export function deleteUpload(fileId:string) {
  const row=db.prepare('SELECT draft_id,disk_name AS diskName FROM ai_attachments WHERE id=?').get(fileId) as {draft_id:string|null;diskName:string}|undefined;
  if(!row) return false;
  if(row.draft_id) throw new AIError('附件删除','attachment_attached','这份文件属于一条已保存的待处理建议。','忽略该建议或打开建议移除附件。');
  if(!removeStoredFile(row.diskName)) throw new AIError('附件删除','attachment_cleanup_failed','附件暂时无法删除。','请关闭占用文件的程序后重试。');
  db.prepare('DELETE FROM ai_attachments WHERE id=?').run(fileId);
  return true;
}
