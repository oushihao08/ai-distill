/**
 * 职责：校验已准备完成的 Work Harbor 单题目录，并组装批次目录与 ZIP。
 * 关键入口：`buildBatchPackage()` 供本地批次 CLI 使用；缺失官方固定脚本或题包缺项即失败关闭。
 */
import {createHash,randomUUID} from 'node:crypto';
import {copyFile,lstat,mkdir,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,sep} from 'node:path';

type TaskInput={id:string;directory:string};
type Manifest={batch_name:string;output_directory:string;delivery_document:string;official_templates:{test_sh:string;finalize_py:string};tasks:TaskInput[]};
type FileEntry={path:string;sha256:string;size:number;mode:number};
type BatchResult={batch_name:string;task_count:number;directory:string;zip_path:string;zip_bytes:number};

const taskId=/^LAW-\d{3,}$/;
const maxZipBytes=20_000_000_000;
const forbidden=new Set(['.git','.venv','__pycache__','node_modules','__MACOSX','.DS_Store','reward.json','reward-details.json','logs','jobs']);
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const inside=(parent:string,child:string)=>child!==parent&&child.startsWith(parent+sep);

function parseManifest(value:unknown):Manifest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('批次 manifest 格式无效');
 const input=value as Partial<Manifest>;
 if(typeof input.batch_name!=='string'||!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(input.batch_name)||input.batch_name==='.'||input.batch_name==='..')throw new Error('批次目录名无效');
 if(typeof input.output_directory!=='string'||!input.output_directory.trim())throw new Error('output_directory 缺失');
 if(typeof input.delivery_document!=='string'||!input.delivery_document.trim())throw new Error('交付文档路径缺失');
 if(!input.official_templates||typeof input.official_templates.test_sh!=='string'||typeof input.official_templates.finalize_py!=='string')throw new Error('必须提供完整官方 tests/test.sh 与 tests/finalize.py 原件');
 if(!Array.isArray(input.tasks)||input.tasks.length===0)throw new Error('至少需要一个题目目录');
 const seen=new Set<string>();
 for(const task of input.tasks){
  if(!task||!taskId.test(task.id)||seen.has(task.id)||typeof task.directory!=='string'||!task.directory.trim())throw new Error('题目 ID 或目录无效');
  seen.add(task.id);
 }
 return input as Manifest;
}

async function inventory(root:string):Promise<FileEntry[]>{
 const entries:FileEntry[]=[];
 const walk=async(directory:string,relative=''):Promise<void>=>{
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const rel=relative?`${relative}/${entry.name}`:entry.name;
   if(Buffer.byteLength(entry.name,'utf8')>200||/[\u0000-\u001f\u007f]/.test(entry.name))throw new Error(`文件名不符合交付要求：${rel}`);
   if(forbidden.has(entry.name)||entry.name.startsWith('._'))throw new Error(`题包包含禁止交付内容：${rel}`);
   const path=join(directory,entry.name),info=await lstat(path);
   if(info.isSymbolicLink())throw new Error(`题包禁止符号链接：${rel}`);
   if(info.isDirectory()){await walk(path,rel);continue;}
   if(!info.isFile())throw new Error(`题包包含非普通文件：${rel}`);
   const bytes=await readFile(path);
   entries.push({path:rel,sha256:sha(bytes),size:bytes.byteLength,mode:info.mode});
  }
 };
 await walk(root);
 return entries.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}

function requireFile(entries:FileEntry[],path:string,maxBytes?:number):FileEntry{
 const file=entries.find(item=>item.path===path);
 if(!file)throw new Error(`题包缺少必交文件：${path}`);
 if(maxBytes!==undefined&&file.size>maxBytes)throw new Error(`${path} 超过 ${maxBytes} 字节限制`);
 return file;
}

function requireTree(entries:FileEntry[],prefix:string):FileEntry[]{
 const found=entries.filter(item=>item.path.startsWith(`${prefix}/`));
 if(!found.length)throw new Error(`${prefix} 必须包含实际文件`);
 return found.map(item=>({...item,path:item.path.slice(prefix.length+1)}));
}

