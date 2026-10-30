/**
 * 职责：接口输入边界：校验 UUID、文字、来源标识，以及支持材料的扩展名、大小和文件标识。
 * 关键方法与用途：`uuid()`、`text()`、`questionTags()`、`sourceKey()` 和 `validateFile()` 校验 API 输入及材料扩展名、大小和标识。
 * 使用场景：项目目录和路由入口在创建任务或接收材料前调用。
 */
import { HTTPException } from 'hono/http-exception';
export const MAX_FILE = Number(process.env.PDF_MAX_SIZE_MB ?? 50) * 1024 * 1024;
export const MAX_BATCH = 100 * 1024 * 1024;
export const MAX_FOLDER_BATCH = 200 * 1024 * 1024;
/** HTTP封装余量不计入业务文件总量；库级导入和版本上传采用200MiB。 */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_FOLDER_BATCH + 1024 * 1024;
export const MAX_DEFAULT_REQUEST_BYTES = MAX_BATCH + 1024 * 1024;
/** 只放宽材料库导入及版本multipart上传；其余请求沿用原预算。 */
export function requestBodyLimit(path:string,method:string):number{
 return method==='POST'&&/^\/api\/material-library\/(?:imports|packages\/[^/]+\/revisions)$/.test(path)?MAX_UPLOAD_REQUEST_BYTES:MAX_DEFAULT_REQUEST_BYTES;
}
export function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new HTTPException(400, { message: '无效的记录ID' });
  return value;
}
export function text(value: unknown, field: string, max: number, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new HTTPException(400, { message: `${field}须为${required ? '非空' : ''}文本，最多${max}字` });
  return value.trim();
}
export function questionTags(value: unknown) {
  if (!Array.isArray(value) || value.length > 50) throw new HTTPException(400, { message: '项目标签须为最多50项的列表' });
  const tags = value.map(item => text(item, '项目标签', 80));
  if (new Set(tags).size !== tags.length) throw new HTTPException(400, { message: '项目标签不能重复' });
  return tags;
}
export function sourceKey(value: unknown) {
  if (value === null || value === undefined) return null;
  const key = text(value, '题目目录标识', 500);
  if (key.startsWith('/') || /[\\\x00-\x1f]/.test(key) || key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new HTTPException(400, { message: '题目目录标识须为相对路径，不能包含空目录、.或..' });
  }
  return key;
}
export function validateFile(file: File, bytes: Uint8Array) {
  const extension=file.name.split('.').at(-1)?.toLowerCase();
  if (!['pdf','docx','txt','md'].includes(extension??'')) throw new HTTPException(400, { message: '仅支持PDF、DOCX、TXT和MD文件' });
  if (file.size > MAX_FILE) throw new HTTPException(400, { message: `单个文件不能超过${MAX_FILE/1024/1024}MB` });
  if(extension==='pdf'&&new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new HTTPException(400,{message:'文件缺少PDF标识，请提供有效PDF'});
  if(extension==='docx'&& (bytes.length<4||new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true)!==0x04034b50))throw new HTTPException(400,{message:'DOCX文件缺少有效压缩包标识'});
  if(extension==='txt'||extension==='md')try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HTTPException(400,{message:`${extension.toUpperCase()}文件不是有效UTF-8文本`});}
  // Parsing belongs to ingestion; validation checks type and bounded file size only.
}
