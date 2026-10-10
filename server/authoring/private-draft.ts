/**
 * 职责：返修私有草稿读取：限制工作区路径，恢复并校验当前尝试或旧目录格式的出题草稿。
 * 关键方法与用途：`readPrivateDraft()` 优先读取数据库完整草稿，并按受限路径兼容历史本地草稿，并校验附件与标答。
 * 使用场景：由出题队列在返修恢复时调用，不向公开 API 暴露私有文件路径。
 */
import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {validateDraft,type Draft} from './validate';
export async function readPrivateDraft(root:string,workflowId:string,attemptId:string,materials:{id:string;text:string}[],storedResult?:unknown):Promise<Draft>{
 // 新任务完整草稿已入库；缺少字段的历史任务继续兼容本地私有草稿。
 if(storedResult&&typeof storedResult==='object'&&('reference_answer' in storedResult||'answer_approach' in storedResult))return validateDraft(storedResult,materials);
 const base=await realpath(resolve(root));
 const privateRoot=await realpath(join(base,workflowId,attemptId,'private'));
 if(privateRoot!==join(base,workflowId,attemptId,'private')||!privateRoot.startsWith(base+'/'))throw new Error('unsafe revision workspace');
 async function load(path:string,legacy=false){
  const actual=await realpath(path);
  if(!actual.startsWith(privateRoot+'/'))throw new Error('unsafe revision draft');
  const info=await stat(actual);if(!info.isFile()||info.size>30*1024*1024)throw new Error('invalid private draft');
  const value=JSON.parse(await readFile(actual,'utf8'));
  return validateDraft(legacy?value.draft:value,materials);
 }
 try{return await load(join(privateRoot,'draft.json'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const directories=(await readdir(privateRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith('authoring-'));
 if(directories.length!==1)throw new Error('missing or ambiguous private draft');
 // Older attempts kept their complete draft in the independent review input.
 // Read it in place; never reconstruct a reference answer from public output.
 return await load(join(privateRoot,directories[0]!.name,'review','input','input.json'),true);
}