function tomlStringInSection(source:string,section:string,key:string):string|undefined{
 let current='';
 for(const line of source.split(/\r?\n/)){
  const table=line.trim().match(/^\[\[?([A-Za-z0-9_.-]+)\]?\]$/);
  if(table){current=table[1];continue;}
  if(current!==section)continue;
  const value=line.trim().match(new RegExp(`^${key}\\s*=\\s*"([^"\\r\\n]*)"\\s*(?:#.*)?$`));
  if(value)return value[1];
 }
 return undefined;
}

async function validateTask(task:TaskInput,official:{test_sh:string;finalize_py:string}):Promise<FileEntry[]>{
 const root=resolve(task.directory),info=await lstat(root);
 if(!info.isDirectory()||info.isSymbolicLink())throw new Error(`${task.id} 目录不存在或不是普通目录`);
 const entries=await inventory(root);
 for(const path of ['instruction.md','task.toml','rubrics.json','environment/Dockerfile','environment/requirements.txt','solution/solve.sh','tests/test.sh','tests/finalize.py','tests/rubrics.toml','tests/prompt.md'])requireFile(entries,path,path==='instruction.md'||path==='task.toml'?1024*1024:path==='tests/rubrics.toml'?2*1024*1024:undefined);
 const taskToml=await readFile(join(root,'task.toml'),'utf8');
 if(!/^\s*schema_version\s*=\s*"1\.4"\s*$/m.test(taskToml)||tomlStringInSection(taskToml,'metadata','task_id')!==task.id||tomlStringInSection(taskToml,'task','name')?.split('/').at(-1)!==task.id)throw new Error(`${task.id} task.toml 的 schema_version、metadata.task_id 或 task.name 不符合题目 ID`);
 try{JSON.parse(await readFile(join(root,'rubrics.json'),'utf8'));}catch{throw new Error(`${task.id} rubrics.json 不是有效 JSON`);}
 requireTree(entries,'environment/input_files');
 const golden=requireTree(entries,'solution/golden_output');
 const scoredGolden=requireTree(entries,'tests/__golden_output');
 if(golden.length!==scoredGolden.length||golden.some((file,index)=>file.path!==scoredGolden[index].path||file.sha256!==scoredGolden[index].sha256))throw new Error(`${task.id} 两份 golden 目录结构或文件内容不一致`);
 const solve=requireFile(entries,'solution/solve.sh');
 if((solve.mode&0o111)===0)throw new Error(`${task.id} solution/solve.sh 必须具有可执行权限`);
 for(const path of ['solution/solve.sh','tests/test.sh']){
  const bytes=await readFile(join(root,path));
  if(bytes.includes(13))throw new Error(`${task.id} ${path} 必须使用 LF 换行`);
  if(path==='tests/test.sh'&&(entries.find(item=>item.path===path)!.mode&0o111)===0)throw new Error(`${task.id} tests/test.sh 必须具有可执行权限`);
 }
 const templateChecks=[['tests/test.sh',official.test_sh],['tests/finalize.py',official.finalize_py]] as const;
 for(const [path,source] of templateChecks){
  let authoritative:Uint8Array;
  try{authoritative=await readFile(source);}catch{throw new Error(`缺少完整官方固定模板原件：${path}`);}
  if(authoritative.byteLength===0)throw new Error(`官方固定模板原件为空：${path}`);
  if(sha(authoritative)!==requireFile(entries,path).sha256)throw new Error(`${task.id} ${path} 与提供的官方原件不一致`);
 }
 return entries;
}

