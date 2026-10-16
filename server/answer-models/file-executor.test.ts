/** 验证Claude Code文件作答的输入隔离、原模型保留、实际文件收集与失败边界；进程注入不调用Docker或真实模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runFileAnswer,type FileAnswerInvocation} from './file-executor';

async function fixture(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'file-answer-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
function options(directory:string){return{directory,image:'ai-distill-work:2.1.114',question:'阅读附件1，制作意见.md。',materials:[{name:'附件1',text:'本次允许的脱敏材料'}],deliverables:[{path:'意见.md',required:true}],config:{provider:'openrouter' as const,base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen3.8-max-0902'},timeout_ms:60000};}
function fakeProcess(calls:FileAnswerInvocation[],write?:(call:FileAnswerInvocation)=>Promise<void>,result?:unknown){return async(call:FileAnswerInvocation)=>{
 calls.push(call);
 if(call.args.at(-1)==='--version')return{code:0,stdout:'2.1.114 (Claude Code)',stderr:''};
 if(write)await write(call);
 return{code:0,stdout:JSON.stringify(result??{type:'result',subtype:'success',is_error:false,result:'已完成实际文件',session_id:'fixture-session',usage:{input_tokens:10,output_tokens:20}})+'\n',stderr:''};
};}
function outputPath(call:FileAnswerInvocation){const mount=call.args.find(arg=>arg.startsWith('type=bind,src=')&&arg.includes('dst=/app/output'));if(!mount)throw new Error('missing output mount');return mount.slice('type=bind,src='.length).split(',dst=')[0]!;}

test('文件作答只提供题面附件与输出，保留配置模型且凭证不进入命令参数',async()=>fixture(async root=>{
 const calls:FileAnswerInvocation[]=[];
 const result=await runFileAnswer(options(root),{env:{PATH:process.env.PATH,HOME:process.env.HOME,OPEN_ROUTER_KEY:'fixture-secret'},execute:fakeProcess(calls,async c=>{await writeFile(join(outputPath(c),'意见.md'),'# 完整意见\n依据实际材料分析。');})});
 const call=calls[1]!;
 expect(call.args).toContain('qwen/qwen3.8-max-0902');expect(call.args.join(' ')).not.toContain('fixture-secret');
 expect(call.env.ANTHROPIC_AUTH_TOKEN).toBe('fixture-secret');expect(call.env.DATABASE_URL).toBeUndefined();
 expect(call.args.join(' ')).not.toMatch(/golden|rubric|skill|\.storage\/.*private\/author/);
 expect(call.args).toContain('--read-only');expect(call.args.join(' ')).toContain('dst=/app/input_files,readonly');
 expect(call.stdin).toContain('/app/input_files/材料-001.txt');expect(call.stdin).toContain('/app/output/意见.md');
 expect(result.files).toHaveLength(1);expect(result.files[0]?.path).toBe('意见.md');
 expect(await readFile(result.files[0]!.storage_path,'utf8')).toContain('完整意见');
 expect(result.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);expect(result.execution.framework).toBe('claude-code');
 expect(JSON.stringify(result)).not.toContain('fixture-secret');
}));

test('CLI退出0但没有result事件不能视为完成',async()=>fixture(async root=>{
 await expect(runFileAnswer(options(root),{env:{OPEN_ROUTER_KEY:'fixture-secret'},execute:async call=>call.args.at(-1)==='--version'?{code:0,stdout:'2.1.114',stderr:''}:{code:0,stdout:'',stderr:''}})).rejects.toThrow('未返回完整结果');
}));

test('CLI返回失败或缺必交文件均不发布成功',async()=>fixture(async root=>{
 for(const result of [{type:'result',subtype:'error_max_turns',is_error:true,result:'未完成'},{type:'result',subtype:'success',is_error:false,result:'已完成'}]){
  await expect(runFileAnswer(options(root),{env:{OPEN_ROUTER_KEY:'fixture-secret'},execute:fakeProcess([],undefined,result)})).rejects.toThrow();
 }
}));

test('拒绝宿主版本、未经支持的模型参数和额外私有输入',async()=>fixture(async root=>{
 const env={OPEN_ROUTER_KEY:'fixture-secret'};
 await expect(runFileAnswer(options(root),{env,execute:async()=>({code:0,stdout:'2.1.59',stderr:''})})).rejects.toThrow('2.1.114');
 const calls:FileAnswerInvocation[]=[];
 await expect(runFileAnswer({...options(root),config:{...options(root).config,enable_thinking:false}},{env,execute:fakeProcess(calls)})).rejects.toThrow('模型参数');expect(calls).toHaveLength(0);
 await expect(runFileAnswer({...options(root),rubric:['不得泄露']} as any,{env,execute:fakeProcess(calls)})).rejects.toThrow('输入字段');
}));

test('不允许候选用符号链接输出宿主文件或预取消后启动进程',async()=>fixture(async root=>{
 await expect(runFileAnswer(options(root),{env:{OPEN_ROUTER_KEY:'fixture-secret'},execute:fakeProcess([],async c=>{await symlink('/etc/passwd',join(outputPath(c),'意见.md'));})})).rejects.toThrow('符号链接');
 const controller=new AbortController();controller.abort();const calls:FileAnswerInvocation[]=[];
 await expect(runFileAnswer({...options(root),signal:controller.signal},{env:{OPEN_ROUTER_KEY:'fixture-secret'},execute:fakeProcess(calls)})).rejects.toThrow('取消');expect(calls).toHaveLength(0);
}));

test('Docker执行失败与CLI版本不符分别报告，不把容器不可用误诊为版本错误',async()=>fixture(async root=>{
 await expect(runFileAnswer(options(root),{env:{OPEN_ROUTER_KEY:'fixture-secret'},execute:async()=>({code:1,stdout:'',stderr:'private docker failure'})})).rejects.toThrow('Docker');
}));

test('中断候选进程后仅清理本次容器，不使用取消信号阻断清理',async()=>fixture(async root=>{
 const calls:FileAnswerInvocation[]=[];
 await expect(runFileAnswer(options(root),{env:{OPEN_ROUTER_KEY:'fixture-secret'},execute:async call=>{
  calls.push(call);
  if(call.args.at(-1)==='--version')return{code:0,stdout:'2.1.114',stderr:''};
  if(call.args[0]==='rm')return{code:0,stdout:'',stderr:''};
  throw new Error('文件作答超过本次时限');
 }})).rejects.toThrow('超过本次时限');
 const cleanup=calls.at(-1)!;
 expect(cleanup.args.slice(0,2)).toEqual(['rm','--force']);expect(cleanup.args[2]).toMatch(/^ai-distill-/);expect(cleanup.signal).toBeUndefined();
}));
