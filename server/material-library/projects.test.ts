/**
 * 职责：验证全局材料包加载关系的事务锁序、选择校验和乐观并发行为。
 * 主要边界：包先于项目锁定；只允许 library_v1 项目引用可用脱敏结果；移除不删除共享包。
 */
import {expect,test} from 'bun:test';
import type {Pool} from 'pg';
import {loadLibraryPackage,readLoadedLibraryPackages,removeLoadedLibraryPackage,updateLoadedLibraryPackage} from './projects';

const projectId='11111111-1111-4111-8111-111111111111';
const packageId='22222222-2222-4222-8222-222222222222';
const redactionId='33333333-3333-4333-8333-333333333333';
const linkId='44444444-4444-4444-8444-444444444444';

function mockPool(respond:(sql:string,values:unknown[])=>unknown){
 const statements:string[]=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{statements.push(sql);const value=respond(sql,values);return value??{rows:[],rowCount:0};},release(){}};
 return{pool:{connect:async()=>client,query:client.query} as unknown as Pool,statements};
}

test('rejects loading without completed redaction and does not insert a project reference',async()=>{
 const {pool,statements}=mockPool(sql=>{
  if(sql.includes('FROM ai_distill.library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:packageId,deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.projects')&&sql.includes('FOR UPDATE'))return{rows:[{id:projectId,material_backend:'library_v1',deleted_at:null}],rowCount:1};
  return undefined;
 });
 await expect(loadLibraryPackage(pool,projectId,packageId)).rejects.toThrow('请先完成脱敏并选择可用脱敏结果');
 expect(statements.some(sql=>sql.startsWith('INSERT INTO ai_distill.project_library_packages'))).toBe(false);
 expect(statements.at(-1)).toBe('ROLLBACK');
});

