/** 真实本地Bun子进程和临时目录验证有界私有诊断；不运行项目交付脚本、数据库或模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {runProjectDelivery,loadProjectArchive,resolveProjectDelivery,type DeliveryInput} from './project-delivery';
test('failed project script keeps bounded output privately; public error contains no script output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'delivery-diagnostics-'));
 try{
  const scripts=join(root,'scripts');await mkdir(scripts);const path=join(scripts,'delivery.ts');
  const code="process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('private-fixture-'+ 'x'.repeat(100000));process.exitCode=7;});";
  await writeFile(path,code);const sha256=createHash('sha256').update(code).digest('hex');
  const digest=createHash('sha256').update(JSON.stringify([{path:'scripts/delivery.ts',sha256}])).digest('hex');
  let error:any;try{await runProjectDelivery({mode:'script',path,projectRoot:root,digest},{} as DeliveryInput,root);}catch(e){error=e;}
  expect(error.message).not.toContain('private-fixture');expect(error.diagnostic_id).toBeString();
  const folder=join(root,'.delivery-diagnostics'),files=await readdir(folder);expect(files).toEqual([`${error.diagnostic_id}.json`]);
  const file=join(folder,files[0]!);const saved=JSON.parse(await readFile(file,'utf8'));
  expect(saved.exit_code).toBe(7);expect(saved.stderr).toStartWith('private-fixture');expect(Buffer.byteLength(saved.stderr)).toBeLessThanOrEqual(65536);expect(saved.truncated).toBe(true);expect((await stat(file)).mode&0o777).toBe(0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('different project scripts retain their own output formats through the shared executor',async()=>{
 for(const [filename,content] of [['project-a.txt','project A contract'],['project-b.json','{"project":"B"}']]){
  const root=await mkdtemp(join(tmpdir(),'delivery-project-specific-'));
  try{
   const scripts=join(root,'scripts');await mkdir(scripts);const path=join(scripts,'delivery.ts');
   const code=`import {writeFileSync} from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>writeFileSync(process.env.AI_DISTILL_DELIVERY_PARENT_DIR+'/'+${JSON.stringify(filename)},${JSON.stringify(content)}));`;
   await writeFile(path,code);const sha256=createHash('sha256').update(code).digest('hex');
   const digest=createHash('sha256').update(JSON.stringify([{path:'scripts/delivery.ts',sha256}])).digest('hex');
   await runProjectDelivery({mode:'script',path,projectRoot:root,digest},{} as DeliveryInput,root);
   expect(await readFile(join(root,filename!),'utf8')).toBe(content!);
   expect((await readdir(root)).includes('.delivery-diagnostics')).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});

test('project archive preparation is optional and isolated to its own project directory',async()=>{
 expect(await loadProjectArchive({mode:'noop',digest:'none'})).toBeUndefined();
 for(const name of ['project-a','project-b']){
  const root=await realpath(await mkdtemp(join(tmpdir(),'archive-adapter-')));
  try{
   const scripts=join(root,'scripts');await mkdir(scripts);const path=join(scripts,'delivery.ts');await writeFile(path,'export {};');
   const base={mode:'script' as const,path,projectRoot:root,digest:'unused'};
   expect(await loadProjectArchive(base)).toBeUndefined();
   await writeFile(join(scripts,'archive.ts'),`export async function prepare(input){if(input.title!==${JSON.stringify(name)})throw new Error('project requirement');input.attachments=[];}`);
   const files=await Promise.all((await readdir(scripts)).sort().map(async filename=>({path:`scripts/${filename}`,sha256:createHash('sha256').update(await readFile(join(scripts,filename))).digest('hex')})));
   const module=await loadProjectArchive({...base,digest:createHash('sha256').update(JSON.stringify(files)).digest('hex')});
   const input={title:name,attachments:[]} as unknown as DeliveryInput;
   await module!.prepare!(input,{} as any);
   await expect(module!.prepare!({...input,title:'other-project'},{} as any)).rejects.toThrow('project requirement');
  }finally{await rm(root,{recursive:true,force:true});}
 }
});

test('the actual Work adapter loads independently and the Doubao project has no Work adapter',async()=>{
 const work=await loadProjectArchive(await resolveProjectDelivery('Work法律全场景'));
 expect(typeof work?.prepare).toBe('function');
 expect(await work!.readConfig!({query:async()=>({rows:[{content_contract:'work_legal_v1'}]})} as any,'project','workflow')).toBeNull();
 expect(await loadProjectArchive(await resolveProjectDelivery('豆包高经济价值'))).toBeUndefined();
});

test('each project declares its own policy dependencies and changed policy stops stale execution',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'delivery-dependencies-')));
 try{
  const scripts=join(root,'scripts');await mkdir(scripts);const path=join(scripts,'delivery.ts');
  await writeFile(path,"process.stdin.resume();");
  await writeFile(join(root,'project-policy.md'),'project-specific policy');
  await writeFile(join(scripts,'delivery-dependencies.json'),JSON.stringify(['project-policy.md']));
  const files=await Promise.all(['project-policy.md','scripts/delivery-dependencies.json','scripts/delivery.ts'].map(async name=>({path:name,sha256:createHash('sha256').update(await readFile(join(root,name))).digest('hex')})));
  const delivery={mode:'script' as const,path,projectRoot:root,digest:createHash('sha256').update(JSON.stringify(files)).digest('hex')};
  await runProjectDelivery(delivery,{} as DeliveryInput,root);
  await writeFile(join(root,'project-policy.md'),'changed project policy');
  await expect(runProjectDelivery(delivery,{} as DeliveryInput,root)).rejects.toThrow('规则依赖已变化');
 }finally{await rm(root,{recursive:true,force:true});}
});
