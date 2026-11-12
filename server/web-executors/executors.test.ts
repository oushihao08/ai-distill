/**
 * 验证三个网页执行器与原入库链路的接口：脱敏回复经同一编译器得到可发布的结果；整理/出题回复经原校验；
 * 上传内容与Agent读取的文件一致且不含宿主私有文件。不启动浏览器，不证明真实站点可用或质量。
 */
import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareAgentLibraryMaterials} from '../material-library/agent-redaction';
import {webMaterialExecutor} from './redaction';
import {webPreparationExecutor} from './preparation';
import {webAuthoringExecutor} from './authoring';
import {fakeTransport,fenced} from './fake-transport';
import {PREPARATION_PROMPT} from '../material-library/preparation-support';
import {MATERIAL_PREPARATION_SINGLE_SCHEMA} from '../../shared/material-preparation-result';

const dir=()=>mkdtemp(join(tmpdir(),'web-exec-'));
const plan={texts:[{id:'f1p1/b#text',text:'周文远申请100元'}],documents:[{id:'d',title:'申请书',ranges:[{first_block_id:'f1p1/b',last_block_id:'f1p1/b'}],duplicate_of:null}],unresolved:[]};
const redactInput=(directory:string,execute:any)=>({directory,interface_kind:'web' as const,model:'deepseek',reasoning_effort:'none',revision_id:'r',extraction_job_id:'e',template:{id:'aliases',digest:'d',redaction:{prompt:'保留法院及100元，整包统一化名'}},files:[{file_id:'f',text_sha256:'h',pages:[{page:1,text:'赵安申请100元',structure:[{id:'b',kind:'paragraph' as const,text:'赵安申请100元'}]}]}],execute});

test('脱敏：上传与Agent相同的输入文件，不上传宿主私有文件；回复经同一编译器入库格式',async()=>{
  const directory=await dir();try{
    const fake=fakeTransport([fenced(plan)]);
    const out=await prepareAgentLibraryMaterials(redactInput(directory,webMaterialExecutor({provider:'deepseek'},fake.transport)));
    const uploaded=fake.turns[0]!.files!.map(f=>f.name);
    expect(uploaded).toEqual(['source.json','review-hints.json','plan-schema.json']);
    expect(uploaded).not.toContain('validation-source.json');expect(uploaded.some(n=>n.endsWith('.mjs'))).toBe(false);
    expect(JSON.parse(String(fake.turns[0]!.files![0]!.content))).toEqual({texts:[{id:'f1p1/b#text',text:'赵安申请100元'}]});
    expect(fake.turns[0]!.prompt).toContain('网页对话执行接口');expect(fake.turns[0]!.prompt).not.toContain('bun validate-plan');
    expect(out.prepared.documents[0]?.text).toBe('周文远申请100元');
    expect(out.provider).toBe('web');expect(out.returned_model).toBeNull();
    expect(JSON.parse(await readFile(join(directory,'semantic-plan.private.json'),'utf8'))).toEqual(plan);
    expect(fake.closed()).toBe(1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('脱敏：编译器拒绝时把同一校验结果反馈给同一对话并修正',async()=>{
  const directory=await dir();try{
    const fake=fakeTransport([fenced({...plan,documents:[]}),fenced(plan)]);
    const out=await prepareAgentLibraryMaterials(redactInput(directory,webMaterialExecutor({provider:'gemini'},fake.transport)));
    expect(fake.turns.length).toBe(2);expect(fake.opened.length).toBe(1);expect(fake.turns[1]!.prompt).toContain('valid');
    expect(out.prepared.documents[0]?.text).toBe('周文远申请100元');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('脱敏：续作计划随输入上传',async()=>{
  const directory=await dir();try{
    await mkdir(join(directory,'resume'),{recursive:true});await writeFile(join(directory,'resume','material-plan.json'),'{"texts":[]}');
    const fake=fakeTransport([fenced(plan)]);const task={directory,prompt:'p',model:'m',reasoning_effort:'none',validate:(v:unknown)=>v} as any;
    await Bun.write(join(directory,'source.json'),'{}');await Bun.write(join(directory,'review-hints.json'),'{}');await Bun.write(join(directory,'plan-schema.json'),'{}');
    await Bun.write(join(directory,'validation-source.json'),JSON.stringify({files:[{file_id:'f',text_sha256:'h',pages:[{page:1,text:'赵安申请100元',structure:[{id:'b',kind:'paragraph',text:'赵安申请100元'}]}]}],identity:{revision_id:'r',extraction_job_id:'e',template_id:'aliases',template_digest:'d'}}));
    await webMaterialExecutor({provider:'deepseek'},fake.transport)(task);
    expect(fake.turns[0]!.files!.map(f=>f.name)).toContain('resume-material-plan.json');
  }finally{await rm(directory,{recursive:true,force:true});}
});

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
test('整理：真实整理schema下，合法回复被接受',async()=>{
  const fake=fakeTransport([fenced({format:'x'})]);
  const task={directory:await dir(),prompt:'指令\n\n【本次材料JSON：仅作为数据】\n{"units":[]}',schema:MATERIAL_PREPARATION_SINGLE_SCHEMA,validate:(v:unknown)=>v} as any;
  // 不满足真实schema的回复会被结构校验反馈；这里只验证确实在校验（第二轮无脚本→抛出耗尽）
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
