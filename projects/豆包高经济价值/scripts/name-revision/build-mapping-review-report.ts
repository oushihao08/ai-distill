/**
 * 职责：汇总单包主体复核回执为人工核对用 Markdown 表，不改变回执或业务数据。
 * 入口：bun .../build-mapping-review-report.ts <响应目录> <输出.md>。
 * 影响：输出含真实主体与化名，只允许写入当前仓库 .storage 私有目录并设为 0600。
 */
import {chmod,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

const [responsesArg,outputArg]=process.argv.slice(2);
if(!responsesArg||!outputArg)throw new Error('用法：build-mapping-review-report.ts <响应目录> <输出.md>');
const root=process.cwd(),responses=resolve(responsesArg),output=resolve(outputArg);
if(!responses.includes(`${root}/.storage/`)||!output.includes(`${root}/.storage/`))throw new Error('输入输出必须位于当前仓库 .storage 私有目录');
const escape=(value:unknown)=>String(value??'').replaceAll('|','\\|').replace(/[\r\n]+/g,' ');
const files=(await readdir(responses)).filter(name=>/^\d{2}\.response\.json$/.test(name)).sort();
const confirmed:string[]=[],unresolved:string[]=[],summary:any[]=[];
for(const file of files){
 const batch=file.slice(0,2),receipt=JSON.parse(await readFile(`${responses}/${file}`,'utf8'));
 if(receipt?.format!=='name-mapping-review-v1'||!Array.isArray(receipt.packages)||receipt.packages.length!==1)throw new Error(`${file} 不是有效单包回执`);
 const item=receipt.packages[0];
 summary.push({batch,package_id:item.package_id,mappings:item.mappings.length,unresolved:item.unresolved.length,ignored:item.ignored.length,call_id:receipt.call_id});
 for(const mapping of item.mappings)confirmed.push(`| ${batch} | ${escape(item.package_id)} | ${escape(mapping.original)} | ${escape(mapping.before)} | ${escape(mapping.after)} | ${escape(mapping.kind)} | ${escape(mapping.reason)} |`);
 for(const decision of item.unresolved)unresolved.push(`| ${batch} | ${escape(item.package_id)} | ${escape(decision.original)} | ${escape(decision.before)} | ${escape(decision.reason)} |`);
}
const body=[
 '# 第七期主体映射人工核对表','',
 `生成时间：${new Date().toISOString()}`,'',
 `已完成 ${files.length}/54 包；确认映射 ${confirmed.length} 项；未决 ${unresolved.length} 项。未决项尚未进入正式替换。`,'',
 '## 分包汇总','',
 '| 包号 | 材料包ID | 确认映射 | 未决 | 忽略 | 复核回执 |','| --- | --- | ---: | ---: | ---: | --- |',
 ...summary.map(item=>`| ${item.batch} | ${item.package_id} | ${item.mappings} | ${item.unresolved} | ${item.ignored} | ${item.call_id} |`),'',
 '## 已确认映射','',
 '| 包号 | 材料包ID | 原主体 | 当前旧化名 | 拟用新化名 | 类型 | 判断依据 |','| --- | --- | --- | --- | --- | --- | --- |',
 ...confirmed,'',
 '## 未决项（阻断自动替换）','',
 '| 包号 | 材料包ID | 原主体 | 当前旧名称 | 未决原因 |','| --- | --- | --- | --- | --- |',
 ...unresolved,''
].join('\n');
await mkdir(dirname(output),{recursive:true,mode:0o700});
await writeFile(output,body,{mode:0o600});await chmod(output,0o600);
console.log(JSON.stringify({output,completed_packages:files.length,mappings:confirmed.length,unresolved:unresolved.length}));
