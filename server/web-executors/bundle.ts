/**
 * 职责：把Agent目录里的文件整理成网页上传文件：数量不超过站点上限时原样逐个上传；超出时按原顺序合并为带边界标记的文本容器，不丢弃、不摘要、不截断。
 * 主要入口：`bundleForUpload()`、`renderUploadManifest()`、`collectDirectoryFiles()`；调用方为三个网页执行器。
 * 边界：只处理文件内容与命名；站点上限数值由调用方传入（见 README 记录的核验值）。
 */
import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {WebAgentError,type WebChatFile} from '../web-agent';
import type {WebAgentProvider} from '../../shared/web-agent';

export interface BundleEntry{path:string;content:Uint8Array|string}
export interface BundleManifestItem{path:string;bytes:number;file:string}
export interface BundleResult{files:WebChatFile[];manifest:BundleManifestItem[]}
/** 各站点单条消息可上传的文件数；数值来自 web-agent/README.md 的真实核验，改动须同步。 */
export const WEB_UPLOAD_MAX_FILES:Record<WebAgentProvider,number>={deepseek:50,gemini:10};

const decoder=new TextDecoder('utf-8',{fatal:true});
function asText(content:Uint8Array|string){if(typeof content==='string')return content;try{return decoder.decode(content);}catch{return null;}}
const byteLength=(content:Uint8Array|string)=>typeof content==='string'?Buffer.byteLength(content):content.byteLength;
const flatName=(path:string)=>path.replaceAll('/','__');

/** 递归读取目录文件（相对路径、排序稳定）；exclude 判断相对路径是否排除。 */
export async function collectDirectoryFiles(directory:string,exclude:(path:string)=>boolean):Promise<BundleEntry[]>{
  const result:BundleEntry[]=[];
  const walk=async(current:string)=>{
    for(const entry of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const full=join(current,entry.name),path=relative(directory,full).split('\\').join('/');
      if(entry.isDirectory()){if(!exclude(path+'/'))await walk(full);}
      else if(entry.isFile()&&!exclude(path))result.push({path,content:new Uint8Array(await readFile(full))});
    }
  };
  await walk(directory);return result;
}

export function bundleForUpload(entries:BundleEntry[],maxFiles:number):BundleResult{
  if(!Number.isInteger(maxFiles)||maxFiles<1)throw new Error('上传文件数上限无效');
  if(new Set(entries.map(e=>e.path)).size!==entries.length)throw new Error('上传文件路径重复');
  const texts:{path:string;text:string;bytes:number}[]=[],binaries:BundleEntry[]=[];
  for(const entry of entries){const text=asText(entry.content);if(text===null)binaries.push(entry);else texts.push({path:entry.path,text,bytes:byteLength(entry.content)});}
  const capacity=maxFiles-binaries.length;
  if(texts.length&&capacity<1)throw new WebAgentError('web_upload_rejected','二进制文件占满上传数量上限，无法再容纳文本文件');
  if(binaries.length>maxFiles)throw new WebAgentError('web_upload_rejected','需要上传的二进制文件数超过站点上限');
  const files:WebChatFile[]=[],manifest:BundleManifestItem[]=[];
  for(const entry of binaries){const name=flatName(entry.path);files.push({name,content:entry.content});manifest.push({path:entry.path,bytes:byteLength(entry.content),file:name});}
  if(texts.length<=capacity){
    for(const item of texts){const name=flatName(item.path);files.push({name,content:item.text});manifest.push({path:item.path,bytes:item.bytes,file:name});}
    return{files,manifest};
  }
  const total=texts.reduce((sum,item)=>sum+item.bytes,0),largest=Math.max(...texts.map(item=>item.bytes));
  let target=Math.max(largest,Math.ceil(total/capacity)),groups:typeof texts[]=[];
  for(;;){
    groups=[];let current:typeof texts=[],size=0;
    for(const item of texts){if(current.length&&size+item.bytes>target){groups.push(current);current=[];size=0;}current.push(item);size+=item.bytes;}
    if(current.length)groups.push(current);
    if(groups.length<=capacity)break;
    target=Math.ceil(target*1.1);
  }
  groups.forEach((group,index)=>{
    const name=`bundle-${String(index+1).padStart(2,'0')}.txt`;
    const content=group.map(item=>`<<<<< FILE: ${item.path} | bytes=${item.bytes} >>>>>\n${item.text}\n<<<<< END FILE: ${item.path} >>>>>\n`).join('\n');
    files.push({name,content});
    for(const item of group)manifest.push({path:item.path,bytes:item.bytes,file:name});
  });
  return{files,manifest};
}

/** 给提示词用的文件对照表：让网页端知道原相对路径对应哪个上传文件。 */
export function renderUploadManifest(manifest:BundleManifestItem[]){
  return ['【上传文件对照表】（原相对路径 → 上传文件；合并文件内每个原文件以 <<<<< FILE: 路径 >>>>> 与 <<<<< END FILE: 路径 >>>>> 为边界）',...manifest.map(item=>`- ${item.path} → ${item.file}`)].join('\n');
}
