/**
 * 职责：通过本机HTTP名称复核接口顺序执行已冻结的私有候选批次，并原子保存响应供后续预览。
 * 入口：bun .../run-review-batches.ts <请求目录> <响应目录> [批次编号逗号列表]。
 * 影响：调用真实Agent但不写业务数据库；只在.storage私有目录写0600响应，已有有效响应直接跳过。
 */
import {chmod,mkdir,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';

const [requestArg,responseArg,selectionArg]=process.argv.slice(2);
if(!requestArg||!responseArg)throw new Error('用法：run-review-batches.ts <请求目录> <响应目录> [01,02]');
const root=process.cwd(),requests=resolve(requestArg),responses=resolve(responseArg);
if(!requests.includes(`${root}/.storage/`)||!responses.includes(`${root}/.storage/`))throw new Error('请求和响应目录必须位于当前仓库.storage私有目录');
const selected=selectionArg?new Set(selectionArg.split(',').map(value=>value.padStart(2,'0'))):null;
await mkdir(responses,{recursive:true,mode:0o700});
const files=(await readdir(requests)).filter(name=>/^\d{2}\.request\.json$/.test(name)&&(!selected||selected.has(name.slice(0,2)))).sort();
if(!files.length)throw new Error('没有选中的复核批次');
const summary=[];
for(const file of files){
 const number=file.slice(0,2),target=join(responses,`${number}.response.json`);
 try{const existing=JSON.parse(await readFile(target,'utf8'));if(existing?.format==='name-mapping-review-v1'&&Array.isArray(existing.packages)){summary.push({batch:number,state:'reused',package_count:existing.packages.length});continue;}}catch{}
 const body=await readFile(join(requests,file),'utf8'),response=await fetch('http://127.0.0.1:3700/api/material-library/name-revisions/review-mappings',{method:'POST',headers:{'Content-Type':'application/json'},body});
 const text=await response.text();if(!response.ok)throw new Error(`批次${number}复核接口失败：HTTP ${response.status} ${text.slice(0,300)}`);
 const result=JSON.parse(text);if(result?.format!=='name-mapping-review-v1'||!Array.isArray(result.packages))throw new Error(`批次${number}复核响应无效`);
 const temporary=join(responses,`.${basename(target)}.${crypto.randomUUID()}.tmp`);
 try{await writeFile(temporary,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,target);await chmod(target,0o600);}finally{await rm(temporary,{force:true});}
 summary.push({batch:number,state:'completed',package_count:result.packages.length,mapping_count:result.packages.reduce((sum:number,item:any)=>sum+item.mappings.length,0),unresolved_count:result.packages.reduce((sum:number,item:any)=>sum+item.unresolved.length,0),ignored_count:result.packages.reduce((sum:number,item:any)=>sum+item.ignored.length,0),requested_model:result.requested_model,returned_model:result.returned_model,duration_ms:result.duration_ms});
 console.log(JSON.stringify(summary.at(-1)));
}
console.log(JSON.stringify({completed:summary.length,batches:summary}));