/** 校验全部题目后才创建任何交付产物；目标已存在时拒绝覆盖。 */
export async function buildBatchPackage(value:unknown):Promise<BatchResult>{
 const manifest=parseManifest(value);
 const output=resolve(manifest.output_directory),batchTarget=join(output,manifest.batch_name),zipTarget=join(output,`${manifest.batch_name}.zip`);
 for(const task of manifest.tasks){
  const source=resolve(task.directory);
  if(source===output||inside(source,output)||inside(output,source))throw new Error('输出目录不得与任何题目源目录重叠');
 }
 const documentPath=resolve(manifest.delivery_document);
 const official={test_sh:resolve(manifest.official_templates.test_sh),finalize_py:resolve(manifest.official_templates.finalize_py)};
 const documentInfo=await lstat(documentPath).catch(()=>{throw new Error('批次交付文档不存在');});
 if(documentInfo.isSymbolicLink()||!documentInfo.isFile())throw new Error('批次交付文档必须是普通文件');
 const doc=await readFile(documentPath,'utf8');
 if(!doc.trim()||!doc.includes(manifest.batch_name)||!doc.includes(String(manifest.tasks.length)))throw new Error('交付文档必须写明准确批次目录名和题目数量');
 const allTasks: {id:string;directory:string;entries:FileEntry[]}[]=[];
 for(const task of manifest.tasks){
  for(const sourcePath of [task.directory,official.test_sh,official.finalize_py]){
   const sourceInfo=await lstat(sourcePath).catch(()=>null);
   if(sourceInfo?.isSymbolicLink())throw new Error('题包目录与官方模板不得为符号链接');
  }
  const entries=await validateTask(task,official);
  allTasks.push({...task,entries});
 }
 await mkdir(output,{recursive:true});
 for(const target of [batchTarget,zipTarget]){
  try{await lstat(target);throw new Error(`目标已存在，拒绝覆盖：${target}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 const staging=join(output,`.${manifest.batch_name}.${randomUUID()}.tmp`);
 try{
  await mkdir(staging);
  const stagedBatch=join(staging,manifest.batch_name);
  await mkdir(stagedBatch);
  await writeFile(join(stagedBatch,'交付文档.md'),doc,{flag:'wx'});
  for(const task of allTasks){
   const target=join(stagedBatch,task.id);
   if(!inside(stagedBatch,target))throw new Error('题目 ID 路径越界');
   const source=resolve(task.directory);
   await mkdir(target);
   for(const file of task.entries){
    const destination=join(target,...file.path.split('/'));
    if(!inside(target,destination))throw new Error('题包内部路径越界');
    await mkdir(join(destination,'..'),{recursive:true});
    const bytes=await readFile(join(source,...file.path.split('/')));
    if(sha(bytes)!==file.sha256)throw new Error(`${task.id}/${file.path} 在预检后发生变化`);
    await writeFile(destination,bytes,{mode:file.mode&0o777,flag:'wx'});
   }
  }
  const zipPath=join(staging,`${manifest.batch_name}.zip`);
  const proc=Bun.spawn(['zip','-qr',zipPath,manifest.batch_name],{cwd:staging,stdout:'ignore',stderr:'pipe'});
  const code=await proc.exited;
  if(code!==0)throw new Error(`ZIP 创建失败：${(await new Response(proc.stderr).text()).trim().slice(0,300)}`);
  const zipInfo=await stat(zipPath);
  if(zipInfo.size>maxZipBytes)throw new Error('整批 ZIP 超过 20 GB');
  await mkdir(batchTarget);
  try{
   for(const name of await readdir(stagedBatch))await rename(join(stagedBatch,name),join(batchTarget,name));
   await copyFile(zipPath,zipTarget,constants.COPYFILE_EXCL);
  }catch(error){await rm(batchTarget,{recursive:true,force:true});throw error;}
  return {batch_name:manifest.batch_name,task_count:allTasks.length,directory:batchTarget,zip_path:zipTarget,zip_bytes:zipInfo.size};
 }finally{await rm(staging,{recursive:true,force:true});}
}

if(import.meta.main){
 try{
  const manifestPath=process.argv[2];
  if(!manifestPath)throw new Error('用法：bun projects/Work法律全场景/scripts/harbor/batch-package.ts <manifest.json>');
  const manifest=JSON.parse(await readFile(resolve(manifestPath),'utf8')) as unknown;
  const result=await buildBatchPackage(manifest);
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
 }catch(error){
  process.stderr.write(`Work 批次打包失败：${error instanceof Error?error.message:'输入无效'}\n`);
  process.exitCode=1;
 }
}
