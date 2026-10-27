/** 通用操作路由；CLI/RPC共用，参数和JSON正文分离，不包含任何项目字段或默认表ID。 */
import {stat} from 'node:fs/promises';
import {FeishuError,type FeishuClient} from './client';
export const HELP=`用法：bun toolSkills/feishu-operations/scripts/cli.ts <命令> [参数]
应用身份（默认 --as bot，FEISHU_APP_ID/FEISHU_APP_SECRET）：
  base create|get|update --base <base_token>
  table list|create|update|delete --base <base_token> [--id <table_id>]
  field|record|view list|get|create|update|delete --base <base_token> --table <table_id> [--id <资源ID>]
  record batch-create|batch-update|batch-delete --base <base_token> --table <table_id>
  file upload --file <路径> --parent <base_token> [--name <文件名>]
  file download --id <file_token> --output <新文件路径>
  api GET|POST|PUT|PATCH|DELETE <以/开头的OpenAPI资源路径，不含/open-apis前缀>
  auth status
  project show|sync --project <项目key>  # 登记资料/只读同步名单与现有题目归属到本机私有快照
用户身份：official -- <官方lark-cli参数，必须显式--as user或bot>
  例如 official -- base --help；官方登录用 official -- auth login --domain base --no-wait --json
JSON写入正文只从stdin读取；--input <JSON文件>也可。字段定义/单元格值沿用飞书OpenAPI原生JSON。
--dry-run 仅输出请求计划，不登录、不请求。--rpc 为后台交付使用的NDJSON会话。
结果：stdout {ok:true,data}；失败stderr {ok:false,error:{code}}，非零退出。写入超时不自动重试。
所有删除仅作用于显式ID；记录创建后保存record_id，未知回执先查原记录。
`;
export interface Operation {kind:'call'|'list'|'upload'|'download'|'status';path?:string;method?:string;body?:unknown;file?:string;name?:string;parent?:string;output?:string;fileToken?:string}
export function parseCommand(args:string[],body?:unknown):Operation{
 const [resource,action,...rest]=args,flags:Record<string,string>={};
 for(let i=0;i<rest.length;i+=2){const key=rest[i];if(!key?.startsWith('--')||!rest[i+1]||rest[i+1]!.startsWith('--'))throw new FeishuError('feishu_arguments_invalid');if(flags[key])throw new FeishuError('feishu_arguments_invalid');flags[key]=rest[i+1]!;}
 const known=['--base','--table','--id','--file','--parent','--name','--output'];
 if(Object.keys(flags).some(key=>!known.includes(key)))throw new FeishuError('feishu_arguments_invalid');
 const id=(key:string)=>{const value=flags[key];if(!value?.trim())throw new FeishuError('feishu_argument_missing:'+key);return encodeURIComponent(value);};
 if(resource==='auth'&&action==='status')return{kind:'status'};
 if(resource==='file'&&action==='upload'){id('--file');id('--parent');return{kind:'upload',file:flags['--file'],parent:flags['--parent'],name:flags['--name']};}
 if(resource==='file'&&action==='download'){id('--id');id('--output');return{kind:'download',fileToken:flags['--id'],output:flags['--output']};}
 let path:string;
 if(resource==='base')path=action==='create'?'/bitable/v1/apps':`/bitable/v1/apps/${id('--base')}`;
 else{
  const plural:Record<string,string>={table:'tables',field:'fields',record:'records',view:'views'};
  if(!plural[resource??''])throw new FeishuError('feishu_command_unknown');
  path=`/bitable/v1/apps/${id('--base')}/tables${resource==='table'?'':`/${id('--table')}/${plural[resource!]}`}`;
 }
 const methods:Record<string,string>={get:'GET',list:'GET',create:'POST',update:['view','table'].includes(resource??'')?'PATCH':'PUT',delete:'DELETE','batch-create':'POST','batch-update':'POST','batch-delete':'POST'};
 if(!methods[action??''])throw new FeishuError('feishu_command_unknown');
 if(resource==='base'&&!['create','get','update'].includes(action!))throw new FeishuError('feishu_command_unknown');
 if(action?.startsWith('batch-')){if(resource!=='record')throw new FeishuError('feishu_command_unknown');path+='/'+action.replace('-','_');}
 else if(['get','update','delete'].includes(action!)&&resource!=='base')path+='/'+id('--id');
 if(['POST','PUT','PATCH'].includes(methods[action!]!)&&body===undefined)throw new FeishuError('feishu_json_body_required');
 return{kind:action==='list'?'list':'call',path,method:methods[action!]!,...(body===undefined?{}:{body})};
}
export async function executeOperation(api:FeishuClient,operation:Operation):Promise<unknown>{
 if(!operation||typeof operation!=='object')throw new FeishuError('feishu_operation_invalid');
 switch(operation.kind){
  case 'status':return{identity:'bot',verified:true};
  case 'call':return api.call(operation.path!,operation.method,operation.body);
  case 'list':return api.list(operation.path!);
  case 'upload':{
   const file=Bun.file(operation.file!);const info=await stat(operation.file!);if(!info.isFile())throw new FeishuError('feishu_upload_not_file');
   const form=new FormData();form.set('file_name',operation.name??file.name?.split('/').at(-1)??'file');form.set('parent_type','bitable_file');form.set('parent_node',operation.parent!);form.set('size',String(file.size));form.set('file',file);
   return api.call('/drive/v1/medias/upload_all','POST',form);
  }
  case 'download':{
   const bytes=await api.download(operation.fileToken!);
   const {writeFile}=await import('node:fs/promises');await writeFile(operation.output!,bytes,{flag:'wx',mode:0o600});
   return{path:operation.output,bytes:bytes.length};
  }
  default:throw new FeishuError('feishu_operation_invalid');
 }
}
