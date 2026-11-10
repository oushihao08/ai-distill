/** 图片候选的原件提取与脱敏输入隔离；不调用OCR、模型或业务数据库。 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {extractImageCandidates,glmImageRole,imageDimensions,pdfImageRole,shouldExtractImageCandidates} from './image-candidates';
import {enqueueAtomicLibraryImport} from './atomic-import';
import {redactionPageInput} from './redaction-runner';
import {ensurePages,storeExtractedDocument} from './execution-shared';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');

test('保图默认关闭且只处理显式标记的图片文件',()=>{
 expect(shouldExtractImageCandidates(undefined,true,'pdf')).toBe(false);
 expect(shouldExtractImageCandidates(false,true,'pdf')).toBe(false);
 expect(shouldExtractImageCandidates(true,false,'pdf')).toBe(false);
 expect(shouldExtractImageCandidates(true,undefined,'pdf')).toBe(false);
 expect(shouldExtractImageCandidates(true,true,'txt')).toBe(false);
 expect(shouldExtractImageCandidates(true,true,'pdf')).toBe(true);
 expect(shouldExtractImageCandidates(true,true,'docx')).toBe(true);
});

test('智谱版面页眉页脚排除，普通图片仍需逐图判断',()=>{
 expect(glmImageRole('header_image')).toBe('repeated_decoration');
 expect(glmImageRole('footer_image')).toBe('repeated_decoration');
 expect(glmImageRole('image')).toBe('figure');
 expect(glmImageRole('')).toBe('figure');
});

test('PDF整页扫描底图区别于独立插图，元数据缺失时不作为插图',()=>{
 expect(pdfImageRole(2124,3264,297,297,595,842)).toBe('page_scan');
 expect(pdfImageRole(312,90,216,216,595,842)).toBe('figure');
 expect(pdfImageRole(312,90,216,216,595,842,29,29)).toBe('repeated_decoration');
 expect(pdfImageRole(2124,3264,0,0,595,842)).toBe('page_scan');
});

test('DOCX嵌入图保留来源、摘要和原字节',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-image-test-'));
 try{
  await mkdir(join(root,'word','media'),{recursive:true});await writeFile(join(root,'word','media','image1.png'),png);
  const zip=join(root,'source.docx'),child=Bun.spawn(['zip','-q',zip,'word/media/image1.png'],{cwd:root,stdout:'pipe',stderr:'pipe'});
  expect(await child.exited).toBe(0);
  const images=await extractImageCandidates(zip,'docx');
  expect(images).toHaveLength(1);expect(images[0]!.page).toBe(1);expect(Buffer.from(images[0]!.bytes)).toEqual(png);
  expect(imageDimensions(images[0]!.bytes,'image/png')).toEqual({width:1,height:1});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('DOCX按正文引用顺序保留重复出现的图片',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-image-order-'));
 try{
  await mkdir(join(root,'word','media'),{recursive:true});await mkdir(join(root,'word','_rels'));
  await writeFile(join(root,'word','media','image1.png'),png);
  await writeFile(join(root,'word','document.xml'),'<w:document><a:blip r:embed="rId1"/><a:blip r:embed="rId1"/></w:document>');
  await writeFile(join(root,'word','_rels','document.xml.rels'),'<Relationships><Relationship Id="rId1" Target="media/image1.png"/></Relationships>');
  const zip=join(root,'source.docx'),child=Bun.spawn(['zip','-q',zip,'word/media/image1.png','word/document.xml','word/_rels/document.xml.rels'],{cwd:root,stdout:'pipe',stderr:'pipe'});
  expect(await child.exited).toBe(0);
  const images=await extractImageCandidates(zip,'docx');
  expect(images.map(image=>image.position)).toEqual([0,1]);
  expect(images.map(image=>image.sha256)).toEqual([images[0]!.sha256,images[0]!.sha256]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('独立PNG原件作为单张候选，纯文本不可要求逐图判断',async()=>{
 const root=await mkdtemp(join(tmpdir(),'library-image-direct-'));
 try{
  const path=join(root,'source.png');await writeFile(path,png);
  const images=await extractImageCandidates(path,'png');
  expect(images).toHaveLength(1);expect(images[0]!.page).toBe(1);expect(Buffer.from(images[0]!.bytes)).toEqual(png);
  const db={query:async()=>({rows:[{available:true}]})};
  await expect(enqueueAtomicLibraryImport(db as any,root,'11111111-1111-4111-8111-111111111111',{name:'测试'},[{original_name:'note.txt',bytes:Buffer.from('正文')}],undefined,undefined,{preserve_images:true,image_review_files:[true]})).rejects.toThrow('纯文本材料不能标记逐图判断');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('脱敏页输入白名单不携带图片对象或路径',()=>{
 const page:any={page:1,text:'就诊记录',structure:[{id:'b1',kind:'paragraph',text:'就诊记录'}],method:'ocr',image_candidates:[{id:'secret'}],image_path:'/private/image.png'};
 expect(redactionPageInput(page)).toEqual({page:1,text:'就诊记录',structure:page.structure,method:'ocr'});
});

test('图片引用随提取正文同次保存，正文结构不变',async()=>{
 let persisted='';const db={query:async(sql:string,values:unknown[])=>{if(sql.startsWith('INSERT INTO ai_distill.library_blobs')){persisted=String(values[4]);return{rows:[{id:'blob'}]};}return{rows:[]};}};
 const pages=ensurePages([{page:1,text:'检查结果',structure:[{id:'b1',kind:'paragraph',text:'检查结果'}],method:'ocr'}],'a'.repeat(64));
 const images=[{id:'p1-i0-123456789abc',page:1,position:0,sha256:'b'.repeat(64),blob_id:'image-blob'}];
 const saved=await storeExtractedDocument(db as any,pages,images);
 expect(saved.document.pages[0]!.text).toBe('检查结果');
 expect(JSON.parse(persisted).image_candidates).toEqual(images);
});
