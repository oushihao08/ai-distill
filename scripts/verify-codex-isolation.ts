/** 文件职责：通过本地 CLI 子进程检查隔离目录的读写边界；不以沙箱检查替代真实模型执行验收。
 * 执行入口与用途：`bun scripts/verify-codex-isolation.ts`；启动本地 CLI 子进程验证允许／拒绝的目录读写边界，输出沙箱检查结果。
 */
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// No model invocation, no auth-file copying, and no credential contents are read by this verifier.
const binary=process.env.CODEX_BIN??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const root=await mkdtemp(join(tmpdir(),'distill-isolation-'));
const workspace=join(root,'role');const input=join(workspace,'input');const output=join(workspace,'output');const outside=join(root,'other-role.txt');
const checks:{name:string;passed:boolean;exit_code?:number}[]=[];
const environment=Object.fromEntries(['HOME','PATH','LANG','TMPDIR','CODEX_HOME'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]));
function check(name:string,passed:boolean,exit_code?:number){checks.push({name,passed,...(exit_code===undefined?{}:{exit_code})});console.log(`${passed?'PASS':'FAIL'} ${name}`);if(!passed)throw new Error(name);}
try{
 await mkdir(input,{recursive:true});await mkdir(output);await writeFile(join(input,'material.md'),'public fixture');await writeFile(outside,'hidden fixture');
 const versionProcess=Bun.spawn([binary,'--version'],{env:environment,stdout:'pipe',stderr:'pipe'});
 const version=await new Response(versionProcess.stdout).text();await new Response(versionProcess.stderr).text();
 check('Codex executable is available',await versionProcess.exited===0&&/^codex-cli\s/.test(version));
 const filesystem={':root':'deny',':minimal':'read',[workspace]:'read',[output]:'write',[outside]:'deny'};
 const config=['-c','permissions.distill_verification.filesystem='+`{${Object.entries(filesystem).map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}}`,'-c','permissions.distill_verification.network.enabled=false'];
 async function run(command:string[]){
  try{const child=Bun.spawn([binary,'sandbox','-P','distill_verification','--cd',workspace,...config,'--',...command],{cwd:workspace,env:environment,stdout:'pipe',stderr:'pipe'});const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return{stdout,stderr,code};}catch{throw new Error('sandbox process failed; internal details omitted');}
 }
 let result=await run(['/bin/cat',join(input,'material.md')]);
 check('sandbox can read its own staged input',result.code===0&&result.stdout==='public fixture',result.code);
 result=await run(['/bin/sh','-c','printf done > "$1"','sh',join(output,'artifact.txt')]);
 check('sandbox can write only its output directory',result.code===0&&await readFile(join(output,'artifact.txt'),'utf8')==='done',result.code);
 result=await run(['/bin/cat',outside]);
 check('another role material is unreadable',result.code!==0&&/Operation not permitted|Permission denied/i.test(result.stderr),result.code);
 result=await run(['/bin/sh','-c','printf changed > "$1"','sh',join(input,'material.md')]);
 check('input files cannot be overwritten',result.code!==0&&await readFile(join(input,'material.md'),'utf8')==='public fixture',result.code);
 result=await run(['/bin/sh','-c','printf changed > "$1"','sh',join(workspace,'outside-output.txt')]);
 check('writes outside the output directory are blocked',result.code!==0,result.code);
 check('database and provider credentials are not inherited',!['DATABASE_URL','ZHIPU_API_KEY','OPENAI_API_KEY','CODEX_API_KEY','OPEN_ROUTER_KEY'].some(key=>key in environment));
}catch(error){console.error(error instanceof Error&&checks.some(check=>check.name===error.message)?error.message:'isolation verification failed; details omitted');process.exitCode=1;}
finally{
 await rm(root,{recursive:true,force:true});
 await writeFile(new URL('../docs/evidence/codex-isolation-results.json',import.meta.url),JSON.stringify({checked_at:new Date().toISOString(),scope:'local CLI sandbox subprocesses; model execution and native tool enforcement not covered',model_calls:0,checks},null,2)+'\n');
}
