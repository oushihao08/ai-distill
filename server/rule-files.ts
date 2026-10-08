import {readdir,lstat,readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve,posix} from 'node:path';
import {createHash} from 'node:crypto';
import {HTTPException} from 'hono/http-exception';
import {validateFolder} from './project-folders';
export interface RuleFile {path:string;sha256:string;size_bytes:number}
export interface RuleWorkspace {workspace_path:string;skill_path:string;files:RuleFile[];source_digest:string;assessment:Record<string,unknown>;unresolved:{id:string;detail?:string}[];issues:string[]}
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const fileSignature=(files:RuleFile[])=>JSON.stringify(files.map(file=>[file.path,file.sha256,file.size_bytes]));
async function info(path:string){try{return await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
function localPath(path:string){if(!path||path.startsWith('/')||/[\\\x00-\x1f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw new HTTPException(400,{message:'规则文件路径无效'});return path;}
async function inventory(root:string,prefix='',ignoreHidden=true):Promise<RuleFile[]>{
 try{
  const files:RuleFile[]=[];
  async function visit(path:string,key:string){
   try{
    const value=await info(path);if(!value)return;
    if(value.isSymbolicLink())throw new HTTPException(400,{message:'规则目录不支持符号链接'});
    if(value.isDirectory()){for(const entry of await readdir(path))if(!ignoreHidden||!entry.startsWith('.'))await visit(join(path,entry),key?`${key}/${entry}`:entry);}
    else if(value.isFile()){
     if(value.size>30*1024*1024||files.length>=500)throw new HTTPException(400,{message:'规则包超过单文件30MB或500文件限制'});
     const bytes=await readFile(path);files.push({path:key,sha256:hash(bytes),size_bytes:bytes.length});
    }
   }catch(error){throw error;}
  }
  await visit(root,prefix);return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 }catch(error){throw error;}
}
function sourcePath(view:RuleWorkspace,path:string){return path.startsWith('skill/')?join(view.skill_path,path.slice(6)):join(view.workspace_path,path);}
export async function scanRuleWorkspace(root:string,skill:string):Promise<RuleWorkspace>{
 try{
  root=await validateFolder(root,'项目工作区');skill=await validateFolder(skill,'本地skill目录');
  const manifestInfo=await info(join(root,'project.json'));
  if(manifestInfo?.isSymbolicLink())throw new HTTPException(400,{message:'规则目录不支持符号链接'});
  let metadata:Record<string,unknown>={};const manifestBytes=manifestInfo?await readFile(join(root,'project.json')):undefined;
  if(manifestBytes){try{metadata=JSON.parse(manifestBytes.toString('utf8'));if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw new Error('invalid');}catch{throw new HTTPException(400,{message:'项目project.json格式无效'});}}
  const files=[...await inventory(join(root,'materials'),'materials'),...await inventory(skill,'skill')];
  if(manifestBytes)files.push({path:'project.json',sha256:hash(manifestBytes),size_bytes:manifestBytes.length});
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  if(files.reduce((total,file)=>total+file.size_bytes,0)>100*1024*1024)throw new HTTPException(400,{message:'规则包超过100MB限制'});
  const known=new Set(files.map(file=>file.path));const issues:string[]=[];
  if(!files.some(file=>file.path.startsWith('materials/')))issues.push('缺少本期规则资料');
  if(!known.has('skill/SKILL.md'))issues.push('缺少skill/SKILL.md入口');
  const view:RuleWorkspace={workspace_path:root,skill_path:skill,files,issues,source_digest:hash(JSON.stringify([root,skill,fileSignature(files)])),assessment:metadata.assessment&&typeof metadata.assessment==='object'&&!Array.isArray(metadata.assessment)?metadata.assessment as Record<string,unknown>:{},unresolved:Array.isArray(metadata.unresolved)?metadata.unresolved.filter(item=>item&&typeof item==='object'&&typeof item.id==='string'):[]};
  for(const file of files.filter(file=>file.path.startsWith('skill/')&&file.path.endsWith('.md'))){
   const body=await readFile(sourcePath(view,file.path),'utf8');
   if(file.path==='skill/SKILL.md'&&!/^---\r?\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*\S+[\s\S]*?\r?\n---/.test(body))issues.push('SKILL.md缺少name或description元数据');
   for(const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
    const target=match[1]!.trim().replace(/^<|>$/g,'');if(/^(https?:|mailto:|#)/i.test(target))continue;
    let decoded:string;try{decoded=decodeURIComponent(target.split('#')[0]!);}catch{issues.push(`规则引用无效：${file.path}`);continue;}
    const key=posix.normalize(posix.join(posix.dirname(file.path),decoded));
    if(decoded.startsWith('/')||!key.startsWith('skill/')||!known.has(key))issues.push(`规则引用缺失或越界：${file.path} → ${target}`);
   }
  }
  return view;
 }catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(400,{message:'规则工作区无法读取'});}
}
export async function verifyRuleSnapshot(root:string,files:RuleFile[]):Promise<void>{
 try{const actual=await inventory(root,'',false);if(fileSignature(actual)!==fileSignature(files))throw new Error('changed');}
 catch{throw new HTTPException(409,{message:'规则快照缺失、被修改或混入其他文件，停止使用'});}
}
export async function freezeRuleWorkspace(view:RuleWorkspace,id:string):Promise<string>{
 let destination:string|undefined;let created=false;
 try{
  if(view.issues.length)throw new HTTPException(409,{message:`规则入口或引用不完整：${view.issues.join('；')}`});
  if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new HTTPException(400,{message:'快照标识无效'});
  const parent=join(view.workspace_path,'snapshots');await mkdir(parent,{recursive:true,mode:0o700});
  if((await lstat(parent)).isSymbolicLink())throw new HTTPException(400,{message:'快照目录不支持符号链接'});
  destination=join(parent,id);await mkdir(destination,{mode:0o700});created=true;
  for(const file of view.files){const bytes=await readFile(sourcePath(view,file.path));if(hash(bytes)!==file.sha256)throw new HTTPException(409,{message:'规则资料已变化，请刷新后发布'});const target=join(destination,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{mode:0o600,flag:'wx'});}
  if((await scanRuleWorkspace(view.workspace_path,view.skill_path)).source_digest!==view.source_digest)throw new HTTPException(409,{message:'规则资料已变化，请刷新后发布'});
  await verifyRuleSnapshot(destination,view.files);return destination;
 }catch(error){if(created&&destination)await rm(destination,{recursive:true,force:true});throw error;}
}
export async function readRuleFile(root:string,path:string):Promise<Uint8Array>{
 try{
  localPath(path);let current=resolve(root);
  for(const part of path.split('/')){current=join(current,part);const value=await info(current);if(!value)throw new HTTPException(404,{message:'规则文件不存在'});if(value.isSymbolicLink())throw new HTTPException(400,{message:'规则目录不支持符号链接'});}
  return await readFile(current);
 }catch(error){throw error;}
}
export async function changeRuleFile(root:string,path:string,bytes:Uint8Array|null,expected:string|null):Promise<void>{
 let temporary:string|undefined;
 try{
  localPath(path);
  if(!path.startsWith('materials/')||! /\.(md|txt|json|csv|docx|xlsx|pdf|png|jpe?g|html)$/i.test(path))throw new HTTPException(400,{message:'只能修改materials目录中的支持文件，路径无效'});
  if(bytes&&(!bytes.length||bytes.length>30*1024*1024))throw new HTTPException(400,{message:'规则资料须大于0且不超过30MB'});
  let parent=resolve(root);for(const part of path.split('/').slice(0,-1)){parent=join(parent,part);await mkdir(parent,{recursive:true,mode:0o700});if((await lstat(parent)).isSymbolicLink())throw new HTTPException(400,{message:'规则目录不支持符号链接'});}
  const target=join(resolve(root),path),current=await info(target);
  if(current?.isSymbolicLink()||current?.isDirectory())throw new HTTPException(400,{message:'规则文件路径不支持符号链接或目录'});
  if(current ? !expected||hash(await readFile(target))!==expected : expected!==null)throw new HTTPException(409,{message:'规则文件已变化，请刷新后修改'});
  if(!bytes){if(!current)throw new HTTPException(404,{message:'规则文件不存在'});await rm(target);return;}
  if(!current){await writeFile(target,bytes,{mode:0o600,flag:'wx'});return;}
  temporary=join(parent,`.pending-${crypto.randomUUID()}`);await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,target);temporary=undefined;
 }catch(error){throw error;}
 finally{if(temporary)await rm(temporary,{force:true});}
}
