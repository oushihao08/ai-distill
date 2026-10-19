/** 职责：验证本期材料路由的服务端候选分页、已移除关系读取和按单条使用记录加载历史。 */
import {expect,test} from 'bun:test';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import {registerProjectLibraryRoutes} from './projects-routes';

const phaseId='11111111-1111-4111-8111-111111111111';
const packageId='22222222-2222-4222-8222-222222222222';
const useId='33333333-3333-4333-8333-333333333333';
const linkId='44444444-4444-4444-8444-444444444444';

function appWith(query:(sql:string,values:unknown[])=>unknown){
 const pool={query:async(sql:string,values:unknown[]=[])=>query(sql,values)??{rows:[],rowCount:0}} as unknown as Pool;
 const app=new Hono();registerProjectLibraryRoutes(app,pool,'/tmp');return app;
}

test('候选材料支持服务端搜索分页，并只查询当前页的使用状态',async()=>{
 const statements:{sql:string;values:unknown[]}[]=[];
 const app=appWith((sql,values)=>{
  statements.push({sql,values});
  if(sql.startsWith('SELECT project_group_id FROM ai_distill.projects'))return{rows:[{project_group_id:'55555555-5555-4555-8555-555555555555'}],rowCount:1};
  if(sql.startsWith('SELECT p.id,p.name,p.description'))return{rows:[{id:packageId,name:'候选材料',available_redaction_count:1,usage_status:'in_use',used_phase_name:'第二期',total_count:21}],rowCount:1};
  return undefined;
 });
 const response=await app.request(`/api/projects/${phaseId}/material-candidates?q=施工&page=3&page_size=2`);
 expect(response.status).toBe(200);
 const body=await response.json() as any;
 expect(body).toMatchObject({page:3,page_size:2,total_count:21,items:[{used_in_project:true,used_phase_name:'第二期'}]});
 const catalog=statements.find(item=>item.sql.startsWith('SELECT p.id,p.name,p.description'))!;
 expect(catalog.values.slice(0,3)).toEqual(['施工',2,4]);
 expect(statements).toHaveLength(2);
 expect(catalog.values[7]).toBe(phaseId);
 expect(catalog.sql).toContain('project_material_uses');
});

test('材料候选目录与本期身份并行读取，避免多等一次数据库往返',async()=>{
 let releasePhase!:(value:unknown)=>void,catalogStarted=false;
 const app=appWith((sql)=>{
  if(sql.startsWith('SELECT project_group_id FROM ai_distill.projects'))return new Promise(resolve=>{releasePhase=resolve;});
  if(sql.startsWith('SELECT p.id,p.name,p.description')){catalogStarted=true;return{rows:[],rowCount:0};}
  return undefined;
 });
 const pending=app.request(`/api/projects/${phaseId}/material-candidates`);
 await new Promise(resolve=>setTimeout(resolve,0));
 const startedBeforePhaseReturned=catalogStarted;
 releasePhase({rows:[{project_group_id:null}],rowCount:1});
 const response=await pending;
 expect(response.status).toBe(200);
 expect(startedBeforePhaseReturned).toBe(true);
});

test('本期材料可选读取已移除的原加载关系以供恢复',async()=>{
 const app=appWith((sql,values)=>{
  if(sql.startsWith('SELECT l.id,l.project_id,l.package_id'))return values[1]===true?{rows:[{id:linkId,project_id:phaseId,package_id:packageId,package_name:'材料A',removed_at:'2026-10-18T00:00:00Z',lock_version:4}],rowCount:1}:{rows:[],rowCount:0};
  return undefined;
 });
 const response=await app.request(`/api/projects/${phaseId}/loaded-materials?include_removed=true`);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({items:[{id:linkId,removed_at:'2026-10-18T00:00:00Z'}]});
});

test('使用事件按记录读取且拒绝跨期/不存在的使用记录',async()=>{
 const statements:string[]=[];
 const app=appWith((sql,values)=>{
  statements.push(sql);
  if(sql.startsWith('SELECT id FROM ai_distill.project_material_uses'))return{rows:values[0]===useId&&values[1]===phaseId?[{id:useId}]:[],rowCount:values[0]===useId&&values[1]===phaseId?1:0};
  if(sql.includes('project_material_use_events'))return{rows:[{id:'event-a',use_id:useId,status:'submitted',reason:'已上传'}],rowCount:1};
  return undefined;
 });
 const response=await app.request(`/api/projects/${phaseId}/material-uses/${useId}/events`);
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({items:[{id:'event-a',use_id:useId}]});
 const missing=await app.request(`/api/projects/${phaseId}/material-uses/66666666-6666-4666-8666-666666666666/events`);
 expect(missing.status).toBe(404);
 expect(statements.some(sql=>sql.includes('project_material_use_events'))).toBe(true);
});
