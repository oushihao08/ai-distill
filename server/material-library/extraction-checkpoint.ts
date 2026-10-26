/** 职责：材料库提取的私有单文件检查点；runner显式重试时读取，不发布、不派发、不修改原件。 */
import {lstat,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {logEvent} from '../logging';
import {MINERU_DOCX_VERSION,MINERU_OCR_VERSION} from '../materials/pdf-extraction/mineru-cli';
import {ensurePages,hash,jobDirectory} from './execution-shared';

type CheckpointJob={id:string;package_id:string;revision_id:string;previous_job_id?:string|null;config_digest:string;config_snapshot?:{pdf_provider?:string};input_snapshot:{manifest_sha256?:string;files?:unknown[]}};
type CheckpointFile={file_id:string;source_sha256:string;format:string};
type Document=ReturnType<typeof ensurePages>;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// v1绑定整份任务配置，仅用于历史读取；不能从其摘要猜测哪些设置曾经影响提取。
function legacyIdentity(job:CheckpointJob,file:CheckpointFile){return hash({version:1,package_id:job.package_id,revision_id:job.revision_id,manifest:job.input_snapshot.manifest_sha256,files:job.input_snapshot.files,config:job.config_digest,file,converter:file.format==='docx'?MINERU_DOCX_VERSION:MINERU_OCR_VERSION});}

/** v2仅绑定真正执行的提取条件。完整任务配置仍被冻结，但脱敏模型/模板/旧provider_config/调度预算不决定OCR复用。 */
function identity(job:CheckpointJob,file:CheckpointFile){
 const provider=file.format==='txt'||file.format==='md'?'local':file.format==='docx'?'mineru-api':job.config_snapshot?.pdf_provider;
 if(!provider||!['local','mineru-api','mineru-cli'].includes(provider))throw new Error('checkpoint missing extraction provider');
 const converter=file.format==='docx'?MINERU_DOCX_VERSION:provider==='local'?'local-utf8-v1':MINERU_OCR_VERSION;
 return hash({version:2,package_id:job.package_id,revision_id:job.revision_id,manifest:job.input_snapshot.manifest_sha256,files:job.input_snapshot.files,file,provider,converter});
}
function degraded(reason_code:string){logEvent('library_job.recovery_degraded',{level:'warn',reason_code});}

/** 从受管根逐层拒绝软链接；检查点不可用只降级，不影响有效提取。 */
async function directory(root:string,jobId:string,create:boolean){
 if(!uuid.test(jobId))throw new Error('invalid checkpoint job');
 const base=resolve(root),target=join(jobDirectory(root,jobId),'extraction');
 let current=base;
 for(const part of relative(base,target).split(sep)){
  current=join(current,part);
  if(create)await mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const info=await lstat(current);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('unsafe checkpoint directory');
 }
 return target;
}

export async function readExtractionCheckpoint(root:string,job:CheckpointJob,file:CheckpointFile):Promise<{document:Document;provider:string}|undefined>{
 if(!job.previous_job_id)return;
 try{
  if(!uuid.test(file.file_id))throw new Error('invalid checkpoint file');
  const path=join(await directory(root,job.previous_job_id,false),`${file.file_id}.json`),info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('unsafe checkpoint file');
  const record=JSON.parse(await readFile(path,'utf8'));
  if(record.version!==undefined&&record.version!==2)throw new Error('unsupported checkpoint version');
  const expected=record.version===2?identity(job,file):legacyIdentity(job,file);
  if(record.identity!==expected||record.sha256!==hash(record.document)||record.document?.source_sha256!==file.source_sha256)throw new Error('checkpoint mismatch');
  if(!['local','mineru-api','mineru-cli','glm-ocr'].includes(record.provider))throw new Error('invalid checkpoint provider');
  return{document:ensurePages(record.document.pages,file.source_sha256),provider:record.provider};
 }catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')degraded('checkpoint_unusable');
  return;
 }
}

export async function writeExtractionCheckpoint(root:string,job:CheckpointJob,file:CheckpointFile,document:Document,provider='local'):Promise<boolean>{
 let temporary:string|undefined;
 try{
  if(!uuid.test(file.file_id))throw new Error('invalid checkpoint file');
  const path=join(await directory(root,job.id,true),`${file.file_id}.json`);
  temporary=`${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify({version:2,identity:identity(job,file),sha256:hash(document),document,provider}),{mode:0o600,flag:'wx'});
  await rename(temporary,path);
  return true;
 }catch(error){
  degraded('checkpoint_write_failed');
  if(temporary)await rm(temporary,{force:true}).catch(()=>degraded('checkpoint_cleanup_failed'));
  return false;
 }
}

/** 只清理已校验为本job私有目录的内容；辅助清理失败不反转已提交的成功结果。 */
export async function cleanupExtractionArtifacts(root:string,jobId:string){
 try{await directory(root,jobId,false);await rm(jobDirectory(root,jobId),{recursive:true,force:true});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')degraded('checkpoint_cleanup_failed');}
}
