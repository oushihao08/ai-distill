/** 职责：按稳定workflow UUID搜索飞书记录并完整回读；供服务端及本地交付CLI共用，避免每题拉取整表正文。 */
import type {FeishuClient} from '../../toolSkills/feishu-operations/scripts/client';
import {FeishuError} from '../../toolSkills/feishu-operations/scripts/client';
export async function findFeishuWorkflowRecords(api:FeishuClient,tablePath:string,workflowId:string):Promise<any[]>{
 const identity=(value:unknown)=>typeof value==='string'?value:Array.isArray(value)&&value.every(part=>part?.type==='text'&&typeof part.text==='string')?value.map(part=>part.text).join(''):null;
 const matches:any[]=[],seen=new Set<string>();let cursor='';
 do{
  const page=await api.call(tablePath+'/records/search?page_size=100'+(cursor?'&page_token='+encodeURIComponent(cursor):''),'POST',{field_names:['题目ID','系统同步ID'],filter:{conjunction:'or',conditions:['题目ID','系统同步ID'].map(field_name=>({field_name,operator:'is',value:[workflowId]}))}});
  if(!Array.isArray(page.items)||page.items.some((r:any)=>identity(r.fields?.['题目ID'])!==workflowId&&identity(r.fields?.['系统同步ID'])!==workflowId))throw new FeishuError('feishu_identity_lookup_invalid');
  matches.push(...page.items);
  if(page.has_more&&(!page.page_token||seen.has(page.page_token)))throw new FeishuError('feishu_pagination_invalid');
  cursor=page.has_more?page.page_token:'';if(cursor)seen.add(cursor);
 }while(cursor);
 const records=[];
 for(const match of matches){const record=(await api.call(tablePath+'/records/'+match.record_id)).record;if(!record)throw new FeishuError('feishu_record_missing');records.push(record);}
 return records;
}
