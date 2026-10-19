/** 文件职责：验证跨期占用、同源副本防重、提交证据和原期返修边界，使用账独立于题目生命周期。 */
import {expect,test} from 'bun:test';
import type {PoolClient} from 'pg';
import {materialSetSignature,claimMaterialUse,validateUseUpdate,assertMaterialUse,indexLegacyMaterialUse,readPhaseMaterialUses} from './uses';
const sha='a'.repeat(64),signature=materialSetSignature([{sha256:sha,size_bytes:10}]);
const phase={id:'phase6',project_group_id:'groupA'};
function db(respond:(sql:string,values:unknown[])=>any){return{query:async(sql:string,values:unknown[]=[])=>respond(sql,values)??{rows:[]}} as unknown as PoolClient;}
test('相同原件的改名、改序和重复附加不能得到新材料身份',()=>{
 expect(materialSetSignature([{sha256:sha,size_bytes:10},{sha256:sha,size_bytes:10}])).toBe(signature);
 expect(()=>materialSetSignature([])).toThrow();
 expect(()=>materialSetSignature([{sha256:'invalid',size_bytes:10}])).toThrow();
});
test('第五期已用，后续第六期不能加载；已退回使用中也不能释放',async()=>{
 for(const status of ['in_use','submitted']){
  const client=db(sql=>sql.includes('FROM ai_distill.project_material_uses u')?{rows:[{owner_phase_id:'phase5',package_id:'p',phase_name:'第五期',status}]}:undefined);
  await expect(claimMaterialUse(client,phase,'p',signature)).rejects.toThrow('第五期');
 }
});
test('同一期相同包重放返回原使用账，复制包不能重复占用',async()=>{
 const client=db(sql=>sql.includes('FROM ai_distill.project_material_uses u')?{rows:[{id:'use',owner_phase_id:phase.id,package_id:'p',status:'in_use'}]}:undefined);
 expect((await claimMaterialUse(client,phase,'p',signature)).id).toBe('use');
 await expect(claimMaterialUse(client,phase,'copy',signature)).rejects.toThrow('副本');
});
test('尚未迁库的旧期原件同样阻止新期加载',async()=>{
 const client=db(sql=>sql.includes('jsonb_agg')?{rows:[{phase_name:'第五期',files:[{sha256:sha,size_bytes:10}]}]}:undefined);
 await expect(claimMaterialUse(client,phase,'p',signature)).rejects.toThrow('第五期');
});
test('旧期同源原件被发现时登记到旧期，保持题目独立并保存来源证据',async()=>{
 const writes:{sql:string;values:unknown[]}[]=[];
 const client=db((sql,values)=>{
  writes.push({sql,values});
  if(sql.includes('jsonb_agg'))return{rows:[{workflow_id:'old-workflow',project_id:'phase5',phase_name:'第五期',created_at:'2026-01-01Z',files:[{sha256:sha,size_bytes:10}]}]};
  if(sql.startsWith('INSERT INTO ai_distill.project_material_uses'))return{rows:[{id:'use',owner_phase_id:values[3],package_id:'p'}]};
 });
 const use=await indexLegacyMaterialUse(client,phase,'p',signature);
 expect(use?.owner_phase_id).toBe('phase5');
 expect(writes.find(w=>w.sql.startsWith('INSERT INTO ai_distill.project_material_uses'))?.values[3]).toBe('phase5');
 expect(writes.find(w=>w.sql.includes('INSERT INTO ai_distill.project_material_use_events'))?.values.at(-1)).toContain('old-workflow');
});
test('另一个主项目独立首次加载，同时保存不依赖题目的使用事件',async()=>{
 const writes:string[]=[];
 const client=db((sql,values)=>{
  writes.push(sql);
  if(sql.startsWith('INSERT INTO ai_distill.project_material_uses'))return{rows:[{id:values[0],owner_phase_id:values[3],project_group_id:values[1],status:'in_use'}]};
 });
 const use=await claimMaterialUse(client,{id:'phaseB',project_group_id:'groupB'},'p',signature);
 expect(use.project_group_id).toBe('groupB');
 expect(writes.some(sql=>sql.startsWith('INSERT INTO ai_distill.project_material_use_events'))).toBe(true);
});
test('不得把归档或空证据直接当作外部已提交，退回必须说明原因',()=>{
 expect(()=>validateUseUpdate({status:'submitted',reason:'归档成功'})).toThrow('回执');
 expect(()=>validateUseUpdate({status:'in_use',reason:''})).toThrow('原因');
 expect(validateUseUpdate({status:'in_use',reason:'被驳回，原期返修'}).status).toBe('in_use');
});
test('已提交材料不能直接新建题，串期使用账被拒绝',async()=>{
 const client=db(()=>({rows:[{owner_phase_id:phase.id,package_id:'p',status:'submitted'}]}));
 await expect(assertMaterialUse(client,phase.id,'p','u')).rejects.toThrow('退回使用中');
 await expect(assertMaterialUse(client,'other','p','u')).rejects.toThrow('不属于');
});

test('本期使用记录摘要不读取或返回全部历史事件',async()=>{
 const statements:string[]=[];
 const pool={query:async(sql:string)=>{statements.push(sql);return{rows:[{id:'use-a',package_id:'package-a',package_name:'材料A',status:'in_use',lock_version:2}]};}} as any;
 const records=await readPhaseMaterialUses(pool,'phase-a');
 expect(records).toHaveLength(1);
 expect(records[0]).not.toHaveProperty('events');
 expect(statements.some(sql=>sql.includes('project_material_use_events'))).toBe(false);
});
