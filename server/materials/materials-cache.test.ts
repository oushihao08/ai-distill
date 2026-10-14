/** 验证材料处理复用健康提取并绑定准确输入指纹。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {processMaterials} from './process';
import {redactionInputDigest} from './redaction-jobs';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
test('material processing reuses verified healthy extraction and extracts a missing source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cached-materials-'));let calls=0;
 try{
  await mkdir(join(root,'old'));await writeFile(join(root,'healthy.pdf'),'healthy source');await writeFile(join(root,'damaged.pdf'),'damaged source');
  const content=JSON.stringify({source_sha256:hash('healthy source'),structure_version:'document-structure-v1',pages:[{page:1,text:'健康文本',method:'ocr',issues:['image_without_text'],structure:[{id:'p1-b1',kind:'paragraph',text:'健康文本'}]}]});await writeFile(join(root,'old','healthy.json'),content);
  const result=await processMaterials(root,'workflow','attempt',[{id:'healthy',storage_path:'healthy.pdf',sha256:hash('healthy source'),extraction_cache:{storage_path:'old/healthy.json',sha256:hash(content),attempt_id:'old',material_id:'healthy'}},{id:'damaged',storage_path:'damaged.pdf',sha256:hash('damaged source')}],{} as any,{extract:async(path:string)=>{calls++;expect(path).toBe(join(root,'damaged.pdf'));return{format:'pdf',provider:'glm-ocr',sha256:hash('damaged source'),pages:[{page:1,text:'恢复原件中的金额100元',method:'ocr'}]};}});
  expect(calls).toBe(1);expect(result.result.issues.length).toBeGreaterThan(0);expect(result.result.materials[0]?.extraction.mode).toBe('cached');expect(result.result.materials[1]?.extraction.mode).toBe('fresh');
  expect(await Bun.file(join(root,'healthy.pdf')).text()).toBe('healthy source');expect(await Bun.file(join(root,'old','healthy.json')).text()).toBe(content);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('redaction input digest survives JSONB field ordering and still binds exact source artifacts',()=>{
 const original={material_id:'material',source_sha256:'source',artifact_id:'artifact',artifact_sha256:'text'};
 const reordered={artifact_sha256:'text',artifact_id:'artifact',source_sha256:'source',material_id:'material'};
 expect(redactionInputDigest([original])).toBe(redactionInputDigest([reordered]));expect(redactionInputDigest([original])).not.toBe(redactionInputDigest([{...reordered,artifact_sha256:'changed'}]));
});
test('legacy digest stays stable for default mode and changes for declared DOCX',()=>{
 const source={material_id:'material',source_sha256:'source',artifact_id:'artifact',artifact_sha256:'text'};
 expect(redactionInputDigest([source])).toBe(redactionInputDigest([{...source,redaction_mode:'model'}]));
 expect(redactionInputDigest([source])).not.toBe(redactionInputDigest([{...source,redaction_mode:'declared_redacted'}]));
});
test('DOCX extraction writes one structured private page without treating it as PDF',async()=>{
 const root=await mkdtemp(join(tmpdir(),'docx-material-'));
 try{
  const source='synthetic docx fixture';await writeFile(join(root,'source.docx'),source);
  const result=await processMaterials(root,'workflow','attempt',[{id:'docx',storage_path:'source.docx',sha256:hash(source)}],undefined,{extract:async()=>({format:'docx',provider:'mineru-api',sha256:hash(source),pages:[{page:1,text:'标题\n正文',method:'text',structure:[{id:'b1',kind:'heading',text:'标题',level:1},{id:'b2',kind:'paragraph',text:'正文'}]}]})});
  expect(result.result.materials[0]).toMatchObject({material_id:'docx',format:'docx',pages:1,provider:'mineru-api'});
  expect(result.artifacts[0]).toMatchObject({kind:'private_extracted_pages',material_id:'docx'});
 }finally{await rm(root,{recursive:true,force:true});}
});

