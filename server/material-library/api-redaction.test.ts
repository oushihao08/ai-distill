/** 验证API化名与Agent共用输入、编译、私有产物，及修正/失败/取消边界；不调用模型或业务数据库。 */
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareAgentLibraryMaterials} from './agent-redaction';
import {apiMaterialExecutor} from './api-redaction';
import {validateLibraryJobRequest,chooseLibraryExecutor} from './jobs';
const api={provider:'siliconflow' as const,base_url:'https://api.siliconflow.com/v1',model:'deepseek-ai/DeepSeek-V4.1-Flash'};
const plan={entities:[{id:'p',kind:'person',alias:'周文远',variants:[{text:'赵安',targets:[]}]}],edits:[],documents:[{id:'d',title:'申请书',ranges:[{first_block_id:'f1p1b1',last_block_id:'f1p1b1'}],duplicate_of:null}],unresolved:[]};
function input(directory:string){return{directory,api,model:api.model,reasoning_effort:'none',revision_id:'r',extraction_job_id:'e',template:{id:'aliases',digest:'d',redaction:{prompt:'保留法院及100元，整包统一化名'}},files:[{file_id:'f',text_sha256:'h',pages:[{page:1,text:'赵安申请100元',structure:[{id:'b',kind:'paragraph' as const,text:'赵安申请100元'}]}]}]};}
function response(text:string){return{text,model:'returned-flash',requested_model:api.model,provider:'siliconflow',completion_id:'c',request_id:null,usage:{tokens:1},duration_ms:1};}
test('explicit API config is validated, frozen in request and chooses API lane; default stays Agent',()=>{
 const request={kind:'redact',request_key:'123e4567-e89b-42d3-a456-426614174000',execution_target:'local',extraction_job_id:'123e4567-e89b-42d3-a456-426614174001'};
 expect(validateLibraryJobRequest({...request,api_settings:api}).api_settings).toEqual(api);
 expect(validateLibraryJobRequest(request).api_settings).toBeUndefined();
 expect(()=>validateLibraryJobRequest({...request,api_settings:api,agent_settings:{model:'x',reasoning_effort:'low'}})).toThrow();
 expect(()=>validateLibraryJobRequest({...request,kind:'extract',extraction_job_id:undefined,api_settings:api})).toThrow();
 expect(()=>validateLibraryJobRequest({...request,api_settings:{...api,api_key:'forbidden'}})).toThrow('API模型配置无效');
 expect(chooseLibraryExecutor('redact',[],{provider:'api'})).toBe('api');
 expect(chooseLibraryExecutor('redact',[],{provider:'codex'})).toBe('agent');
});
test('identical invalid plan stops instead of unbounded paid repairs',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'api-aliases-'));let calls=0;
 try{
  const execute=apiMaterialExecutor(api,{complete:async()=>{calls++;return response(JSON.stringify({...plan,documents:[]}));}} as any);
  await expect(prepareAgentLibraryMaterials({...input(directory),execute})).rejects.toThrow();expect(calls).toBe(2);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('API inlines complete structured source, repairs against same compiler and uses common final artifacts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'api-aliases-'));let calls=0;
 try{
  const client={complete:async(request:any)=>{calls++;expect(Number.isInteger(request.timeout_ms)).toBe(true);expect(request.messages[0].content).toContain('保留法院及100元');expect(request.messages[1].content).toContain('赵安申请100元');expect(request.response_format.json_schema.schema.properties).toHaveProperty('entities');if(calls===1)return response(JSON.stringify({...plan,documents:[]}));expect(request.messages.at(-1).content).toContain('valid');return response(JSON.stringify(plan));}} as any;
  const out=await prepareAgentLibraryMaterials({...input(directory),execute:apiMaterialExecutor(api,client)});
  expect(calls).toBe(2);expect(out.prepared.documents[0]?.text).toBe('周文远申请100元');
  expect(out.provider).toBe('siliconflow');expect(out.model).toBe('returned-flash');
  expect(JSON.parse(await readFile(join(directory,'semantic-plan.private.json'),'utf8'))).toEqual(plan);
  expect(JSON.parse(await readFile(join(directory,'主体对应表.private.json'),'utf8')).entities).toEqual(plan.entities);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('provider failures are not retried and cancelled input never calls API',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'api-aliases-'));let calls=0;
 const execute=apiMaterialExecutor(api,{complete:async()=>{calls++;throw new Error('provider-failed');}} as any);
 try{
  await expect(prepareAgentLibraryMaterials({...input(directory),execute})).rejects.toThrow('provider-failed');expect(calls).toBe(1);
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  await expect(prepareAgentLibraryMaterials({...input(directory),execute,signal:controller.signal})).rejects.toThrow('cancelled');expect(calls).toBe(1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
