/** 真实本地Bun子进程和临时目录验证有界私有诊断；不运行项目交付脚本、数据库或模型。 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {runProjectDelivery,type DeliveryInput} from './project-delivery';
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
