/**
 * 主项目共享提示词路由测试：验证跨期同步、主项目隔离、非提示词配置保留和旧弹窗冲突拒绝。
 * 使用内存连接池核对 API 事务边界，不连接数据库、不创建工作流或调用模型。
 */
import {expect,test} from 'bun:test';
import type {Pool} from 'pg';
import {createApp} from './app';
import {readProjectGroupPrompts} from './project-step-prompts';

const phaseA='11111111-1111-4111-8111-111111111111';
const phaseA2='22222222-2222-4222-8222-222222222222';
const phaseB='33333333-3333-4333-8333-333333333333';
const groupA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const groupB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fixture(){
 const projects=new Map([[phaseA,groupA],[phaseA2,groupA],[phaseB,groupB]]);
 const configs=new Map<string,Record<string,unknown>>([
  [`${phaseA}:4`,{prompt:'旧提示词',model:'phase-a-model',reasoning_effort:'high',material_processing_mode:'original'}],
  [`${phaseA2}:4`,{prompt:'旧提示词',model:'phase-a2-model',reasoning_effort:'low',material_processing_mode:'aliases'}],
  [`${phaseB}:4`,{prompt:'其他项目提示词',model:'phase-b-model',reasoning_effort:'medium'}],
  [`${phaseA}:5`,{prompt:'旧作答提示词',workflow:{hooks:{}}}],
  [`${phaseA2}:5`,{prompt:'旧作答提示词',answer_generation_policy:{request_timeout_ms:1000}}],
 ]);
 const calls:string[]=[];
 const query=async(sql:string,values:unknown[]=[]):Promise<{rows:any[];rowCount:number}>=>{
  calls.push(sql);
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[],rowCount:0};
  if(sql.startsWith('SELECT id,project_group_id FROM ai_distill.projects')){
   const id=String(values[0]),group=projects.get(id);return{rows:group?[{id,project_group_id:group}]:[],rowCount:group?1:0};
  }
  if(sql.startsWith('SELECT id FROM ai_distill.project_groups'))return{rows:[{id:values[0]}],rowCount:1};
  if(sql.startsWith('SELECT p.id,p.project_group_id')){
   const id=String(values[0]),ordinal=Number(values[1]),group=projects.get(id),config=configs.get(`${id}:${ordinal}`);
   return{rows:group?[{id,project_group_id:group,prompt:config?.prompt??null}]:[],rowCount:group?1:0};
  }
  if(sql.startsWith('INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config)\n  SELECT sibling.id')){
   const source=String(values[0]),ordinal=Number(values[1]),prompt=String(values[2]),group=projects.get(source);
   for(const [id,candidateGroup] of projects)if(candidateGroup===group)configs.set(`${id}:${ordinal}`,{...(configs.get(`${id}:${ordinal}`)??{}),prompt});
   return{rows:[],rowCount:0};
  }
  if(sql.startsWith('INSERT INTO ai_distill.project_step_configs(project_id,ordinal,config) SELECT id')){
   const id=String(values[0]),ordinal=Number(values[1]),incoming=JSON.parse(String(values[2]));
   configs.set(`${id}:${ordinal}`,incoming);return{rows:[{config:incoming}],rowCount:1};
  }
  if(sql.startsWith('INSERT INTO ai_distill.project_step_configs AS current_config')){
   const id=String(values[0]),ordinal=Number(values[1]),incoming=JSON.parse(String(values[2])),current=configs.get(`${id}:${ordinal}`);
   if(current?.prompt)incoming.prompt=current.prompt;
   configs.set(`${id}:${ordinal}`,incoming);return{rows:[{config:incoming}],rowCount:1};
  }
  if(sql.startsWith('SELECT config FROM ai_distill.project_step_configs')){
   const config=configs.get(`${values[0]}:${values[1]}`);return{rows:config?[{config}]:[],rowCount:config?1:0};
  }
  if(sql.startsWith("SELECT config->>'prompt' AS prompt")){
   const prompt=configs.get(`${values[0]}:${values[1]}`)?.prompt;return{rows:[{prompt}],rowCount:1};
  }
  if(sql.startsWith('UPDATE ai_distill.project_step_configs SET config=jsonb_build_object')){
   configs.set(`${values[0]}:${values[1]}`,{prompt:values[2]});return{rows:[],rowCount:1};
  }
  throw new Error(`Unexpected query: ${sql}`);
 };
 const client={query,release(){}};
 return{app:createApp({query,connect:async()=>client} as unknown as Pool,'/tmp'),configs,calls};
}

