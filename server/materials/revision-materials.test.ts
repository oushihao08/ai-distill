import {DocumentProviderError} from './document';
import {classifyRevisionSource} from '../decisions/revision-source';
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {processMaterials} from './process';
import {redactionInputDigest} from './redaction-jobs';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
test('file repair reuses verified healthy extraction and invokes the extractor only for the damaged original',async()=>{
 const root=await mkdtemp(join(tmpdir(),'repair-materials-'));let calls=0;
 try{
  await mkdir(join(root,'old'));await writeFile(join(root,'healthy.pdf'),'healthy source');await writeFile(join(root,'damaged.pdf'),'damaged source');
  const content=JSON.stringify({source_sha256:hash('healthy source'),pages:[{page:1,text:'健康文本',method:'ocr'}]});await writeFile(join(root,'old','healthy.json'),content);
  const result=await processMaterials(root,'workflow','repair',[{id:'healthy',storage_path:'healthy.pdf',sha256:hash('healthy source'),extraction_cache:{storage_path:'old/healthy.json',sha256:hash(content),attempt_id:'old',material_id:'healthy'}},{id:'damaged',storage_path:'damaged.pdf',sha256:hash('damaged source')}],{} as any,{extract:async(path:string)=>{calls++;expect(path).toBe(join(root,'damaged.pdf'));return{format:'pdf',provider:'glm-ocr',sha256:hash('damaged source'),pages:[{page:1,text:'恢复原件中的金额100元',method:'ocr'}]};}});
  expect(calls).toBe(1);expect(result.result.issues).toEqual([]);expect(result.result.materials[0]?.extraction.mode).toBe('cached');expect(result.result.materials[1]?.extraction.mode).toBe('fresh');
  expect(await Bun.file(join(root,'healthy.pdf')).text()).toBe('healthy source');expect(await Bun.file(join(root,'old','healthy.json')).text()).toBe(content);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('redaction input digest survives JSONB field ordering and still binds exact source artifacts',()=>{
 const original={material_id:'material',source_sha256:'source',artifact_id:'artifact',artifact_sha256:'text'};
 const reordered={artifact_sha256:'text',artifact_id:'artifact',source_sha256:'source',material_id:'material'};
 expect(redactionInputDigest(1,[original])).toBe(redactionInputDigest(1,[reordered]));expect(redactionInputDigest(1,[original])).not.toBe(redactionInputDigest(1,[{...reordered,artifact_sha256:'changed'}]));
});

test('OCR HTTP failures expose bounded classification without raw response text',()=>{
 for(const [status,kind] of [[401,'authentication'],[429,'quota'],[503,'service_transient'],[400,'unknown']] as const){const error=new DocumentProviderError(status);expect(classifyRevisionSource({ordinal:2,status:'failed',result:{error:{kind:error.kind,retryable:error.retryable,http_status:error.http_status}}})).toMatchObject({kind});}
});
