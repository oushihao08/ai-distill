/**
 * 职责：统一仓库内配置路径，避免服务启动目录改变材料和存储位置。
 * 公开入口：仓库/存储解析，以及项目目录引用的保存与本机解析；供 API、worker和工具使用。
 * 项目配置保存仓库相对路径；旧ai-distill仓库内绝对路径按稳定项目子树映射，不改历史快照。
 * 存储、凭证和仓库外历史来源仍保持原语义，不把项目目录映射应用到它们。
 */
import {resolve,relative,isAbsolute,sep,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HTTPException} from 'hono/http-exception';
export const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
export function resolveRepositoryPath(path:string){return resolve(repositoryRoot,path);}
export function storageDirectory(env:NodeJS.ProcessEnv=process.env){return resolveRepositoryPath(env.STORAGE_DIR??'.storage');}

/** 项目配置专用：优先当前仓库，兼容另一台机器的旧ai-distill/projects及托管project-skills绝对路径。 */
export function resolveProjectPath(value:string):string{
 const portable=value.replaceAll('\\','/');
 const absolute=isAbsolute(value)||win32.isAbsolute(value);
 if(absolute){
  const local=relative(repositoryRoot,resolve(value));
  if(local===''||(!isAbsolute(local)&&local!=='..'&&!local.startsWith(`..${sep}`)))return resolve(value);
  for(const tree of ['projects/','.storage/project-skills/']){
   const marker=`/ai-distill/${tree}`,index=portable.lastIndexOf(marker);
   if(index<0)continue;
   const suffix=portable.slice(index+marker.length);
   if(suffix.split('/').some(part=>part==='.'||part==='..'||!part))throw new HTTPException(400,{message:'项目目录路径无效'});
   return resolveRepositoryPath(tree+suffix);
  }
  return value; // 仓库外历史目录不猜测映射，也不自动移动原件。
 }
 return resolveRepositoryPath(portable.startsWith('ai-distill/')?portable.slice('ai-distill/'.length):portable);
}

/** 保存项目配置：新指定目录必须在仓库内，数据库统一使用正斜杠相对路径。 */
export function projectPathReference(value:string):string{
 const path=relative(repositoryRoot,resolveProjectPath(value));
 if(!path||isAbsolute(path)||path==='..'||path.startsWith(`..${sep}`))throw new HTTPException(400,{message:'项目目录须位于当前仓库内，请使用projects/项目名/...路径'});
 return path.split(sep).join('/');
}
/** 比较旧配置与新配置时归一化表示；不改变仓库外历史路径。 */
export function comparableProjectPath(value:string):string{
 const resolved=resolveProjectPath(value),path=relative(repositoryRoot,resolved);
 return path&&!isAbsolute(path)&&path!=='..'&&!path.startsWith(`..${sep}`)?path.split(sep).join('/'):resolved;
}
