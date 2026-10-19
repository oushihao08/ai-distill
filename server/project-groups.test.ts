/** 验证主项目/期号身份、归档保留使用账及期次改名不变更业务快照；通过注入 PoolClient 断言 SQL，不连接真实数据库。 */
import {expect,test} from 'bun:test';
import {validatePhaseNumber,resolveProjectGroup,updatePhaseIdentity,setProjectGroupArchived} from './project-groups';
import type {PoolClient} from 'pg';

test('仅可归档没有活动期次的主项目，归档恢复不删除永久使用记录',async()=>{
 const queries:string[]=[];let active=true;
 const client={release(){},async query(sql:string){queries.push(sql);if(sql.startsWith('SELECT id FROM ai_distill.project_groups'))return{rows:[{id:'group'}],rowCount:1};if(sql.includes('FROM ai_distill.projects'))return{rows:active?[{id:'phase'}]:[],rowCount:active?1:0};if(sql.startsWith('UPDATE'))return{rows:[{id:'group'}],rowCount:1};return{rows:[],rowCount:0};}};
 const pool={connect:async()=>client} as any;
 await expect(setProjectGroupArchived(pool,'group',true)).rejects.toThrow('仍有期次');
 active=false;await setProjectGroupArchived(pool,'group',true);await setProjectGroupArchived(pool,'group',false);
 expect(queries.some(sql=>sql.startsWith('DELETE'))).toBe(false);
 expect(queries.filter(sql=>sql.startsWith('UPDATE ai_distill.project_groups'))).toHaveLength(2);
});

test('期号必须为正整数，不从期名或小数推断',()=>{
 expect(validatePhaseNumber(5)).toBe(5);
 for(const value of [undefined,null,0,-1,1.5,'第五期','5'])expect(()=>validatePhaseNumber(value)).toThrow('正整数');
});
test('使用明确主项目ID时拒绝名称不一致，不能错误归组',async()=>{
 const db={query:async()=>({rows:[{id:'11111111-1111-4111-8111-111111111111',name:'项目甲',deleted_at:null}]})} as unknown as PoolClient;
 await expect(resolveProjectGroup(db,'项目乙','11111111-1111-4111-8111-111111111111')).rejects.toThrow('名称已变化');
});
test('同名已归档主项目不能新建另一身份以清除历史使用',async()=>{
 const db={query:async()=>({rows:[{id:'g',name:'项目甲',deleted_at:'2026-10-18'}]})} as unknown as PoolClient;
 await expect(resolveProjectGroup(db,'项目甲')).rejects.toThrow('恢复原项目');
});
test('归入第一期只修改期次身份，题目/步骤/尝试/附件均保持原样',async()=>{
 const writes:string[]=[];
 const client={query:async(sql:string)=>{
  writes.push(sql);
  if(sql.startsWith('SELECT * FROM ai_distill.projects'))return{rows:[{id:'p',name:'Work - 首批筹备',parent_name:'Work'}],rowCount:1};
  if(sql.startsWith('UPDATE ai_distill.projects'))return{rows:[{id:'p',name:'Work - 第一期'}],rowCount:1};
  return{rows:[],rowCount:0};
 },release(){}};
 const result=await updatePhaseIdentity({connect:async()=>client} as any,'p',{phase_no:1,phase_name:'第一期',expected_name:'Work - 首批筹备'});
 expect(result.business_before).toEqual(result.business_after);
 expect(writes.filter(sql=>sql.startsWith('UPDATE '))).toHaveLength(1);
 expect(writes.at(-1)).toBe('COMMIT');
});