test('selects only a usable redaction from the requested package',async()=>{
 const {pool,statements}=mockPool(sql=>{
  if(sql.includes('FROM ai_distill.library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:packageId,deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.projects')&&sql.includes('FOR UPDATE'))return{rows:[{id:projectId,material_backend:'library_v1',deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.library_redactions'))return{rows:[{id:redactionId,package_id:packageId,revision_id:'revision-1',usable:'true'}],rowCount:1};
  if(sql.includes('FROM ai_distill.project_library_packages')&&sql.includes('removed_at IS NULL'))return{rows:[],rowCount:0};
  if(sql.includes('max(position)'))return{rows:[{next_position:1}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.project_library_packages'))return{rows:[{id:linkId,project_id:projectId,package_id:packageId,selected_revision_id:'revision-1',selected_redaction_id:redactionId,position:1,lock_version:1}],rowCount:1};
  return undefined;
 });
 const result=await loadLibraryPackage(pool,projectId,packageId,redactionId);
 expect(result).toMatchObject({selected_revision_id:'revision-1',selected_redaction_id:redactionId});
 expect(statements.some(sql=>sql.includes("e.status='succeeded'")&&sql.includes("j.status='succeeded'")&&sql.includes("rev.state='ready'"))).toBe(true);
 expect(statements.findIndex(sql=>sql.includes('FROM ai_distill.library_packages')&&sql.includes('FOR UPDATE'))).toBeLessThan(statements.findIndex(sql=>sql.includes('FROM ai_distill.projects')&&sql.includes('FOR UPDATE')));
});

test('allows an existing legacy project to load a usable shared package',async()=>{
 const {pool,statements}=mockPool(sql=>{
  if(sql.includes('FROM ai_distill.library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:packageId,deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.projects')&&sql.includes('FOR UPDATE'))return{rows:[{id:projectId,material_backend:'legacy',deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.library_redactions'))return{rows:[{id:redactionId,package_id:packageId,revision_id:'revision-1',usable:'true'}],rowCount:1};
  if(sql.includes('FROM ai_distill.project_library_packages')&&sql.includes('removed_at IS NULL'))return{rows:[],rowCount:0};
  if(sql.includes('max(position)'))return{rows:[{next_position:1}],rowCount:1};
  if(sql.startsWith('INSERT INTO ai_distill.project_library_packages'))return{rows:[{id:linkId,project_id:projectId,package_id:packageId,selected_revision_id:'revision-1',selected_redaction_id:redactionId,position:1,lock_version:1}],rowCount:1};
  return undefined;
 });
 const result=await loadLibraryPackage(pool,projectId,packageId,redactionId);
 expect(result).toMatchObject({project_id:projectId,package_id:packageId,selected_redaction_id:redactionId});
 expect(statements.at(-1)).toBe('COMMIT');
});

test('reads loaded packages for legacy projects without filtering by project backend',async()=>{
 const {pool,statements}=mockPool(sql=>sql.includes('FROM ai_distill.project_library_packages')
  ?{rows:[{id:linkId,project_id:projectId,package_id:packageId,package_name:'共享包'}],rowCount:1}
  :undefined);
 await readLoadedLibraryPackages(pool,projectId);
 expect(statements[0]).not.toContain("material_backend='library_v1'");
});

test('updates selection with lock version and removes only the project relation',async()=>{
 let currentLinkVersion=2;
 const {pool,statements}=mockPool((sql,values)=>{
  if(sql.startsWith('SELECT package_id FROM ai_distill.project_library_packages'))return{rows:[{package_id:packageId}],rowCount:1};
  if(sql.includes('FROM ai_distill.library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:packageId,deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.projects')&&sql.includes('FOR UPDATE'))return{rows:[{id:projectId,material_backend:'library_v1',deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.project_library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:linkId,project_id:projectId,package_id:packageId,selected_revision_id:'revision-1',selected_redaction_id:redactionId,position:1,lock_version:currentLinkVersion,removed_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.library_redactions'))return{rows:[{id:redactionId,package_id:packageId,revision_id:'revision-1',usable:'true'}],rowCount:1};
  if(sql.startsWith('UPDATE ai_distill.project_library_packages SET selected_revision_id')){currentLinkVersion=3;return{rows:[{id:linkId,selected_revision_id:'revision-1',selected_redaction_id:redactionId,lock_version:3}],rowCount:1};}
  if(sql.startsWith('UPDATE ai_distill.project_library_packages SET removed_at'))return{rows:[{id:linkId,removed_at:'now',lock_version:3}],rowCount:1};
  return undefined;
 });
 const updated=await updateLoadedLibraryPackage(pool,projectId,linkId,2,{redaction_id:redactionId});
 expect(updated).toMatchObject({id:linkId,lock_version:3});
 const removed=await removeLoadedLibraryPackage(pool,projectId,linkId,3);
 expect(removed).toMatchObject({id:linkId,removed_at:'now'});
 expect(statements.some(sql=>sql.startsWith('DELETE FROM ai_distill.library_packages'))).toBe(false);
});

test('rejects a requested redaction that has no successful usable result',async()=>{
 const {pool,statements}=mockPool(sql=>{
  if(sql.includes('FROM ai_distill.library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:packageId,deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.projects')&&sql.includes('FOR UPDATE'))return{rows:[{id:projectId,material_backend:'library_v1',deleted_at:null}],rowCount:1};
  return undefined;
 });
 await expect(loadLibraryPackage(pool,projectId,packageId,redactionId)).rejects.toThrow('所选脱敏结果不存在');
 expect(statements.at(-1)).toBe('ROLLBACK');
});

test('旧期尚未迁库时409仍提交历史占用索引，不生成新期加载关系',async()=>{
 const {pool,statements}=mockPool((sql,values)=>{
  if(sql.includes('FROM ai_distill.library_packages')&&sql.includes('FOR UPDATE'))return{rows:[{id:packageId,deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.projects')&&sql.includes('FOR UPDATE'))return{rows:[{id:projectId,project_group_id:'group',deleted_at:null}],rowCount:1};
  if(sql.includes('FROM ai_distill.library_redactions'))return{rows:[{id:redactionId,package_id:packageId,revision_id:'rev',usable:'true'}]};
  if(sql.includes('FROM ai_distill.library_files'))return{rows:[{sha256:'a'.repeat(64),size_bytes:10}]};
  if(sql.includes('jsonb_agg'))return{rows:[{project_id:'phase5',phase_name:'第五期',workflow_id:'old-workflow',created_at:'2026-01-01Z',files:[{sha256:'a'.repeat(64),size_bytes:10}]}]};
  if(sql.startsWith('INSERT INTO ai_distill.project_material_uses'))return{rows:[{id:'use',owner_phase_id:values[3]}]};
 });
 await expect(loadLibraryPackage(pool,projectId,packageId,redactionId)).rejects.toThrow('第五期');
 expect(statements.at(-1)).toBe('COMMIT');
 expect(statements.some(sql=>sql.startsWith('INSERT INTO ai_distill.project_library_packages'))).toBe(false);
});
