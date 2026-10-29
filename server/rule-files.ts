/**
 * 职责：本地项目资料边界：扫描主项目共享资料和当前生效 Skill（本期覆盖或主项目回退）、校验任务输入指纹及受限读写。
 * 关键方法与用途：`scanRuleWorkspace()` 建立当前目录清单；`readProjectPrompt()` 校验任务输入；`freezeRuleWorkspace()` 仅为skill生成任务建立私有输入副本。
 * 使用场景：项目资料 API、出题与 Skill 生成；评分仅为旧任务做绑定兼容，归档验证历史指纹，不向评分者提供项目 Skill。
 */
import {readdir,lstat,readFile,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {join,dirname,resolve,posix,isAbsolute,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {HTTPException} from 'hono/http-exception';
import {classifyLogError,logEvent} from './logging';
import {resolveProjectPath} from './paths';
import {validateFolder} from './project-folders';
export interface RuleFile {path:string;sha256:string;size_bytes:number}
export interface RuleWorkspace {workspace_path:string;materials_path:string;skill_path:string;files:RuleFile[];source_digest:string;assessment:Record<string,unknown>;unresolved:{id:string;detail?:string}[];issues:string[]}
export interface ProjectPromptSnapshot {workspace_path:string;skill_path:string;source_digest:string;files:RuleFile[]}
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
function sourcePath(view:RuleWorkspace,path:string){return path.startsWith('skill/')?join(view.skill_path,path.slice(6)):path.startsWith('materials/')?join(view.materials_path,path.slice(10)):join(view.workspace_path,path);}
export async function resolveRuleWorkspacePaths(project:{material_root?:string|null;workspace_path?:string|null;local_skill_path?:string|null}){
 const workspace=project.workspace_path?resolveProjectPath(project.workspace_path):dirname(resolveProjectPath(project.material_root??project.local_skill_path??''));
 const shared=project.local_skill_path?dirname(resolveProjectPath(project.local_skill_path)):workspace;
 const relativeWorkspace=relative(shared,workspace),sharedIsAncestor=relativeWorkspace===''||(!isAbsolute(relativeWorkspace)&&relativeWorkspace!=='..'&&!relativeWorkspace.startsWith(`..${sep}`));
 return{workspace_path:workspace,materials_path:join(sharedIsAncestor?shared:workspace,'materials')};
}
/** 本期 skill 优先；分期未建立本期 skill 时回退到主项目配置路径。 */
export async function resolveEffectiveProjectSkill(project:{workspace_path?:string|null;material_root?:string|null;local_skill_path?:string|null;parent_name?:string|null}){
 if(typeof project.local_skill_path!=='string'||!project.local_skill_path)throw new HTTPException(409,{message:'请先设置主项目 skill 目录'});
 const projectSkill=resolveProjectPath(project.local_skill_path),workspace=project.workspace_path?resolveProjectPath(project.workspace_path):dirname(project.material_root?resolveProjectPath(project.material_root):projectSkill),phaseSkill=join(workspace,'skill');
 if(project.parent_name&&phaseSkill!==projectSkill){
  const directory=await info(phaseSkill),entry=await info(join(phaseSkill,'SKILL.md'));
  if(directory?.isSymbolicLink()||entry?.isSymbolicLink())throw new HTTPException(409,{message:'本期 skill 不支持符号链接'});
  if(directory&&!directory.isDirectory())throw new HTTPException(409,{message:'本期 skill 路径不是目录'});
  if(entry&&!entry.isFile())throw new HTTPException(409,{message:'本期 skill 入口不是普通文件'});
  if(entry)return{path:phaseSkill,source:'phase' as const,project_path:projectSkill,phase_path:phaseSkill};
 }
 return{path:projectSkill,source:'project' as const,project_path:projectSkill,phase_path:project.parent_name&&phaseSkill!==projectSkill?phaseSkill:null};
}
export async function scanRuleWorkspace(root:string,skill:string,scope:'workspace'|'skill'='workspace',materialsRoot=join(root,'materials')):Promise<RuleWorkspace>{
 try{
  root=await validateFolder(root,'项目工作区');skill=await validateFolder(skill,'本地skill目录');
  materialsRoot=resolveProjectPath(materialsRoot);const materialsInfo=await info(materialsRoot);
  if(materialsInfo?.isSymbolicLink()||materialsInfo&&!materialsInfo.isDirectory())throw new HTTPException(400,{message:'规则资料目录无效'});
  if(materialsInfo)materialsRoot=await validateFolder(materialsRoot,'项目规则资料目录');
  const manifestInfo=scope==='workspace'?await info(join(root,'project.json')):undefined;
  if(manifestInfo?.isSymbolicLink())throw new HTTPException(400,{message:'规则目录不支持符号链接'});
  let metadata:Record<string,unknown>={};const manifestBytes=manifestInfo?await readFile(join(root,'project.json')):undefined;
  if(manifestBytes){try{metadata=JSON.parse(manifestBytes.toString('utf8'));if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw new Error('invalid');}catch{throw new HTTPException(400,{message:'项目project.json格式无效'});}}
  const files=[...(scope==='workspace'?await inventory(materialsRoot,'materials'):[]),...await inventory(skill,'skill')];
  if(manifestBytes)files.push({path:'project.json',sha256:hash(manifestBytes),size_bytes:manifestBytes.length});
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  if(files.reduce((total,file)=>total+file.size_bytes,0)>100*1024*1024)throw new HTTPException(400,{message:'规则包超过100MB限制'});
  const known=new Set(files.map(file=>file.path));const issues:string[]=[];
  if(scope==='workspace'&&!files.some(file=>file.path.startsWith('materials/')))issues.push('缺少主项目共享规则资料');
  if(!known.has('skill/SKILL.md'))issues.push('缺少skill/SKILL.md入口');
  const view:RuleWorkspace={workspace_path:root,materials_path:materialsRoot,skill_path:skill,files,issues,source_digest:hash(JSON.stringify([root,materialsRoot,skill,fileSignature(files)])),assessment:metadata.assessment&&typeof metadata.assessment==='object'&&!Array.isArray(metadata.assessment)?metadata.assessment as Record<string,unknown>:{},unresolved:Array.isArray(metadata.unresolved)?metadata.unresolved.filter(item=>item&&typeof item==='object'&&typeof item.id==='string'):[]};
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
/** 新任务读取当前项目目录；这份清单只绑定本次输入，不创建或递增规则版本。 */
export async function scanProjectPrompt(root:string,skill:string):Promise<ProjectPromptSnapshot>{
 const workspace=await scanRuleWorkspace(root,skill,'skill');
 const blocking=workspace.issues.filter(issue=>issue!=='缺少主项目共享规则资料');
 if(blocking.length)throw new HTTPException(409,{message:`项目提示文件不完整：${blocking.join('；')}`});
 // 作者任务只扫描有效 skill；资料管理和 Skill 生成扫描完整工作区。旧评分绑定可复用本函数，但不向评分者传入 Skill 正文。
 const files=workspace.files;
 return{workspace_path:workspace.workspace_path,skill_path:workspace.skill_path,source_digest:hash(JSON.stringify([workspace.workspace_path,workspace.skill_path,fileSignature(files)])),files};
}
/** 任务执行前重新读取当前项目文件，并核对入队时的清单，防止运行中途内容被替换。 */
export async function readProjectPrompt(snapshot:ProjectPromptSnapshot):Promise<{path:string;sha256:string;size_bytes:number;bytes:Uint8Array}[]>{
 try{
  const current=await scanProjectPrompt(snapshot.workspace_path,snapshot.skill_path);
  const result=[];
  for(const file of snapshot.files){
   const root=file.path.startsWith('skill/')?snapshot.skill_path:snapshot.workspace_path;
   const path=file.path.startsWith('skill/')?file.path.slice(6):file.path;
   const bytes=await readRuleFile(root,path);
   result.push({...file,bytes});
  }
  return result;
 }catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(409,{message:'本次任务的项目提示文件无法读取'});}
}
/** 归档／导出验证题目绑定的历史 skill 快照自洽；不拿后续编辑的当前 skill 覆盖历史输入。 */
export async function verifyFrozenProjectPrompt(snapshot:ProjectPromptSnapshot|undefined):Promise<void>{
 if(!snapshot||typeof snapshot.workspace_path!=='string'||typeof snapshot.skill_path!=='string'||typeof snapshot.source_digest!=='string'||!Array.isArray(snapshot.files))throw new HTTPException(409,{message:'缺少出题时绑定的项目 skill 指纹，不能归档或导出'});
 const invalidPath=!isAbsolute(snapshot.workspace_path)||!isAbsolute(snapshot.skill_path)||resolve(snapshot.workspace_path)!==snapshot.workspace_path||resolve(snapshot.skill_path)!==snapshot.skill_path;
 const invalidFiles=!snapshot.files.some(file=>file?.path==='skill/SKILL.md')||snapshot.files.some((file,index)=>!file||typeof file.path!=='string'||!file.path.startsWith('skill/')||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||(index>0&&(!snapshot.files[index-1]||snapshot.files[index-1]!.path>=file.path)));
 const expectedDigest=invalidFiles?'':hash(JSON.stringify([snapshot.workspace_path,snapshot.skill_path,fileSignature(snapshot.files)]));
 if(invalidPath||invalidFiles||!/^[a-f0-9]{64}$/.test(snapshot.source_digest)||snapshot.source_digest!==expectedDigest)throw new HTTPException(409,{message:'出题时绑定的项目 skill 快照无效，不能归档或导出'});
}
export async function verifyRuleSnapshot(root:string,files:RuleFile[]):Promise<void>{
 try{const actual=await inventory(root,'',false);if(fileSignature(actual)!==fileSignature(files))throw new Error('changed');}
 catch{throw new HTTPException(409,{message:'规则快照缺失、被修改或混入其他文件，停止使用'});}
}
export async function freezeRuleWorkspace(view:RuleWorkspace,id:string):Promise<string>{
 let destination:string|undefined;let created=false;
 try{
  logEvent('file.snapshot.started',{level:'info',component:'rules',file_kind:'rule_snapshot',material_count:view.files.length,input_bytes:view.files.reduce((sum,file)=>sum+file.size_bytes,0)});
  if(view.issues.length)throw new HTTPException(409,{message:`规则入口或引用不完整：${view.issues.join('；')}`});
  if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new HTTPException(400,{message:'快照标识无效'});
  const parent=join(view.workspace_path,'snapshots');await mkdir(parent,{recursive:true,mode:0o700});
  if((await lstat(parent)).isSymbolicLink())throw new HTTPException(400,{message:'快照目录不支持符号链接'});
  destination=join(parent,id);await mkdir(destination,{mode:0o700});created=true;
  for(const file of view.files){const bytes=await readFile(sourcePath(view,file.path));if(hash(bytes)!==file.sha256)throw new HTTPException(409,{message:'规则资料已变化，请刷新后发布'});const target=join(destination,file.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{mode:0o600,flag:'wx'});}
  if((await scanRuleWorkspace(view.workspace_path,view.skill_path,'workspace',view.materials_path)).source_digest!==view.source_digest)throw new HTTPException(409,{message:'规则资料已变化，请刷新后发布'});
  await verifyRuleSnapshot(destination,view.files);logEvent('file.snapshot.completed',{level:'info',component:'rules',file_kind:'rule_snapshot',material_count:view.files.length});return destination;
 }catch(error){logEvent('file.snapshot.failed',{level:'error',component:'rules',file_kind:'rule_snapshot',...classifyLogError(error)});if(created&&destination)await rm(destination,{recursive:true,force:true});throw error;}
}
export async function readRuleFile(root:string,path:string):Promise<Uint8Array>{
 try{
  logEvent('file.read.started',{level:'info',component:'rules',file_kind:'project_rule_file'});
  localPath(path);let current=resolveProjectPath(root);
  for(const part of path.split('/')){current=join(current,part);const value=await info(current);if(!value)throw new HTTPException(404,{message:'规则文件不存在'});if(value.isSymbolicLink())throw new HTTPException(400,{message:'规则目录不支持符号链接'});}
  const bytes=await readFile(current);logEvent('file.read.completed',{level:'info',component:'rules',file_kind:'project_rule_file',output_bytes:bytes.length});return bytes;
 }catch(error){logEvent('file.read.failed',{level:'error',component:'rules',file_kind:'project_rule_file',...classifyLogError(error)});throw error;}
}
export async function changeRuleFile(root:string,path:string,bytes:Uint8Array|null,expected:string|null,materialsRoot=join(root,'materials')):Promise<void>{
 let temporary:string|undefined;
 try{
  logEvent('file.change.started',{level:'info',component:'rules',file_kind:'project_rule_file',...(bytes?{input_bytes:bytes.length}:{})});
  localPath(path);
  if(!path.startsWith('materials/')||! /\.(md|txt|json|csv|docx|xlsx|pdf|png|jpe?g|html)$/i.test(path))throw new HTTPException(400,{message:'只能修改materials目录中的支持文件，路径无效'});
  if(bytes&&(!bytes.length||bytes.length>30*1024*1024))throw new HTTPException(400,{message:'规则资料须大于0且不超过30MB'});
  let parent=resolve(materialsRoot);const rootInfo=await info(parent);
  if(rootInfo?.isSymbolicLink()||rootInfo&&!rootInfo.isDirectory())throw new HTTPException(400,{message:'规则目录不支持符号链接或文件'});
  if(bytes&&!rootInfo)await mkdir(parent,{recursive:true,mode:0o700});
  const relativePath=path.slice('materials/'.length),parts=relativePath.split('/');
  for(const part of parts.slice(0,-1)){
   parent=join(parent,part);const directory=await info(parent);
   if(!directory&&bytes)await mkdir(parent,{recursive:true,mode:0o700});
   const currentDirectory=await info(parent);if(currentDirectory?.isSymbolicLink()||currentDirectory&&!currentDirectory.isDirectory())throw new HTTPException(400,{message:'规则目录不支持符号链接或文件'});
   if(!currentDirectory&&!bytes)throw new HTTPException(404,{message:'规则文件不存在'});
  }
  const target=join(resolve(materialsRoot),relativePath),current=await info(target);
  if(current?.isSymbolicLink()||current?.isDirectory())throw new HTTPException(400,{message:'规则文件路径不支持符号链接或目录'});
  if(current ? !expected||hash(await readFile(target))!==expected : expected!==null)throw new HTTPException(409,{message:'规则文件已变化，请刷新后修改'});
  if(!bytes){if(!current)throw new HTTPException(404,{message:'规则文件不存在'});await rm(target);logEvent('file.change.completed',{level:'info',component:'rules',file_kind:'project_rule_file',state:'deleted'});return;}
  if(!current){await writeFile(target,bytes,{mode:0o600,flag:'wx'});logEvent('file.change.completed',{level:'info',component:'rules',file_kind:'project_rule_file',output_bytes:bytes.length});return;}
  temporary=join(parent,`.pending-${crypto.randomUUID()}`);await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,target);temporary=undefined;logEvent('file.change.completed',{level:'info',component:'rules',file_kind:'project_rule_file',output_bytes:bytes.length});
 }catch(error){logEvent('file.change.failed',{level:'error',component:'rules',file_kind:'project_rule_file',...classifyLogError(error)});throw error;}
 finally{if(temporary)await rm(temporary,{force:true});}
}
