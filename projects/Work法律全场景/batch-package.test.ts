/**
 * 职责：验证 Work 批次题包的结构、官方固定模板、golden 一致性与安全失败边界。
 * 主要验证：完整批次成功组装；缺文件、模板偏差和不一致参考答案不得生成 ZIP。
 */
import {test,expect} from 'bun:test';
import {chmod,mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildBatchPackage} from './batch-package.ts';

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'work-batch-'));
 const task=join(root,'source','LAW-001');
 const official=join(root,'official');
 const output=join(root,'out');
 await mkdir(official,{recursive:true});
 await mkdir(output,{recursive:true});
 await writeFile(join(official,'test.sh'),'#!/bin/bash\n# official test\n');
 await writeFile(join(official,'finalize.py'),'# official finalize\n');
 for(const directory of ['environment/input_files','solution/golden_output','tests/__golden_output']) await mkdir(join(task,directory),{recursive:true});
 const files:Record<string,string>={
  'instruction.md':'Task instruction',
  'task.toml':'schema_version = "1.4"\n\n[task]\nname = "work/LAW-001"\n\n[metadata]\ntask_id = "LAW-001"\n',
  'rubrics.json':'[]\n',
  'environment/Dockerfile':'FROM scratch\n',
  'environment/requirements.txt':'',
  'environment/input_files/source.txt':'input',
  'solution/solve.sh':'#!/bin/bash\n',
  'solution/golden_output/result.txt':'golden',
  'tests/rubrics.toml':'',
  'tests/prompt.md':'{criteria}',
  'tests/__golden_output/result.txt':'golden',
 };
 for(const [name,content] of Object.entries(files)){
  await mkdir(join(task,name,'..'),{recursive:true});
  await writeFile(join(task,name),content);
 }
 await writeFile(join(task,'tests/test.sh'),await readFile(join(official,'test.sh')));
 await writeFile(join(task,'tests/finalize.py'),await readFile(join(official,'finalize.py')));
 await chmod(join(task,'solution/solve.sh'),0o755);
 await chmod(join(task,'tests/test.sh'),0o755);
 const deliveryDocument=join(root,'delivery.md');
 await writeFile(deliveryDocument,'# work-legal-LS02-20261014\n\n题目数量：1\n\n环境变量说明：待按实际模板填写。\n');
 const manifest={
  batch_name:'work-legal-LS02-20261014',
  output_directory:output,
  delivery_document:deliveryDocument,
  official_templates:{test_sh:join(official,'test.sh'),finalize_py:join(official,'finalize.py')},
  tasks:[{id:'LAW-001',directory:task}],
 };
 return {root,task,official,output,manifest};
}

test('完整题包逐项校验后生成批次目录和单一 ZIP',async()=>{
 const f=await fixture();
 try{
  const result=await buildBatchPackage(f.manifest);
  expect(result.task_count).toBe(1);
  expect(await readFile(join(result.directory,'LAW-001','tests/test.sh'),'utf8')).toBe('#!/bin/bash\n# official test\n');
  expect((await readFile(join(result.zip_path))).length).toBeGreaterThan(0);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('固定模板不一致时失败且不生成批次产物',async()=>{
 const f=await fixture();
 try{
  await writeFile(join(f.task,'tests/test.sh'),'#!/bin/bash\nchanged\n');
  await expect(buildBatchPackage(f.manifest)).rejects.toThrow('tests/test.sh');
  expect(await readdir(f.output)).toEqual([]);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('两份 golden 内容不一致时拒绝组包',async()=>{
 const f=await fixture();
 try{
  await writeFile(join(f.task,'tests/__golden_output/result.txt'),'different');
  await expect(buildBatchPackage(f.manifest)).rejects.toThrow('golden');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('缺少官方 A1 原件时拒绝生成',async()=>{
 const f=await fixture();
 try{
  await rm(join(f.manifest.official_templates.test_sh));
  await expect(buildBatchPackage(f.manifest)).rejects.toThrow('官方');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('task.toml 身份与批次题目目录不一致时拒绝组包',async()=>{
 const f=await fixture();
 try{
  await writeFile(join(f.task,'task.toml'),'schema_version = "1.4"\n\n[task]\nname = "work/LAW-002"\n\n[metadata]\ntask_id = "LAW-002"\n');
  await expect(buildBatchPackage(f.manifest)).rejects.toThrow('task.toml');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
