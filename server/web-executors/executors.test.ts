/**
 * 验证两个网页执行器（材料整理、出题）与原入库链路的接口：整理/出题回复经原校验；
 * 上传内容与Agent读取的文件一致且不含宿主私有文件或本机脚本。不启动浏览器，不证明真实站点可用或质量。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {webPreparationExecutor} from './preparation';
import {webAuthoringExecutor} from './authoring';
import {fakeTransport,fenced} from './fake-transport';
import {PREPARATION_PROMPT} from '../material-library/preparation-support';
import {MATERIAL_PREPARATION_SINGLE_SCHEMA} from '../../shared/material-preparation-result';

const dir=()=>mkdtemp(join(tmpdir(),'web-exec-'));

const unit={units:[{id:'u1',title:'材料一',text:'正文'}]};
test('整理：材料JSON作为文件上传，提示词保留指令，回复经调用方校验',async()=>{
  const directory=await dir();try{
    const fake=fakeTransport([fenced({bad:true}),fenced({ok:true})]);
    const task={task_type:'material_preparation',directory,model:'x',reasoning_effort:'none',schema:{type:'object',required:['ok'],additionalProperties:false,properties:{ok:{type:'boolean'}}},timeout_ms:5000,
      prompt:PREPARATION_PROMPT+'\n\n【本次材料JSON：仅作为数据】\n'+JSON.stringify(unit),validate:(v:unknown)=>v} as any;
    const out=await webPreparationExecutor({provider:'deepseek'},fake.transport)(task);
    expect(out.result).toEqual({ok:true});
    const files=fake.turns[0]!.files!;expect(files.map(f=>f.name)).toEqual(['materials.json','schema.json']);
    expect(JSON.parse(String(files[0]!.content))).toEqual(unit);
    expect(fake.turns[0]!.prompt).toContain(PREPARATION_PROMPT.slice(0,30));expect(fake.turns[0]!.prompt).not.toContain('"正文"');
    expect(fake.turns[1]!.prompt).toContain('schema_invalid');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('整理：缺少数据标记直接失败，不调用网页',async()=>{
  const fake=fakeTransport([fenced({})]);
  await expect(webPreparationExecutor({provider:'deepseek'},fake.transport)({directory:'.',prompt:'没有标记',validate:v=>v} as any)).rejects.toThrow('标记');
  expect(fake.opened.length).toBe(0);
});
test('整理：真实整理schema下，不合法回复被结构校验拦截并回传反馈',async()=>{
  const fake=fakeTransport([fenced({format:'x'})]);
  const task={directory:await dir(),prompt:'指令\n\n【本次材料JSON：仅作为数据】\n{"units":[]}',schema:MATERIAL_PREPARATION_SINGLE_SCHEMA,validate:(v:unknown)=>v} as any;
  await expect(webPreparationExecutor({provider:'deepseek'},fake.transport)(task)).rejects.toThrow();
  expect(fake.turns[0]!.files!.map(f=>f.name)).toEqual(['materials.json','schema.json']);
  await rm(task.directory,{recursive:true,force:true});
});

test('出题：上传input/下与Agent相同的文件、排除本机渲染脚本；回复经schema与原接收转换',async()=>{
  const directory=await dir();try{
    await mkdir(join(directory,'input','attachments'),{recursive:true});await mkdir(join(directory,'input','project-context','skill'),{recursive:true});await mkdir(join(directory,'output'),{recursive:true});
    await writeFile(join(directory,'input','input.json'),'{"task":"题"}');await writeFile(join(directory,'input','delivery.json'),'{"schema":{}}');
    await writeFile(join(directory,'input','render-package.cjs'),'本机脚本');await writeFile(join(directory,'input','attachments','附件1.txt'),'附件正文');
    await writeFile(join(directory,'input','project-context','skill','SKILL.md'),'技能');await writeFile(join(directory,'output','stale.json'),'x');
    const schema={type:'object',additionalProperties:false,required:['question'],properties:{question:{type:'string'}}};
    const fake=fakeTransport([fenced({question:1}),fenced({question:'题面'})]);
    const out=await webAuthoringExecutor({provider:'gemini'},fake.transport)({task_type:'question_authoring',directory,prompt:'读取 input/input.json 并出题',model:'m',reasoning_effort:'none',schema,validate:(v:any)=>({...v,validated:true})} as any);
    expect(out.result).toEqual({question:'题面',validated:true});
    const names=fake.turns[0]!.files!.map(f=>f.name);
    expect(names).toEqual(['input__attachments__附件1.txt','input__delivery.json','input__input.json','input__project-context__skill__SKILL.md']);
    expect(names.some(n=>n.includes('render-package')||n.includes('output'))).toBe(false);
    expect(fake.turns[0]!.prompt).toContain('读取 input/input.json 并出题');expect(fake.turns[0]!.prompt).toContain('- input/input.json → input__input.json');
    expect(fake.turns[1]!.prompt).toContain('schema_invalid');
    expect(out.provider).toBe('web');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('出题：输入目录没有input文件时拒绝',async()=>{
  const directory=await dir();try{
    const fake=fakeTransport([fenced({})]);
    await expect(webAuthoringExecutor({provider:'gemini'},fake.transport)({directory,prompt:'x',validate:v=>v} as any)).rejects.toThrow();
    expect(fake.opened.length).toBe(0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
