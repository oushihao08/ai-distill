/**
 * 职责：对齐第七期私有原件结构与冻结脱敏结构，输出逐包文本差异候选。
 * 入口：bun projects/豆包高经济价值/scripts/name-revision/build-diff-candidates.ts <输入目录> <输出JSON>。
 * 影响：只读输入；输出可能含真实主体名称，固定以0600写入调用方指定的私有路径；不调用模型或写业务库。
 */
import {createHash} from 'node:crypto';
import {mkdir,readdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';

type Leaf={path:string;text:string};
type Sample={file_id:string;original_name:string;page:number;path:string;context:string};
type Span={original:string;before:string;looks_like_entity:boolean};
type Pair={original:string;before:string;count:number;question_hits:number;looks_like_entity:boolean;spans:Span[];samples:Sample[]};
type EntityCandidate={original:string;before:string;count:number;question_hits:number;samples:Sample[]};

const [inputArg,outputArg,batchDirArg]=process.argv.slice(2);
if(!inputArg||!outputArg)throw new Error('用法：build-diff-candidates.ts <输入目录> <输出JSON>');
const inputDir=resolve(inputArg),outputPath=resolve(outputArg);
if(!outputPath.includes(`${process.cwd()}/.storage/`))throw new Error('输出必须位于当前仓库的.storage私有目录');

function leaves(value:unknown,path=''):Leaf[]{
 if(Array.isArray(value))return value.flatMap((item,index)=>leaves(item,`${path}/${index}`));
 if(!value||typeof value!=='object')return[];
 const result:Leaf[]=[];
 for(const [key,item] of Object.entries(value)){
  const next=`${path}/${key}`;
  if(key==='text'&&typeof item==='string')result.push({path:next,text:item});
  else result.push(...leaves(item,next));
 }
 return result;
}
const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();
const isEntityLike=(original:string,before:string)=>{
 const clean=(value:string)=>value.replace(/[·・]/g,'');
 if(!/^[\p{Script=Han}·・（）()]+$/u.test(original)||!/^[\p{Script=Han}·・（）()]+$/u.test(before))return false;
 if(/[法院银行邮政局]$/.test(original)&&original.length>8)return false;
 const suffix=/(?:公司|事务所|委员会|中心|合作社|工作室|集团|学校|医院|商行|经营部|厂|店)$/;
 return suffix.test(original)&&suffix.test(before)||clean(original).length>=2&&clean(original).length<=6&&clean(before).length>=2&&clean(before).length<=6;
};
const commonSurnames=new Set([...`赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉龚程邢滑裴陆荣翁荀羊甄家封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲台从鄂索咸赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终步都耿满匡国文寇广禄阙东殴殳沃利蔚越夔隆师巩厍聂晁勾敖融冷辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公`]);
const compoundSurnames=['欧阳','太史','端木','上官','司马','东方','独孤','南宫','万俟','闻人','夏侯','诸葛','尉迟','公羊','赫连','澹台','皇甫','宗政','濮阳','公冶','太叔','申屠','公孙','慕容','仲孙','钟离','长孙','宇文','司徒','鲜于','司空','闾丘','子车','亓官','司寇','巫马','公西','颛孙','壤驷','公良','漆雕','乐正','宰父','谷梁','拓跋','夹谷','轩辕','令狐','段干','百里','呼延','东郭','南门','羊舌','微生','梁丘','左丘','东门','西门'] as const;
const organizationSuffix=/(?:公司|事务所|委员会|中心|合作社|工作室|集团|学校|医院|商行|经营部|厂|店)$/;
const unchangedPerson=(value:string)=>/^[\p{Script=Han}]{2,4}$/u.test(value)&&(compoundSurnames.some(s=>value.startsWith(s))||commonSurnames.has(value[0]));
const unchangedEntity=(value:string)=>unchangedPerson(value)||value.length>=4&&organizationSuffix.test(value)&&!/(?:人民法院|银行|邮政)$/.test(value);
function changedSpans(original:string,before:string):Span[]{
 if(original===before)return[];
 let start=0;while(start<original.length&&start<before.length&&original[start]===before[start])start++;
 let oldEnd=original.length,newEnd=before.length;while(oldEnd>start&&newEnd>start&&original[oldEnd-1]===before[newEnd-1]){oldEnd--;newEnd--;}
 const old=original.slice(start,oldEnd),next=before.slice(start,newEnd);
 if(!old||!next)return[];
 // 以最长公共片段递归切分同一字段内的多处置换；长字段只保留首尾裁出的差异，避免平方级放大。
 if(old.length>500||next.length>500)return[{original:old,before:next,looks_like_entity:isEntityLike(old,next)}];
 const row=new Uint16Array(next.length+1);let best=0,oldAt=0,newAt=0;
 for(let i=1;i<=old.length;i++)for(let j=next.length;j>=1;j--){row[j]=old[i-1]===next[j-1]?row[j-1]+1:0;if(row[j]>best){best=row[j];oldAt=i-best;newAt=j-best;}}
 if(best<2)return[{original:old,before:next,looks_like_entity:isEntityLike(old,next)}];
 return[...changedSpans(old.slice(0,oldAt),next.slice(0,newAt)),...changedSpans(old.slice(oldAt+best),next.slice(newAt+best))];
}
const contextAround=(text:string,needle:string)=>{
 const at=text.indexOf(needle);
 const context=at<0?text.slice(0,160):text.slice(Math.max(0,at-70),Math.min(text.length,at+needle.length+70));
 return context.slice(0,500);
};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

const packages=[] as any[];
for(const name of (await readdir(inputDir)).filter(name=>name.endsWith('.json')).sort()){
 const bytes=await readFile(join(inputDir,name));
 const source=JSON.parse(bytes.toString('utf8'));
 const pairs=new Map<string,Pair>(),unchanged=new Map<string,EntityCandidate>();
 const questionText=JSON.stringify(source.question??{});
 for(let fileIndex=0;fileIndex<source.files.length;fileIndex++){
  const file=source.files[fileIndex],material=source.frozen_index?.materials?.[fileIndex];
  if(!material?.document?.pages)throw new Error(`${source.package_id} 缺少第${fileIndex+1}个冻结材料结构`);
  const redactedByPage=new Map(material.document.pages.map((page:any)=>[page.page,page]));
  for(const originalPage of file.original_pages){
   const redactedPage:any=redactedByPage.get(originalPage.page);
   if(!redactedPage)throw new Error(`${source.package_id}/${file.file_id} 缺少第${originalPage.page}页冻结结构`);
   const originalLeaves=leaves(originalPage.structure),redactedLeaves=new Map(leaves(redactedPage.blocks).map(leaf=>[leaf.path,leaf.text]));
   for(const leaf of originalLeaves){
    const alias=redactedLeaves.get(leaf.path);
    if(alias===undefined)continue;
    const original=normalize(leaf.text),before=normalize(alias);
    if(!original||!before)continue;
    if(original===before){
     if(unchangedEntity(original)||/^[\p{Script=Han}]{4,12}$/u.test(original)){
      const values=unchangedEntity(original)?[original]:[];
      // OCR表格偶尔把相邻2至3字姓名粘在同一单元格；保留等长切分候选给Agent结合角色上下文判断。
      if(/^[\p{Script=Han}]{4,12}$/u.test(original))for(const size of [2,3])if(original.length%size===0){const chunks=[];for(let at=0;at<original.length;at+=size)chunks.push(original.slice(at,at+size));if(chunks.length>1&&chunks.every(unchangedPerson))values.push(...chunks);}
      for(const value of values){const key=JSON.stringify([value,value]),existing=unchanged.get(key)??{original:value,before:value,count:0,question_hits:questionText.split(value).length-1,samples:[]};existing.count++;
       if(existing.samples.length<5)existing.samples.push({file_id:file.file_id,original_name:file.original_name,page:originalPage.page,path:leaf.path,context:contextAround(originalPage.text,leaf.text)});unchanged.set(key,existing);}
     }
     continue;
    }
    const key=JSON.stringify([original,before]);
    const existing=pairs.get(key)??{original,before,count:0,question_hits:before?questionText.split(before).length-1:0,looks_like_entity:isEntityLike(original,before),spans:changedSpans(original,before),samples:[]};
    existing.count++;
    if(existing.samples.length<5)existing.samples.push({file_id:file.file_id,original_name:file.original_name,page:originalPage.page,path:leaf.path,context:contextAround(originalPage.text,leaf.text)});
    pairs.set(key,existing);
   }
  }
 }
 const all=[...pairs.values()].sort((a,b)=>Number(b.looks_like_entity)-Number(a.looks_like_entity)||b.count-a.count||a.original.localeCompare(b.original,'zh-CN'));
 const entityMap=new Map<string,EntityCandidate>();
 for(const pair of all){
  const candidates=[...(pair.looks_like_entity?[{original:pair.original,before:pair.before}]:[]),...pair.spans.filter(span=>span.looks_like_entity)];
  for(const candidate of candidates){
   const key=JSON.stringify([candidate.original,candidate.before]),existing=entityMap.get(key)??{original:candidate.original,before:candidate.before,count:0,question_hits:0,samples:[]};
   existing.count+=pair.count;existing.question_hits=Math.max(existing.question_hits,pair.question_hits);
   existing.samples.push(...pair.samples.slice(0,Math.max(0,5-existing.samples.length)));entityMap.set(key,existing);
  }
 }
 for(const [key,candidate] of unchanged){const existing=entityMap.get(key);if(existing){existing.count+=candidate.count;existing.question_hits=Math.max(existing.question_hits,candidate.question_hits);existing.samples.push(...candidate.samples.slice(0,Math.max(0,5-existing.samples.length)));}else entityMap.set(key,candidate);}
 const rawEntities=[...entityMap.values()];
 const entityCandidates=rawEntities.filter(candidate=>!rawEntities.some(other=>other!==candidate&&other.original.includes(candidate.original)&&other.before.includes(candidate.before)&&
  candidate.original!==candidate.before&&(other.original.length>candidate.original.length||other.before.length>candidate.before.length))).sort((a,b)=>Number(a.original!==a.before)-Number(b.original!==b.before)||b.question_hits-a.question_hits||b.count-a.count||b.original.length-a.original.length);
 packages.push({package_id:source.package_id,revision_id:source.revision_id,redaction_id:source.redaction_id,workflow_id:source.workflow_id,
  source_sha256:hash(bytes.toString('utf8')),file_count:source.files.length,page_count:source.files.reduce((sum:number,file:any)=>sum+file.original_pages.length,0),
  pair_count:all.length,entity_candidate_count:entityCandidates.length,entity_candidates:entityCandidates,pairs:all});
}
const output=JSON.stringify({format:'phase7-name-diff-candidates-v1',generated_at:new Date().toISOString(),package_count:packages.length,packages},null,2);
await mkdir(dirname(outputPath),{recursive:true,mode:0o700});
await writeFile(outputPath,output,{mode:0o600});await chmod(outputPath,0o600);
let review_batches=0;
if(batchDirArg){
 const batchDir=resolve(batchDirArg);if(!batchDir.includes(`${process.cwd()}/.storage/`))throw new Error('复核批次必须位于当前仓库的.storage私有目录');
 await mkdir(batchDir,{recursive:true,mode:0o700});
 const eligible=packages.filter(item=>item.entity_candidates.length),groups:any[][]=[];
 for(const item of eligible){
  const compact={package_id:item.package_id,redaction_id:item.redaction_id,workflow_id:item.workflow_id,candidates:item.entity_candidates.map((candidate:EntityCandidate)=>({...candidate,samples:candidate.samples.slice(0,2)}))};
  // 单包回执可直接绑定后续预览，也避免大批输出在连接时限内被截断或漏分流。
  groups.push([compact]);
 }
 for(const group of groups){
  const body={model:'gpt-5.6-sol',reasoning_effort:'medium',packages:group};
  const path=join(batchDir,`${String(review_batches+1).padStart(2,'0')}.request.json`);await writeFile(path,JSON.stringify(body,null,2),{mode:0o600});await chmod(path,0o600);review_batches++;
 }
 const manifest={format:'name-mapping-review-batches-v1',model:'gpt-5.6-sol',reasoning_effort:'medium',batch_count:review_batches,package_count:eligible.length,
  empty_candidate_packages:packages.filter(item=>!item.entity_candidates.length).map(item=>({package_id:item.package_id,redaction_id:item.redaction_id,workflow_id:item.workflow_id}))};
 await writeFile(join(batchDir,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
}
console.log(JSON.stringify({output:outputPath,sha256:hash(output),package_count:packages.length,pair_count:packages.reduce((sum,p)=>sum+p.pair_count,0),entity_candidate_count:packages.reduce((sum,p)=>sum+p.entity_candidate_count,0),review_batches}));