test('提示词保存同步同主项目且保留每期其他配置，并隔离其他主项目',async()=>{
 const {app,configs,calls}=fixture();
 const response=await app.request(`/api/projects/${phaseA}/steps/4/prompt`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'主项目新提示词',expected_prompt:'旧提示词'})});
 expect(response.status).toBe(200);
 expect(configs.get(`${phaseA}:4`)).toEqual({prompt:'主项目新提示词',model:'phase-a-model',reasoning_effort:'high',material_processing_mode:'original'});
 expect(configs.get(`${phaseA2}:4`)).toEqual({prompt:'主项目新提示词',model:'phase-a2-model',reasoning_effort:'low',material_processing_mode:'aliases'});
 expect(configs.get(`${phaseB}:4`)?.prompt).toBe('其他项目提示词');
 expect(calls.some(sql=>sql.includes('workflows')||sql.includes('step_attempts'))).toBe(false);
});

test('整份期次配置只同步提示词，模型与材料模式仍按期保存',async()=>{
 const {app,configs}=fixture();
 const response=await app.request(`/api/agent/projects/${phaseA}/steps/4/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'phase-a-new-model',reasoning_effort:'medium',prompt:'统一后的出题提示词',material_processing_mode:'aliases',material_source_mode:'redacted',expected_prompt:'旧提示词'})});
 expect(response.status).toBe(200);
 expect(configs.get(`${phaseA}:4`)).toMatchObject({prompt:'统一后的出题提示词',model:'phase-a-new-model',material_processing_mode:'aliases'});
 expect(configs.get(`${phaseA2}:4`)).toEqual({prompt:'统一后的出题提示词',model:'phase-a2-model',reasoning_effort:'low',material_processing_mode:'aliases'});
});

test('旧客户端只改模型时保留主项目提示词且不影响其他期次配置',async()=>{
 const {app,configs}=fixture();
 const response=await app.request(`/api/agent/projects/${phaseA}/steps/4/config`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'legacy-client-model',reasoning_effort:'high',material_processing_mode:'original',material_source_mode:'original'})});
 expect(response.status).toBe(200);
 expect(configs.get(`${phaseA}:4`)).toMatchObject({prompt:'旧提示词',model:'legacy-client-model',material_processing_mode:'original'});
 expect(configs.get(`${phaseA2}:4`)).toEqual({prompt:'旧提示词',model:'phase-a2-model',reasoning_effort:'low',material_processing_mode:'aliases'});
});

test('旧弹窗保存返回冲突且不覆盖新提示词或当前草稿目标',async()=>{
 const {app,configs}=fixture();
 configs.set(`${phaseA}:5`,{...configs.get(`${phaseA}:5`),prompt:'外部已更新'});
 configs.set(`${phaseA2}:5`,{...configs.get(`${phaseA2}:5`),prompt:'外部已更新'});
 const response=await app.request(`/api/projects/${phaseA}/steps/5/prompt`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'弹窗里的未保存草稿',expected_prompt:'旧作答提示词'})});
 expect(response.status).toBe(409);
 expect((await response.json() as {error:string}).error).toContain('当前草稿未保存');
 expect(configs.get(`${phaseA}:5`)?.prompt).toBe('外部已更新');
 expect(configs.get(`${phaseA2}:5`)?.prompt).toBe('外部已更新');
});

test('新期继承读取主项目当前三段提示词，不读取其他主项目或系统默认',async()=>{
 let values:unknown[]|undefined;
 const prompts=await readProjectGroupPrompts({query:async(_sql,input)=>{values=input;return{rows:[{ordinal:4,prompt:'组内出题'},{ordinal:5,prompt:'组内作答'},{ordinal:6,prompt:'组内评分'}],rowCount:3};}},groupA);
 expect(values).toEqual([groupA,[4,5,6]]);
 expect(prompts).toEqual({4:'组内出题',5:'组内作答',6:'组内评分'});
});

test('恢复默认只清除当前期非提示词覆盖，不让共享提示词分叉',async()=>{
 const {app,configs}=fixture();
 const response=await app.request(`/api/projects/${phaseA}/steps/4/config`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_prompt:'旧提示词'})});
 expect(response.status).toBe(200);
 expect(configs.get(`${phaseA}:4`)).toEqual({prompt:'旧提示词'});
 expect(configs.get(`${phaseA2}:4`)).toEqual({prompt:'旧提示词',model:'phase-a2-model',reasoning_effort:'low',material_processing_mode:'aliases'});
});
