/** 文件职责：使用合成输入实际调用 Codex，验证登录、受限目录与结构化返回；保存冒烟记录。
 * 执行入口与用途：`bun scripts/verify-codex-client.ts`；以合成输入启动本地 Codex CLI，核对登录、隔离目录和结构化返回并保存摘要。
 */
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexLoginStatus,runCodex} from '../server/codex/client';
const root=await mkdtemp(join(tmpdir(),'distill-codex-smoke-'));
const binary=process.env.CODEX_BIN??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
let evidence:Record<string,unknown>={checked_at:new Date().toISOString(),scope:'real ChatGPT subscription invocation with synthetic public input'};
try{
 await mkdir(join(root,'input'));await writeFile(join(root,'input','material.md'),'Validation token: distill-smoke');
 const login=await codexLoginStatus(binary);evidence.login=login.status;
 const result=await runCodex({binary,directory:root,model:'gpt-6.1-sol',reasoning_effort:'low',prompt:'Read input/material.md. Return JSON with token exactly matching its validation token. Do not access any other files. No code changes are needed.',schema:{type:'object',properties:{token:{type:'string'}},required:['token'],additionalProperties:false},validate(value){if(!value||typeof value!=='object'||!('token'in value)||value.token!=='distill-smoke')throw new Error('invalid');return{token:'distill-smoke'};}});
 evidence={...evidence,passed:true,duration_ms:result.duration_ms,usage:result.usage};console.log(JSON.stringify(evidence));
}catch(error){evidence={...evidence,passed:false,error:error instanceof Error?error.message:'Codex验证失败'};console.error(JSON.stringify(evidence));process.exitCode=1;}
finally{await rm(root,{recursive:true,force:true});await writeFile(new URL('../docs/evidence/codex-client-results.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');}
