/** 验证模型集合注册身份、稳定指纹、配置快照与评分门槛持久化。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {answerModelSetDigest,validateModelSet,readProjectModelSet,saveProjectModelSet} from './model-set';
import type {Pool} from 'pg';

const qwen={model_id:'11111111-1111-4111-8111-111111111111',name:'Qwen Plus',minimum_score:8,config:{provider:'qwen',base_url:'https://openrouter.ai/api/v1',model:'qwen/qwen-plus'}} as const;
const deepseek={model_id:'22222222-2222-4222-8222-222222222222',name:'DeepSeek',minimum_score:7,config:{provider:'deepseek',base_url:'https://api.deepseek.com',model:'deepseek-chat'}} as const;

test('valid model set has stable registry identities and safe frozen provider config',()=>{
 expect(validateModelSet([qwen,deepseek])).toEqual([qwen,deepseek]);
 expect(validateModelSet([{...qwen,minimum_score:null}])).toMatchObject([{model_id:qwen.model_id,minimum_score:null}]);
 expect(validateModelSet([{...qwen,name:'GLM',config:{provider:'openrouter',base_url:'https://openrouter.ai/api/v1',model:'z-ai/glm-5.3-flash'}}])).toMatchObject([{name:'GLM',config:{provider:'openrouter',model:'z-ai/glm-5.3-flash'}}]);
});
test('model-set digest is stable when JSONB reorders nested object keys',()=>{
 const restored=[{config:{model:'qwen/qwen-plus',provider:'qwen' as const,base_url:'https://openrouter.ai/api/v1'},minimum_score:8,name:'Qwen Plus',model_id:qwen.model_id},{model_id:deepseek.model_id,name:'DeepSeek',minimum_score:7,config:{model:'deepseek-chat',base_url:'https://api.deepseek.com',provider:'deepseek' as const}}];
 expect(answerModelSetDigest([qwen,deepseek])).toBe(answerModelSetDigest(restored));
});
test.each(([
 [qwen,qwen],
 [{...qwen,model_id:'invalid'}],
 [{...qwen,minimum_score:-1}],
 [{...qwen,minimum_score:'8'}],
 [{...qwen,config:{...qwen.config,api_key:'secret'}}],
 [{...qwen,config:{...qwen.config,model:'bad'}}],
 [{...qwen,name:'  '}],
 Array.from({length:9},(_,i)=>({...qwen,model_id:`${String(i+1).repeat(8)}-1111-4111-8111-111111111111`})),
] as unknown[][]))('rejects invalid or ambiguous model set',models=>expect(()=>validateModelSet(models)).toThrow());

test('project model snapshot keeps selected order and thresholds',async()=>{
 const values:any[]=[];const rows=[{model_id:qwen.model_id,name:qwen.name,minimum_score:'8',config:qwen.config,enabled:true},{model_id:deepseek.model_id,name:deepseek.name,minimum_score:'7',config:deepseek.config,enabled:true}];
 const query=async(sql:string,args:any[]=[])=>{values.push({sql,args});if(sql.includes('FROM ai_distill.project_answer_models'))return {rowCount:2,rows};return {rowCount:1,rows:[]};};
 const result=await readProjectModelSet({query} as unknown as Pool,'project');
 expect(result.map(row=>row.model_id)).toEqual([qwen.model_id,deepseek.model_id]);expect(result.map(row=>row.minimum_score)).toEqual([8,7]);
});
test('project model snapshot preserves an unconfigured threshold as null',async()=>{
 const row={model_id:qwen.model_id,name:qwen.name,minimum_score:null,config:qwen.config,enabled:true};
 const query=async(sql:string)=>sql.includes('FROM ai_distill.project_answer_models')?{rowCount:1,rows:[row]}:{rowCount:1,rows:[]};
 expect(await readProjectModelSet({query} as unknown as Pool,'project')).toMatchObject([{model_id:qwen.model_id,minimum_score:null}]);
});

test('saving project model set preserves requested order and writes only model references',async()=>{
 const values:any[]=[];const catalog=[{model_id:deepseek.model_id,name:deepseek.name,config:deepseek.config,enabled:true},{model_id:qwen.model_id,name:qwen.name,config:qwen.config,enabled:true}];
 const query=async(sql:string,args:any[]=[])=>{values.push({sql,args});if(sql.startsWith('SELECT id FROM ai_distill.projects'))return {rowCount:1,rows:[{id:'project'}]};if(sql.startsWith('SELECT id AS model_id'))return {rowCount:2,rows:catalog};if(sql.includes('FROM ai_distill.project_answer_models'))return {rowCount:0,rows:[]};return {rowCount:1,rows:[]};};
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 const result=await saveProjectModelSet(pool,'project',[{model_id:qwen.model_id,minimum_score:8},{model_id:deepseek.model_id,minimum_score:7}]);
 expect(result.map(row=>row.model_id)).toEqual([qwen.model_id,deepseek.model_id]);
 expect(values.filter(row=>row.sql.startsWith('INSERT INTO ai_distill.project_answer_models')).map(row=>row.args.slice(1))).toEqual([[qwen.model_id,8,0],[deepseek.model_id,7,1]]);
});
test('saving project model set permits unknown acceptance threshold without substituting zero',async()=>{
 const values:any[]=[];const catalog=[{model_id:qwen.model_id,name:qwen.name,config:qwen.config,enabled:true}];
 const query=async(sql:string,args:any[]=[])=>{values.push({sql,args});if(sql.startsWith('SELECT id FROM ai_distill.projects'))return {rowCount:1,rows:[{id:'project'}]};if(sql.startsWith('SELECT id AS model_id'))return {rowCount:1,rows:catalog};if(sql.includes('FROM ai_distill.project_answer_models'))return {rowCount:0,rows:[]};return {rowCount:1,rows:[]};};
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 const saved=await saveProjectModelSet(pool,'project',[{model_id:qwen.model_id,minimum_score:null}]);
 expect(saved[0]?.minimum_score).toBeNull();expect(values.find(row=>row.sql.startsWith('INSERT INTO ai_distill.project_answer_models'))?.args[2]).toBeNull();
});
