/** 验证项目钩子脚本冻结、空实现、实际子进程执行、超时取消和结果边界；不访问数据库或真实模型。 */
import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const modulePromise=import('./workflow-hooks').catch(()=>undefined);
const roots:string[]=[];
afterEach(async()=>{try{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});}catch(error){throw error;}});
async function fixture(source:string){
 const root=await mkdtemp(join(tmpdir(),'workflow-hook-'));roots.push(root);await mkdir(join(root,'hooks'));
 await writeFile(join(root,'hooks/main.ts'),source);
 return {root,action:{id:'check',script:'hooks/main.ts',files:['hooks/main.ts'],mode:'sync' as const,params:{value:7},timeout_ms:1000,idempotent:false}};
}
const payload={stage:'answer' as const,position:'after' as const,attempt_id:'attempt',workflow_id:'workflow',idempotency_key:'attempt:after:check',input:{question:'题面',materials:[{name:'附件1',text:'脱敏正文'}]},output:{text:'原始答案'}};
test('空钩子不执行子进程且保留明确空结果',async()=>{
 const m=await modulePromise;expect(typeof m?.runHookScript).toBe('function');
 expect(await m!.runHookScript(undefined,payload)).toEqual({notes:[],data:{}});
});
test('实际钩子仅接收白名单环境并返回附加结果',async()=>{
 const f=await fixture("const input=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({notes:['检查完成'],data:{question:input.input.question,value:input.params.value,secret:process.env.DATABASE_URL??null,answer:input.output.text}}));");
 const m=(await modulePromise)!;const frozen=await m.freezeHookScript(f.root,f.action);
 const result=await m.runHookScript(frozen,payload);
 expect(result).toEqual({notes:['检查完成'],data:{question:'题面',value:7,secret:null,answer:'原始答案'}});
});
test('入口和声明依赖一起冻结，变化或符号链接拒绝执行',async()=>{
 const f=await fixture("import {value} from './dep';console.log(JSON.stringify({data:{value}}));");
 await writeFile(join(f.root,'hooks/dep.ts'),'export const value=7;');
 const m=(await modulePromise)!;const frozen=await m.freezeHookScript(f.root,{...f.action,files:[...f.action.files,'hooks/dep.ts']});
 expect(await m.runHookScript(frozen,payload)).toEqual({notes:[],data:{value:7}});
 await writeFile(join(f.root,'hooks/dep.ts'),'export const value=8;');
 await expect(m.runHookScript(frozen,payload)).rejects.toThrow('变化');
 await symlink(join(f.root,'hooks/main.ts'),join(f.root,'hooks/link.ts'));
 await expect(m.freezeHookScript(f.root,{...f.action,script:'hooks/link.ts',files:['hooks/link.ts']})).rejects.toThrow('路径');
});
test.each(["throw new Error('PRIVATE BODY');","console.log('not json');","console.log(JSON.stringify({text:'改写答案'}));"] )('钩子错误或越权输出不改变主结果：%s',async source=>{
 const f=await fixture(source),m=(await modulePromise)!;
 await expect(m.runHookScript(await m.freezeHookScript(f.root,f.action),payload)).rejects.toThrow('钩子');
 expect(payload.output.text).toBe('原始答案');
});
test('超时和取消终止实际钩子进程',async()=>{
 const f=await fixture('await new Promise(()=>{});'),m=(await modulePromise)!;
 const frozen=await m.freezeHookScript(f.root,{...f.action,timeout_ms:30});
 await expect(m.runHookScript(frozen,payload)).rejects.toThrow('超时');
 const controller=new AbortController();controller.abort();
 await expect(m.runHookScript(frozen,payload,{signal:controller.signal})).rejects.toThrow('取消');
});
test('显式前置附加输入只能用于出题和评分，作答和异步不得注入',async()=>{
 const f=await fixture("console.log(JSON.stringify({additions:[{purpose:'检查口径',text:'补充说明'}],artifacts:[{name:'检查.txt',text:'检查原文'}]}));"),m=(await modulePromise)!;
 const frozen=await m.freezeHookScript(f.root,{...f.action,input_purpose:'检查口径'} as any);
 const result=await m.runHookScript(frozen,{...payload,stage:'scoring',position:'before'});
 expect(result).toMatchObject({additions:[{purpose:'检查口径',text:'补充说明'}],artifacts:[{name:'检查.txt',text:'检查原文'}]});
 await expect(m.runHookScript(frozen,{...payload,position:'before'})).rejects.toThrow('附加输入');
 await expect(m.runHookScript({...frozen,action:{...frozen.action,mode:'async'}},payload)).rejects.toThrow();
});
test('受控模型动作只用冻结声明和阶段白名单，保存调用信息，不向脚本注入密钥',async()=>{
 const f=await fixture("console.log(JSON.stringify({model_request:true,notes:['请求复核']}));"),m=(await modulePromise)!;
 const config={provider:'deepseek',model:'deepseek-chat',base_url:'https://api.deepseek.com'};
 const frozen=await m.freezeHookScript(f.root,{...f.action,model_request:{config,prompt:'仅复核材料引用'}} as any);
 let request:any;
 const result=await m.runHookScript(frozen,payload,{complete:async(input:any)=>{request=input;return {provider:'deepseek',text:'复核意见',model:'deepseek-chat',requested_model:'deepseek-chat',request_id:null,completion_id:'fixture',usage:{total_tokens:3},duration_ms:1,started_at:'start',finished_at:'end'};}} as any);
 expect(request.config).toEqual(config);expect(request.messages[0].content).toBe('仅复核材料引用');
 expect(request.messages[1].content).toContain('原始答案');expect(request.messages[1].content).not.toContain('model_request');
 expect(result).toMatchObject({model_result:{text:'复核意见',usage:{total_tokens:3}}});
 const unauthorized=await m.freezeHookScript(f.root,f.action);
 await expect(m.runHookScript(unauthorized,payload)).rejects.toThrow('模型');
});
test('收费复核不能声明可自动恢复的幂等动作，配置中不接受URL凭据',async()=>{
 const f=await fixture("console.log('{}');"),m=(await modulePromise)!;
 for(const config of [{provider:'deepseek',base_url:'https://api.deepseek.com',model:'deepseek-chat'},{provider:'deepseek',base_url:'https://user:password@api.deepseek.com',model:'deepseek-chat'}])await expect(m.freezeHookScript(f.root,{...f.action,idempotent:!config.base_url.includes('@'),model_request:{config,prompt:'复核'}} as any)).rejects.toThrow();
});

test('hook model request accepts registered SiliconFlow while preserving endpoint and provider checks',async()=>{
 const {validateWorkflowConfig}=await import('../shared/workflow-config');
 const action={id:'verify',script:'hook.ts',files:['hook.ts'],mode:'sync',params:{},timeout_ms:1000,idempotent:false,model_request:{config:{provider:'siliconflow',model:'Qwen/Qwen3.8-27B',base_url:'https://api.siliconflow.cn/v1'},prompt:'review'}};
 expect(validateWorkflowConfig({hooks:{before:[action]}})?.hooks.before[0]?.model_request?.config.provider).toBe('siliconflow');
 for(const config of [{...action.model_request.config,provider:'unknown'},{...action.model_request.config,base_url:'http://localhost/v1'}])expect(()=>validateWorkflowConfig({hooks:{before:[{...action,model_request:{...action.model_request,config}}]}})).toThrow();
});
