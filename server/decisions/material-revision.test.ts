import {test,expect} from 'bun:test';
import {enqueueMaterialRevision} from './material-revision';
function fixture(missing=false){
 const calls:{sql:string;values:any[]}[]=[];
 const source={id:'source',ordinal:2,input_revision:1,config:{ocr_version:'glm-ocr-layout-v1',model:'glm-ocr'},result:{materials:[{material_id:'pdf',pages:1}],pages:[{material_id:'pdf',page:1}],issues:[{material_id:'pdf',page:1,kind:'empty_page'}]}};
 const query=async(sql:string,values:any[]=[])=>{calls.push({sql,values});if(sql.startsWith('SELECT input_revision'))return{rows:[{input_revision:1}]};if(sql.startsWith('SELECT c.config_snapshot'))return{rows:[{config_snapshot:{configs:{}}}]};if(sql.startsWith('SELECT a.*'))return{rows:[source]};if(sql.startsWith('SELECT id FROM ai_distill.materials'))return{rows:missing?[]:[{id:'pdf'}]};if(sql.startsWith('SELECT id FROM ai_distill.step_attempts'))return{rows:[]};if(sql.startsWith('SELECT r.id'))return{rows:[{id:'round'}]};return{rows:[],rowCount:1};};
 return{pool:{connect:async()=>({query,release(){}})} as any,calls};
}
test('material repair queues only evidenced originals with source OCR settings and a bound round',async()=>{
 const {pool,calls}=fixture();await enqueueMaterialRevision(pool,'workflow','round');
 const inserted=calls.find(c=>c.sql.startsWith('INSERT INTO ai_distill.step_attempts'))!;
 expect(JSON.parse(inserted.values[2]).material_repair).toEqual({source_attempt_id:'source',material_ids:['pdf']});
 expect(JSON.parse(inserted.values[3])).toEqual({ocr_version:'glm-ocr-layout-v1',model:'glm-ocr'});
 expect(calls.some(c=>c.sql.startsWith('UPDATE ai_distill.step_attempts SET revision_round_id'))).toBe(true);
 expect(calls.at(-1)?.sql).toBe('COMMIT');
});
test('missing original waits before any new OCR task is created',async()=>{
 const {pool,calls}=fixture(true);await expect(enqueueMaterialRevision(pool,'workflow','round')).rejects.toThrow('原件缺失');
 expect(calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);expect(calls.at(-1)?.sql).toBe('ROLLBACK');
});
