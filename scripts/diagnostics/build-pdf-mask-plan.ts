/**
 * 职责：为指定已脱敏材料生成独立 PDF 像素打码计划；复用原文/脱敏结构差异候选与 GLM-OCR 原始坐标。
 * 入口：bun scripts/diagnostics/build-pdf-mask-plan.ts --redaction-id <ID> --file-id <ID> --glm-response <私有JSON> --out <私有目录>
 * 使用场景：人工授权的单文件打码验证；只读业务库，不改现有提取/脱敏结果，不调用模型。
 * 敏感边界：映射和计划含真实姓名，只写0600私有文件；stdout仅输出数量与路径。
 */
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createPool} from '../../server/db';

function arg(name:string){const i=process.argv.indexOf(`--${name}`);if(i<0||!process.argv[i+1])throw new Error(`缺少 --${name}`);return process.argv[i+1]!;}
const root=process.cwd(),redactionId=arg('redaction-id'),fileId=arg('file-id'),glmPath=resolve(arg('glm-response')),out=resolve(arg('out'));
if(!out.startsWith(resolve('.storage')+'/'))throw new Error('输出必须位于.storage私有目录');
await mkdir(out,{recursive:true,mode:0o700});
const sourceDir=join(out,'source');await mkdir(sourceDir,{recursive:true,mode:0o700});
const pool=createPool();
let sourcePath:string;
try{
 const redaction=(await pool.query(`SELECT r.package_id,r.revision_id,r.id AS redaction_id,i.text_content AS index_content
  FROM ai_distill.library_redactions r JOIN ai_distill.library_blobs i ON i.id=r.index_blob_id WHERE r.id=$1`,[redactionId])).rows[0];
 if(!redaction)throw new Error('脱敏结果不存在');
 const file=(await pool.query(`SELECT f.id AS file_id,f.original_name,b.text_content AS document
  FROM ai_distill.library_files f JOIN ai_distill.library_documents d ON d.file_id=f.id AND d.revision_id=f.revision_id
  JOIN ai_distill.library_blobs b ON b.id=d.document_blob_id WHERE f.id=$1 AND d.extraction_job_id=(SELECT extraction_job_id FROM ai_distill.library_redactions WHERE id=$2)`,[fileId,redactionId])).rows[0];
 if(!file)throw new Error('原件提取结果不存在');
 const original=JSON.parse(file.document),frozen=JSON.parse(redaction.index_content);
 const source={package_id:redaction.package_id,revision_id:redaction.revision_id,redaction_id:redaction.redaction_id,workflow_id:'00000000-0000-0000-0000-000000000000',question:{},
  files:[{file_id:file.file_id,original_name:file.original_name,original_pages:original.pages}],frozen_index:frozen};
 sourcePath=join(sourceDir,'source.private.json');await writeFile(sourcePath,JSON.stringify(source),{mode:0o600});
}finally{await pool.end();}
const candidatesPath=join(out,'diff-candidates.private.json');
const diffScript=join(root,'projects/豆包高经济价值/scripts/name-revision/build-diff-candidates.ts');
const child=Bun.spawn(['bun',diffScript,sourceDir,candidatesPath],{cwd:root,stdout:'pipe',stderr:'pipe'});
const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
if(code!==0)throw new Error(`差异候选生成失败（退出码${code}）：${stderr.slice(0,300)}`);
const diff=JSON.parse(await readFile(candidatesPath,'utf8'));
const candidates=diff.packages?.[0]?.entity_candidates??[];
const compound=['欧阳','司马','上官','诸葛','东方','尉迟','长孙','慕容'];
const surname=(name:string)=>compound.find(x=>name.startsWith(x))??name[0]??'';
const given=['明','华','强','磊','洋','娜','静','敏','杰','涛','超','宇','琳','浩','然','晨'];
const org=/(?:公司|事务所|委员会|中心|合作社|工作室|集团|学校|医院|商行|经营部|厂|店)$/;
const hash=(s:string)=>parseInt(createHash('sha256').update(s).digest('hex').slice(0,8),16);
const byOriginal=new Map<string,{replacement:string;count:number;ambiguous:boolean}>();
for(const c of candidates){
 if(typeof c.original!=='string'||typeof c.before!=='string'||!c.original||!c.before)continue;
 let replacement=c.before;
 if(c.original===c.before){
  if(org.test(c.original))continue;
  const size=c.original.length<=2?1:2;let value=surname(c.original),h=hash(c.original);
  for(let i=0;i<size;i++){value+=given[h%given.length];h=Math.floor(h/given.length)+i+1;}
  if(value===c.original)value=surname(c.original)+given[(hash(c.original)+1)%given.length];
  replacement=value;
 }
 const old=byOriginal.get(c.original);
 if(old&&old.replacement!==replacement)old.ambiguous=true;
 else byOriginal.set(c.original,{replacement,count:(old?.count??0)+(Number(c.count)||1),ambiguous:old?.ambiguous??false});
}
/** 只保留人名类映射：过滤领域词与超长条目，防止表头/字段标签被当成姓名涂掉。 */
const domainWords=['费用','名称','金额','单价','数量','类别','总计','合计','日期','医院','科室','床号','住院','年龄','性别','诊断','项目','医保','检查','检验','流行','医生','护士'];
const isPersonName=(s:string)=>s.length>=2&&s.length<=4&&!domainWords.some(w=>s.includes(w));
const decode=(s:string)=>s.replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"');
const plain=(s:string)=>decode(s.replace(/<[^>]+>/g,'').replace(/[*#`]/g,''));
type Region={text:string;rect:number[]};
/** GLM只给整表框；按HTML行列/合并关系细分单元格，避免涂掉整表。 */
function tableRegions(content:string,bbox:number[]):Region[]{
 const rows=[...content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]!);
 if(!rows.length)return[];
 const grid:boolean[][]=[],cells:{text:string;row:number;col:number;rows:number;cols:number}[]=[];
 rows.forEach((html,row)=>{
  grid[row]??=[];
  for(const match of html.matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)){
   const attrs=match[2]!,cols=Math.max(1,Number(attrs.match(/colspan\s*=\s*["']?(\d+)/i)?.[1]??1)),rowspan=Math.max(1,Number(attrs.match(/rowspan\s*=\s*["']?(\d+)/i)?.[1]??1));
   let col=0;while(grid[row][col])col++;
   for(let r=row;r<row+rowspan;r++){grid[r]??=[];for(let c=col;c<col+cols;c++)grid[r][c]=true;}
   cells.push({text:plain(match[3]!).trim(),row,col,rows:rowspan,cols});
  }
 });
 const colCount=Math.max(0,...grid.map(row=>row.length));if(!colCount||!cells.length)return[];
 const [x0,y0,x1,y1]=bbox,w=x1-x0,h=y1-y0;
 return cells.filter(cell=>cell.text).map(cell=>({text:cell.text,rect:[x0+w*cell.col/colCount,y0+h*cell.row/rows.length,x0+w*(cell.col+cell.cols)/colCount,y0+h*(cell.row+cell.rows)/rows.length]}));
}
const glm=JSON.parse(await readFile(glmPath,'utf8'));
/** 出题脱敏只脱患者相关人名、医护姓名原样保留，diff 产生不了这些映射；
 *  从「医师：/审核：/报告：」等短标签字段补充 staff 人名，假名算法与 diff 映射一致（同姓保留+确定性给定字）。 */
const staffLabel=/^([\u4e00-\u9fa5]{1,6})[:：]\s*([\u4e00-\u9fa5]{2,4})$/;
const staffKey=/医师|医生|药师|技师|签字|签名|记录|操作/;
const staffSeen=new Set<string>();
for(const layout of glm.layout_details??[])for(const block of layout??[]){
 if(!layout||block.label==='table'||typeof block.content!=='string')continue;
 const text=plain(block.content).trim();
 const m=text.match(staffLabel);
 if(m&&staffKey.test(m[1]!)&&!domainWords.some(w=>m[2]!.includes(w)))staffSeen.add(m[2]!);
}
for(const name of staffSeen){
 if(byOriginal.has(name)||org.test(name))continue;
 const size=name.length<=2?1:2;let value=surname(name),h=hash(name);
 for(let i=0;i<size;i++){value+=given[h%given.length];h=Math.floor(h/given.length)+i+1;}
 if(value===name)value=surname(name)+given[(hash(name)+1)%given.length];
 byOriginal.set(name,{replacement:value,count:1,ambiguous:false,staff:true});
}
const mappings=[...byOriginal.entries()].filter(([o,v])=>isPersonName(o)&&!v.ambiguous&&v.replacement).map(([original,v])=>({original,replacement:v.replacement,staff:v.staff===true})).sort((a,b)=>b.original.length-a.original.length);
const masks:any[]=[],unresolved:any[]=[];
for(const [pageIndex,layout] of (glm.layout_details??[]).entries()){
 if(!Array.isArray(layout))continue;
 for(const [blockIndex,block] of layout.entries()){
  if(typeof block?.content!=='string'||!block.content||block.label==='image'||!Array.isArray(block.bbox_2d))continue;
  const bbox=block.bbox_2d.map(Number),regions=block.label==='table'?tableRegions(block.content,bbox):[{text:plain(block.content).trim(),rect:bbox}];
  if(block.label==='table'&&!regions.length)regions.push({text:plain(block.content).trim(),rect:bbox});
  for(const region of regions)for(const mapping of mappings){
   let from=0;
   while(true){
    const at=region.text.indexOf(mapping.original,from);if(at<0)break;from=at+mapping.original.length;
    const [x0,y0,x1,y1]=region.rect,w=x1-x0,h=y1-y0;
    const exact=region.text.trim()===mapping.original;
    const single=!region.text.includes('\n')&&Array.from(region.text).length<=60;
    if(!exact&&!single){unresolved.push({page:pageIndex+1,block:blockIndex+1,label:block.label??'',native_label:block.native_label??''});continue;}
    let rect=[x0,y0,x1,y1];
    const mode=exact?'exact':'estimated';
    if(!exact){
     // 按字符实际宽度加权估算块内位置：全角=1，半角字符=0.55，空格按整字宽（扫描表单字段间距大）
     const unitW=(s:string)=>Array.from(s).reduce((a,ch)=>a+(/[\x00-\xff]/.test(ch)?(ch===' '?1:0.55):1),0);
     const total=unitW(region.text),start=unitW(region.text.slice(0,at)),len=unitW(mapping.original);
    const tail=at+mapping.original.length===region.text.length;
    rect=[x0+w*start/total,y0,tail?x1:x0+w*(start+len)/total,y1];
    // 手写签名起点不可预测（涂鸦可能压住标签、溢出块框），签名类遮盖整行盖住：行首→页右缘，上下含溢出区
    if(tail&&mapping.staff){
     rect=[x0,rect[1]-h*0.15,Math.min(Number(block.width)-8,rect[2]+w*0.9),Math.min(Number(block.height)-8,rect[3]+h*0.85)];
    }
    }
    masks.push({page:pageIndex+1,rect:[rect[0]-4,rect[1]-3,rect[2]+4,rect[3]+3],replacement:mapping.replacement,mode,text_height:h,page_width:Number(block.width),page_height:Number(block.height)});
   }
  }
 }
}
await writeFile(join(out,'name-map.private.json'),JSON.stringify({mappings},null,2),{mode:0o600});
await writeFile(join(out,'mask-plan.private.json'),JSON.stringify({format:'glm-pixel-mask-v1',masks},null,2),{mode:0o600});
console.log(JSON.stringify({private_directory:out,candidates:candidates.length,mappings:mappings.length,masks:masks.length,unresolved_blocks:unresolved.length,unresolved_by_label:unresolved.reduce((a:any,x)=>{a[x.label]=(a[x.label]??0)+1;return a;},{})},null,2));
