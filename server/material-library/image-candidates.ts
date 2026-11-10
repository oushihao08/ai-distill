/** 从受管原件提取图片候选。只返回图片字节与稳定来源坐标，不写库、不传给脱敏任务。 */
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join,posix} from 'node:path';
import {tmpdir} from 'node:os';
import {hash} from './execution-shared';

export interface ImageCandidate {id:string;page:number;position:number;sha256:string;content_type:'image/png'|'image/jpeg';bytes:Uint8Array;role?:'figure'|'page_scan'|'repeated_decoration'}

/** 开关和冻结文件标记共同决定是否提图；未标记文件沿用纯文本提取。 */
export function shouldExtractImageCandidates(preserveImages:unknown,imageReviewRequired:unknown,format:string){
 return preserveImages===true&&imageReviewRequired===true&&['pdf','docx','png','jpg','jpeg'].includes(format);
}

/** GLM版面页眉、页脚不作为临床插图；其余图片仍交由整理逐张判断。 */
export function glmImageRole(nativeLabel:string):'figure'|'repeated_decoration'{
 return nativeLabel==='header_image'||nativeLabel==='footer_image'?'repeated_decoration':'figure';
}

/** 按图片在PDF页上的物理覆盖范围识别扫描底图；尺寸不可信时保守地不把它认作可交付插图。 */
export function pdfImageRole(width:number,height:number,xppi:number,yppi:number,pageWidth:number,pageHeight:number,repeatedPages=1,totalPages=1):'figure'|'page_scan'|'repeated_decoration'{
 if([width,height,xppi,yppi,pageWidth,pageHeight].some(value=>!Number.isFinite(value)||value<=0))return'page_scan';
 if(width*72/xppi>=pageWidth*0.75&&height*72/yppi>=pageHeight*0.75)return'page_scan';
 return repeatedPages>=3&&repeatedPages>=Math.ceil(totalPages*0.5)?'repeated_decoration':'figure';
}

