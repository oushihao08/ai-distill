/** 项目飞书资料登记与只读同步；CLI project show/sync调用，不分题、不写远端或业务数据库。 */
import {readFile,mkdir,writeFile,rename,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FeishuError,type FeishuClient} from './client';

interface TableRef {table_id:string;name:string;role?:string}
interface FieldMap {name:string;expert_id:string;account_mobile:string;expert_source:string;notes:string}
interface QuestionFields {question_id:string;sync_id:string;expert_id:string;account_user:string;expert_source:string}
export interface ProjectRegistry {
 schema_version:1;key:string;name:string;
 roster:{base_token:string;name:string;primary_table_id:string;tables:TableRef[];fields:FieldMap};
 question_targets:{key:string;name:string;role:string;base_token:string;table_id:string;fields:QuestionFields}[];
 [key:string]:unknown;
}
interface Row {record_id:string;fields:Record<string,unknown>}
interface Field {field_id:string;field_name:string;type:number;property?:{options?:{name:string}[]}|null}
interface CollectedTable {base_token:string;table_id:string;name:string;role?:string;fields:Field[];records:Row[]}
const projectRoot=fileURLToPath(new URL('../projects/',import.meta.url));
export async function readProjectRegistry(key:string,root=projectRoot){
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key))throw new FeishuError('feishu_project_key_invalid');
 const config=JSON.parse(await readFile(join(root,key,'config.json'),'utf8')) as ProjectRegistry;
 if(config.schema_version!==1||config.key!==key||!Array.isArray(config.roster?.tables)||!Array.isArray(config.question_targets))throw new FeishuError('feishu_project_registry_invalid');
 return config;
}
/** 返回目录与规则，不打印私有人员快照。 */
export async function showProjectRegistry(key:string){
 return{registry:await readProjectRegistry(key),private_snapshot_path:join(projectRoot,key,'private','snapshot.json')};
}
function text(value:unknown):string{
 if(typeof value==='string')return value.trim();
 if(typeof value==='number')return Number.isSafeInteger(value)?String(value):'';
 if(Array.isArray(value))return value.map(item=>typeof item?.text==='string'?item.text:'').join('').trim();
 return '';
}
function selectedRows(rows:any[],names:string[]):Row[]{
 return rows.map(row=>({record_id:row.record_id,fields:Object.fromEntries(names.filter(name=>Object.hasOwn(row.fields??{},name)).map(name=>[name,row.fields[name]]))}));
}
/** 同一专家ID保留多条来源引用，一人可对应多题；不把手机号当open_id、不猜专家来源别名。 */
export function buildProjectSnapshot(config:ProjectRegistry,rosters:CollectedTable[],targets:CollectedTable[],checkedAt:string){
 const map=new Map<string,any>(),issues:{code:string;resource?:string;count?:number;values?:string[]}[]=[];
 const names=config.roster.fields;
 for(const table of rosters){
  for(const row of table.records){
   if(!Object.values(row.fields).some(v=>text(v)))continue;
   const expertId=text(row.fields[names.expert_id]),mobile=text(row.fields[names.account_mobile]);
   const ref={base_token:table.base_token,table_id:table.table_id,record_id:row.record_id};
   const identity={name:text(row.fields[names.name]),account_mobile:mobile,expert_source:text(row.fields[names.expert_source])};
   const key=expertId||`unresolved:${table.table_id}/${row.record_id}`;
   let person=map.get(key);
   if(!person){person={expert_id:expertId||null,...identity,source_records:[],identity_status:expertId?'recorded':'missing_expert_id',open_ids_from_existing_assignments:[],question_links:[]};map.set(key,person);}
   else if(JSON.stringify(identity)!==JSON.stringify({name:person.name,account_mobile:person.account_mobile,expert_source:person.expert_source}))person.identity_status='conflicting_roster_records';
   person.source_records.push({...ref,...identity});
  }
 }
 const assignments:any[]=[];
 for(const [index,table] of targets.entries()){
  const target=config.question_targets[index]!,fields=target.fields;
  const options=table.fields.find(field=>field.field_name===fields.expert_source)?.property?.options?.map(option=>option.name)??[];
  const sources=[...new Set([...map.values()].map(person=>person.expert_source).filter(Boolean))] as string[];
  const missing=sources.filter(source=>!options.includes(source));
  if(missing.length)issues.push({code:'expert_source_option_not_present',resource:target.key,values:missing});
  for(const row of table.records){
   const expertId=text(row.fields[fields.expert_id]),questionId=text(row.fields[fields.question_id])||text(row.fields[fields.sync_id]);
   if(!questionId&&!expertId&&!row.fields[fields.account_user])continue;
   const rawUsers=row.fields[fields.account_user];
   const users=Array.isArray(rawUsers)?rawUsers.filter(user=>typeof user?.id==='string').map(user=>({id:user.id,name:user.name??null})):[];
   const assignment={target_key:target.key,base_token:table.base_token,table_id:table.table_id,record_id:row.record_id,question_id:questionId||null,expert_id:expertId||null,account_users:users,expert_source:text(row.fields[fields.expert_source])||null};
   assignments.push(assignment);
   const person=expertId?map.get(expertId):undefined;
   if(person){person.question_links.push({target_key:target.key,record_id:row.record_id,question_id:questionId||null});person.open_ids_from_existing_assignments.push(...users.map(user=>user.id));}
  }
 }
 const people=[...map.values()].map(person=>{
  const ids=[...new Set(person.open_ids_from_existing_assignments)];
  return{...person,open_ids_from_existing_assignments:ids,feishu_user_resolution:ids.length===1?'observed_same_expert_id':ids.length>1?'ambiguous_multiple_users':'mobile_lookup_required',observed_question_count:person.question_links.length};
 });
 for(const status of ['missing_expert_id','conflicting_roster_records']){
  const count=people.filter(person=>person.identity_status===status).length;if(count)issues.push({code:status,count});
 }
 const unresolved=people.filter(person=>person.feishu_user_resolution==='mobile_lookup_required').length;
 if(unresolved)issues.push({code:'feishu_user_id_not_resolved',count:unresolved});
 const unmatched=assignments.filter(row=>row.expert_id&&!map.has(row.expert_id)).length;
 if(unmatched)issues.push({code:'question_expert_not_in_roster',count:unmatched});
 return{schema_version:1,project_key:config.key,checked_at:checkedAt,read_only:true,rosters,question_targets:targets,people,existing_assignments:assignments,issues};
}
export async function syncProjectRegistry(key:string,api:Pick<FeishuClient,'list'>,root=projectRoot){
 const config=await readProjectRegistry(key,root);
 async function collect(base:string,table:TableRef,names:string[]):Promise<CollectedTable>{
  const path=`/bitable/v1/apps/${encodeURIComponent(base)}/tables/${encodeURIComponent(table.table_id)}`;
  const fields=await api.list(path+'/fields');
  const rows=await api.list(path+'/records?field_names='+encodeURIComponent(JSON.stringify(names))+'&user_id_type=open_id');
  return{base_token:base,...table,fields,records:selectedRows(rows,names)};
 }
 // 使用既有CLI会话和固定清单；不扫描其他Base，不读取题面/附件正文。
 const rosters:CollectedTable[]=[],targets:CollectedTable[]=[];
 for(const table of config.roster.tables)rosters.push(await collect(config.roster.base_token,table,Object.values(config.roster.fields)));
 for(const target of config.question_targets)targets.push(await collect(target.base_token,target,Object.values(target.fields)));
 const snapshot=buildProjectSnapshot(config,rosters,targets,new Date().toISOString());
 const directory=join(root,key,'private'),path=join(directory,'snapshot.json');
 await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
 const temp=join(directory,`.snapshot-${crypto.randomUUID()}.tmp`);
 try{await writeFile(temp,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temp,path);}
 finally{await rm(temp,{force:true});}
 return{project_key:key,checked_at:snapshot.checked_at,snapshot_path:path,roster_table_count:rosters.length,person_count:snapshot.people.length,question_target_count:targets.length,observed_question_count:snapshot.existing_assignments.length,unassigned_question_count:snapshot.existing_assignments.filter(row=>!row.expert_id).length,issues:snapshot.issues,remote_writes:0};
}
