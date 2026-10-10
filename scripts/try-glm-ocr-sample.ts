/** 文件职责：读取指定历史任务的真实 PDF，调用智谱 layout_parsing 并私有保存样本；不发布脱敏产物。
 * 执行入口与用途：`bun scripts/try-glm-ocr-sample.ts`；按固定历史 attempt 查询 PDF 后调用 layout_parsing，将返回样本写入 .storage 私有目录。
 */
import{mkdir,writeFile,stat}from'node:fs/promises';
import{join,resolve}from'node:path';
import{createPool}from'../server/db';
const pool=createPool(),attemptId='73b10d51-717c-4e1f-bfcb-d323775db1f3',outDir=resolve('.storage/.glm-ocr-sample');
try{
 const row=(await pool.query("SELECT w.source_key,m.id,m.storage_path,m.sha256,m.size_bytes FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id JOIN ai_distill.materials m ON m.workflow_id=w.id WHERE a.id=$1 AND m.original_name LIKE $2 ORDER BY m.created_at LIMIT 1",[attemptId,'%执312号.pdf'])).rows[0];
 if(!row)throw new Error('未找到题目3的29页PDF');
 const path=join(resolve('.storage'),row.storage_path),info=await stat(path);
 if(info.size>50*1024*1024)throw new Error('样本超过GLM-OCR单PDF限制');
 const bytes=await Bun.file(path).arrayBuffer(),key=process.env.ZHIPU_API_KEY;
 if(!key)throw new Error('未配置智谱API密钥');
 const start=performance.now();
 let response:Response;
 try{response=await fetch(`${process.env.ZHIPU_BASE_URL??'https://open.bigmodel.cn/api/paas/v4'}/layout_parsing`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'glm-ocr',file:`data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,request_id:crypto.randomUUID()}),signal:AbortSignal.timeout(30*60*1000)});}catch{throw new Error('GLM-OCR请求失败或30分钟超时；未输出密钥或文档内容');}
 if(!response.ok)throw new Error(`GLM-OCR接口返回HTTP ${response.status}`);
 const raw=await response.json() as any,elapsed=Math.round(performance.now()-start),markdown=typeof raw.md_results==='string'?raw.md_results:'';
 if(!raw.id||typeof raw.data_info?.num_pages!=='number'||!markdown)throw new Error('GLM-OCR返回结构缺少任务ID、页数或Markdown');
 await mkdir(outDir,{recursive:true,mode:0o700});
 const rawPath=join(outDir,'question3-29-pages.json');await writeFile(rawPath,JSON.stringify(raw),{mode:0o600});
 const layoutPages=Array.isArray(raw.layout_details)?raw.layout_details.length:null;
 const result={question:'题目3',source_material_id:row.id,source_sha256:row.sha256,input_bytes:info.size,model:raw.model??'glm-ocr',request_id:raw.request_id??null,elapsed_ms:elapsed,expected_pages:29,reported_pages:raw.data_info.num_pages,layout_pages:layoutPages,markdown_chars:markdown.length,usage:raw.usage??null,artifact_path:'.storage/.glm-ocr-sample/question3-29-pages.json',redaction:'仅保存在权限700私有目录；GLM-OCR不支持本项目原脱敏提示词；未发布为出题Markdown'};
 await writeFile(join(outDir,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));
}catch(error){console.error(error instanceof Error?error.message:'GLM-OCR样本测试失败');process.exitCode=1;}finally{await pool.end();}
