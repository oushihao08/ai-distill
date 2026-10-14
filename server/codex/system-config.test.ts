/** 验证 Codex 模型能力选项、系统与项目默认值继承及设置持久化。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {readCodexModelCatalog,validateCodexModelSettings} from './models';
import {mergeCodexDefaults,readCodexSettings,saveCodexSettings} from './system-config';

function settingsPool(initial:{credential_home:string|null;model:string;reasoning_effort:string}){
 let row={...initial};
 const calls:{sql:string;values?:unknown[]}[]=[];
 const pool={async query(sql:string,values?:unknown[]){
  calls.push({sql,values});
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{...row}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.system_codex_config')){row={credential_home:values?.[0] as string|null,model:values?.[1] as string,reasoning_effort:values?.[2] as string};return{rows:[{...row}],rowCount:1};}
  throw new Error(`Unexpected query: ${sql}`);
 }};
 return{pool:pool as unknown as Pool,calls};
}

test('Codex model dropdown options come from the selected local model catalog',async()=>{
 const home=await mkdtemp(join(tmpdir(),'codex-model-catalog-'));
 try{
  await writeFile(join(home,'models_cache.json'),JSON.stringify({models:[
   {slug:'gpt-test',supported_reasoning_levels:[{effort:'low'},{effort:'high'}],secret:'discard'},
   {slug:'gpt-6-astra',supported_reasoning_levels:[{effort:'low'}]},
   {slug:'bad-entry',supported_reasoning_levels:'invalid'},
  ]}));
  expect(readCodexModelCatalog(home)).toEqual([{slug:'gpt-test',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]},{slug:'gpt-6-astra',supported_reasoning_levels:[{effort:'low'}]}]);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('Codex settings validate structure without enforcing the local suggestion catalog',()=>{
 const catalog=[{slug:'gpt-test',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}];
 expect(validateCodexModelSettings({model:'gpt-test',reasoning_effort:'high'},catalog)).toEqual({model:'gpt-test',reasoning_effort:'high'});
 expect(validateCodexModelSettings({model:'gpt-test',reasoning_effort:'ultra'},catalog)).toEqual({model:'gpt-test',reasoning_effort:'ultra'});
 expect(()=>validateCodexModelSettings({model:'gpt-test',reasoning_effort:'bad effort'},catalog)).toThrow('推理强度');
 expect(validateCodexModelSettings({model:'not-listed',reasoning_effort:'low'},catalog)).toEqual({model:'not-listed',reasoning_effort:'low'});
 expect(()=>validateCodexModelSettings({model:'bad model',reasoning_effort:'low'},catalog)).toThrow('模型');
});

test('project Codex config overrides the system defaults without dropping step-specific fields',()=>{
 const defaults={model:'gpt-default',reasoning_effort:'medium'};
 expect(mergeCodexDefaults(undefined,defaults)).toEqual(defaults);
 expect(mergeCodexDefaults({model:'gpt-project',reasoning_effort:'high',prompt:'保留此提示词'},defaults)).toEqual({model:'gpt-project',reasoning_effort:'high',prompt:'保留此提示词'});
 expect(mergeCodexDefaults({model:'gpt-6-astra',reasoning_effort:'ultra'},defaults)).toEqual({model:'gpt-6-astra',reasoning_effort:'ultra'});
});

test('saved global model and reasoning settings are returned unchanged',async()=>{
 const fixture=settingsPool({credential_home:null,model:'gpt-6-astra',reasoning_effort:'ultra'});
 expect(await readCodexSettings(fixture.pool)).toMatchObject({model:'gpt-6-astra',reasoning_effort:'ultra'});
});

test('saving system Codex defaults persists model and effort while path-only updates preserve them',async()=>{
 const fixture=settingsPool({credential_home:null,model:'gpt-old',reasoning_effort:'low'});
 const catalog=[{slug:'gpt-test',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}];
 expect(await saveCodexSettings(fixture.pool,{credential_home:null,model:'gpt-test',reasoning_effort:'high'},catalog)).toEqual({credential_home:null,model:'gpt-test',reasoning_effort:'high'});
 expect(await saveCodexSettings(fixture.pool,{credential_home:null})).toEqual({credential_home:null,model:'gpt-test',reasoning_effort:'high'});
 expect(fixture.calls.filter(call=>call.sql.startsWith('INSERT INTO ai_distill.system_codex_config'))).toHaveLength(2);
});

test('project Codex defaults override system settings and can return to inheritance',async()=>{
 const api=await import('./system-config') as Record<string,any>;
 expect(typeof api.readProjectCodexSettings).toBe('function');
 const catalog=[{slug:'project-model',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}];
 let project:{codex_model:string|null;codex_reasoning_effort:string|null}={codex_model:null,codex_reasoning_effort:null};
 const pool={async query(sql:string,values?:unknown[]){
  if(sql.startsWith('SELECT codex_model,codex_reasoning_effort FROM ai_distill.projects'))return{rows:[{...project}],rowCount:1};
  if(sql.startsWith('SELECT credential_home,model,reasoning_effort'))return{rows:[{credential_home:null,model:'system-model',reasoning_effort:'medium'}],rowCount:1};
  if(sql.startsWith('UPDATE ai_distill.projects SET codex_model=$2')){project={codex_model:values?.[1] as string,codex_reasoning_effort:values?.[2] as string};return{rows:[{...project}],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.projects SET codex_model=NULL')){project={codex_model:null,codex_reasoning_effort:null};return{rows:[{...project}],rowCount:1};}
  throw new Error(`Unexpected query: ${sql}`);
 }} as unknown as Pool;
 expect(await api.readProjectCodexSettings(pool,'project')).toMatchObject({model:'system-model',reasoning_effort:'medium',source:'system'});
 expect(await api.saveProjectCodexSettings(pool,'project',{model:'project-model',reasoning_effort:'high'},catalog)).toMatchObject({model:'project-model',reasoning_effort:'high',source:'project'});
 expect(await api.readProjectCodexSettings(pool,'project')).toMatchObject({model:'project-model',reasoning_effort:'high',source:'project'});
 expect(await api.clearProjectCodexSettings(pool,'project')).toMatchObject({model:'system-model',reasoning_effort:'medium',source:'system'});
});