export function imageDimensions(bytes:Uint8Array,type:'image/png'|'image/jpeg'):{width:number;height:number}{
 const data=Buffer.from(bytes);
 if(type==='image/png'){
  if(data.length<24||data.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('PNG图片无效');
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
  if(!width||!height)throw new Error('PNG尺寸无效');
  return{width,height};
 }
 if(data.length<4||data[0]!==0xff||data[1]!==0xd8)throw new Error('JPEG图片无效');
 for(let offset=2;offset+9<data.length;){
  if(data[offset]!==0xff){offset++;continue;}
  const marker=data[offset+1]!;
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{height:data.readUInt16BE(offset+5),width:data.readUInt16BE(offset+7)};
  if(marker===0xd9||marker===0xda)break;
  const length=data.readUInt16BE(offset+2);if(length<2)break;offset+=2+length;
 }
 throw new Error('JPEG尺寸无效');
}

async function command(args:string[],signal?:AbortSignal,limit=1024*1024):Promise<string>{
 const child=Bun.spawn(args,{stdout:'pipe',stderr:'ignore'});
 const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const [out,code]=await Promise.all([new Response(child.stdout).arrayBuffer(),child.exited]);signal?.removeEventListener('abort',abort);
 if(signal?.aborted)throw signal.reason??new Error('图片候选提取已取消');
 if(code!==0||out.byteLength>limit)throw new Error(`图片候选提取失败：${args[0]}`);
 return Buffer.from(out).toString('utf8');
}

/** PDF 提取嵌入的栅格图，DOCX 提取 word/media；文字、二维码、印章是否有用交由后续整理判断。 */
export async function extractImageCandidates(path:string,format:string,signal?:AbortSignal):Promise<ImageCandidate[]>{
 if(['png','jpg','jpeg'].includes(format)){
  signal?.throwIfAborted();
  const bytes=await readFile(path),content_type=format==='png'?'image/png':'image/jpeg';
  imageDimensions(bytes,content_type);
  const sha256=hash(bytes);
  return[{id:`p1-i0-${sha256.slice(0,12)}`,page:1,position:0,sha256,content_type,bytes}];
 }
 if(format!=='pdf'&&format!=='docx')return[];
 const directory=await mkdtemp(join(tmpdir(),'library-images-'));
 try{
  if(format==='pdf'){
   const listing=await command(['pdfimages','-list',path],signal);
   const imageRows=listing.split('\n').slice(2).map(line=>line.trim().split(/\s+/)).filter(parts=>Number.isSafeInteger(Number(parts[0]))&&Number(parts[0])>0);
   const objectPages=new Map<string,Set<number>>();
   for(const row of imageRows){const key=`${row[10]}:${row[11]}`,pages=objectPages.get(key)??new Set<number>();pages.add(Number(row[0]));objectPages.set(key,pages);}
   const totalPages=Math.max(1,...imageRows.map(row=>Number(row[0])));
   const pageInfo=await command(['pdfinfo','-f','1','-l',String(totalPages),path],signal);
   const pageSizes=new Map([...pageInfo.matchAll(/Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/g)].map(match=>[Number(match[1]),{width:Number(match[2]),height:Number(match[3])}]));
   await command(['pdfimages','-all',path,join(directory,'image')],signal);
   const all=(await readdir(directory)).filter(name=>/^image-\d+\./.test(name));
   if(all.length!==imageRows.length)throw new Error('PDF图片对象数量与提取清单不一致');
   const names=all.sort((a,b)=>Number(a.match(/\d+/)![0])-Number(b.match(/\d+/)![0]));
   const candidates:ImageCandidate[]=[];
   for(const name of names){
    const position=Number(name.match(/\d+/)![0]),row=imageRows[position]!,page=Number(row[0]),supported=/\.(?:png|jpe?g)$/.test(name);
    if(!supported)await command(['pdftoppm','-f',String(page),'-l',String(page),'-singlefile','-r','200','-png',path,join(directory,`fallback-${position}`)],signal);
    const bytes=await readFile(supported?join(directory,name):join(directory,`fallback-${position}.png`)),sha256=hash(bytes);
    const size=pageSizes.get(page),role=size?pdfImageRole(Number(row[3]),Number(row[4]),Number(row[12]),Number(row[13]),size.width,size.height,objectPages.get(`${row[10]}:${row[11]}`)?.size??1,totalPages):'page_scan';
    candidates.push({id:`p${page}-i${position}-${sha256.slice(0,12)}`,page,position,sha256,content_type:!supported||/\.png$/.test(name)?'image/png':'image/jpeg',bytes,role});
   }
   return candidates;
  }
  const listing=await command(['unzip','-Z1',path],signal);
  const available=listing.split('\n').filter(name=>/^word\/media\/[^/]+\.(?:png|jpe?g)$/i.test(name));
  let ordered:string[]=[];
  if(listing.includes('word/document.xml')&&listing.includes('word/_rels/document.xml.rels')){
   const [body,rels]=await Promise.all([command(['unzip','-p',path,'word/document.xml'],signal,10*1024*1024),command(['unzip','-p',path,'word/_rels/document.xml.rels'],signal,10*1024*1024)]);
   const targets=new Map<string,string>();
   for(const tag of rels.match(/<Relationship\b[^>]*>/g)??[]){const id=tag.match(/\bId="([^"]+)"/)?.[1],target=tag.match(/\bTarget="([^"]+)"/)?.[1];if(id&&target)targets.set(id,target.startsWith('/')?target.slice(1):posix.normalize(`word/${target}`));}
   ordered=[...body.matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"/g)].map(match=>targets.get(match[1]!)??'').filter(name=>available.includes(name));
  }
  const names=[...ordered,...available.filter(name=>!ordered.includes(name)).sort()];
  return Promise.all(names.map(async(name,position)=>{
   const child=Bun.spawn(['unzip','-p',path,name],{stdout:'pipe',stderr:'pipe'});
   const [raw,code]=await Promise.all([new Response(child.stdout).arrayBuffer(),child.exited]);
   if(code!==0)throw new Error('DOCX嵌入图片提取失败');
   const bytes=new Uint8Array(raw),sha256=hash(bytes);
   return{id:`p1-i${position}-${sha256.slice(0,12)}`,page:1,position,sha256,content_type:/\.png$/i.test(name)?'image/png' as const:'image/jpeg' as const,bytes};
  }));
 }finally{await rm(directory,{recursive:true,force:true});}
}
