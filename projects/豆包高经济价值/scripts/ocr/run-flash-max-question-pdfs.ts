/** 文件职责：使用 Flash max 页级识别处理指定真实题目 PDF，复用检查点并保存私有文本及处理记录。
 * 执行入口与用途：`bun projects/豆包高经济价值/scripts/ocr/run-flash-max-question-pdfs.ts`；逐份扫描指定题目 PDF，调用页级识别、复用检查点并私有保存文本和处理记录。
 */
import{readdir,mkdir,writeFile,chmod,stat}from'node:fs/promises';
import{join,resolve}from'node:path';
import{createHash}from'node:crypto';
import{extractPdf,type Page,type PageCheckpoint}from'../../../../server/materials/pdf';
import{createVisionClient}from'../../../../server/materials/vision';
import{loadExtractionConfig}from'../../../../server/materials/config';

const questionRoot=resolve('projects/豆包高经济价值/第五期/questions');
const storageRoot=resolve('.storage');
const outputRoot=join(storageRoot,'.flash-max-all-pdfs');
const checkpointRoot=join(storageRoot,'.flash-max-question-checkpoints');
const reportPath=join(outputRoot,'report.json');
const reports:any[]=[];
const config={...loadExtractionConfig(),ocrReasoningEffort:'max' as const,reasoningEffort:'max' as const,continueOnError:true};
const vision=createVisionClient({...process.env,ZHIPU_MODEL:'glm-5.3-flash'},fetch,config);
const fingerprint=createHash('sha256').update(vision.ocrCacheIdentity??'').digest('hex');

async function main(){
 if(!process.env.ZHIPU_API_KEY)throw new Error('未配置智谱API密钥');
 await mkdir(outputRoot,{recursive:true,mode:0o700});await chmod(outputRoot,0o700);
 const files:string[]=[];
 for(const q of ['题目1','题目3'])for(const name of (await readdir(join(questionRoot,q))).filter(x=>x.toLowerCase().endsWith('.pdf')).sort())files.push(join(q,name));
 const state:any={started_at:new Date().toISOString(),model:'glm-5.3-flash',reasoning_effort:'max',files:[],complete:false};
 await writeFile(reportPath,JSON.stringify(state,null,2)+'\n',{mode:0o600});
 let cursor=0;
 async function worker(){while(cursor<files.length){const relative=files[cursor++]!,source=join(questionRoot,relative),name=relative.split('/').at(-1)!,question=relative.split('/')[0]!;const bytes=await Bun.file(source).arrayBuffer(),sha=createHash('sha256').update(Buffer.from(bytes)).digest('hex'),materialDirectory=join(checkpointRoot,question,sha,fingerprint);await mkdir(materialDirectory,{recursive:true,mode:0o700});const checkpoint:PageCheckpoint={directory:materialDirectory,source_sha256:sha,config_fingerprint:fingerprint};const started=performance.now();
  try{const pages=await extractPdf(source,vision,undefined,checkpoint),record={question,name,sha256:sha,source_bytes:(await stat(source)).size,pages:pages.length,text_pages:pages.filter(p=>p.method==='text').length,ocr_pages:pages.filter(p=>p.method==='ocr').length,empty_pages:pages.filter(p=>!p.text.trim()).map(p=>p.page),issue_pages:pages.filter(p=>p.issues?.length).map(p=>({page:p.page,issues:p.issues})),truncated_pages:pages.filter(p=>p.issues?.includes('truncated_response')).map(p=>p.page),elapsed_ms:Math.round(performance.now()-started),output:`${question}-${name.replaceAll('/','_')}.md`,checkpoint_directory:relativePath(materialDirectory)};await writeFile(join(outputRoot,record.output),pages.map(p=>p.text).join('\n\n'),{mode:0o600});await chmod(join(outputRoot,record.output),0o600);state.files.push(record);state.files.sort((a:any,b:any)=>a.question.localeCompare(b.question)||a.name.localeCompare(b.name));await writeFile(reportPath,JSON.stringify(state,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({question,file:name,pages:record.pages,text_pages:record.text_pages,ocr_pages:record.ocr_pages,empty_pages:record.empty_pages.length,issue_pages:record.issue_pages.length,elapsed_ms:record.elapsed_ms}));}
  catch(error){const record={question,name,sha256:sha,error:error instanceof Error?error.message:'PDF extraction failed',elapsed_ms:Math.round(performance.now()-started)};state.files.push(record);await writeFile(reportPath,JSON.stringify(state,null,2)+'\n',{mode:0o600});console.error(JSON.stringify({question,file:name,error:record.error}));}}
 }
 await Promise.all([worker(),worker()]);state.complete=state.files.length===files.length&&state.files.every((r:any)=>!r.error);state.checked_at=new Date().toISOString();state.totals={files:state.files.length,pages:state.files.reduce((n:number,r:any)=>n+(r.pages??0),0),ocr_pages:state.files.reduce((n:number,r:any)=>n+(r.ocr_pages??0),0),text_pages:state.files.reduce((n:number,r:any)=>n+(r.text_pages??0),0),empty_pages:state.files.reduce((n:number,r:any)=>n+(r.empty_pages?.length??0),0),issue_pages:state.files.reduce((n:number,r:any)=>n+(r.issue_pages?.length??0),0)};await writeFile(reportPath,JSON.stringify(state,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({complete:state.complete,...state.totals}));if(!state.complete)process.exitCode=1;
}
function relativePath(path:string){return path.replace(`${storageRoot}/`,'');}
main().catch(error=>{console.error(error instanceof Error?error.message:'Flash max extraction failed');process.exitCode=1;});
