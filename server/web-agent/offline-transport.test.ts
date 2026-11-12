/** 验证离线作业台传输（offline-transport）：缺回复时导出zip并以 web_offline_pending 结束、交回后按轮次回放、修正轮确定性、提示词变化作废旧回复、交回预检；只用临时目录，不启动浏览器、不连接数据库。 */
import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOfflineChatTransport,importOfflineReply,readOfflineTask} from './offline-transport';
import {runWebJsonChat} from '../web-executors/chat-loop';
import {expandSparsePlanTexts} from '../web-executors/redaction';
import {validateWebAgentSettings} from '../../shared/web-agent';

const TASK='prepare-11111111-1111-4111-8111-111111111111';
const listZip=(zip:string)=>new TextDecoder().decode(Bun.spawnSync(['unzip','-Z1',zip]).stdout).split('\n').filter(Boolean);

test('offline settings require a task key and reject other modes',()=>{
  expect(validateWebAgentSettings({provider:'deepseek',mode:'offline',task:TASK})).toEqual({provider:'deepseek',mode:'offline',task:TASK});
  expect(()=>validateWebAgentSettings({provider:'deepseek',mode:'offline'})).toThrow('task');
  expect(()=>validateWebAgentSettings({provider:'deepseek',task:TASK})).toThrow('task');
  expect(()=>validateWebAgentSettings({provider:'deepseek',mode:'manual'})).toThrow('offline');
  expect(()=>validateWebAgentSettings({provider:'deepseek',mode:'offline',task:'x-1'})).toThrow('任务键');
});

test('export → pending, invalid reply → round-2 export, valid reply → replay succeeds; prompt change discards old replies',async()=>{
  const root=mkdtempSync(join(tmpdir(),'web-offline-'));
  try{
    const run=(prompt='请整理')=>runWebJsonChat({
      transport:createOfflineChatTransport({task:TASK,root}),settings:{provider:'deepseek',mode:'offline',task:TASK},timeout_ms:5000,label:'material_preparation',
      first:{prompt,files:[{name:'materials.json',content:'{"units":[]}'}]},
      check:value=>{if((value as any).ok!==true)throw Object.assign(new Error('bad'),{reason_code:'result_invalid'});return value;},
    });
    await expect(run()).rejects.toMatchObject({reason_code:'web_offline_pending'});
    let state=await readOfflineTask(TASK,{root});
    expect(state).toMatchObject({status:'exported',round:1,label:'material_preparation'});
    expect(listZip(state!.zip_path!)).toEqual(expect.arrayContaining(['prompt.md','files/materials.json','README.md','task.json','reply/HOW-TO-RETURN.txt']));
    await expect(importOfflineReply(TASK,1,'好的',{root})).rejects.toThrow();
    await importOfflineReply(TASK,1,'```json\n{"ok":false}\n```',{root});
    await expect(run()).rejects.toMatchObject({reason_code:'web_offline_pending'});
    state=await readOfflineTask(TASK,{root});
    expect(state).toMatchObject({status:'exported',round:2});
    const zip2=listZip(state!.zip_path!);
    expect(zip2).toEqual(expect.arrayContaining(['history/round-1-prompt.md','history/round-1-reply.md']));
    expect(readFileSync(join(root,'web-offline',TASK,'round-2','prompt.md'),'utf8')).toContain('result_invalid');
    await importOfflineReply(TASK,2,'```json\n{"ok":true}\n```',{root});
    expect((await run()).value).toEqual({ok:true});
    expect((await readOfflineTask(TASK,{root}))!.status).toBe('imported');
    // 提示词变化：旧轮次作废并重新导出第1轮
    await expect(run('请整理（规则已更新）')).rejects.toMatchObject({reason_code:'web_offline_pending'});
    expect(await readOfflineTask(TASK,{root})).toMatchObject({status:'exported',round:1});
    expect(existsSync(join(root,'web-offline',TASK,'round-2'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('sparse redaction plan is expanded by exact id in source order, unknown ids pass through for the compiler',()=>{
  const source={texts:[{id:'a#text',text:'周某'},{id:'b#text',text:'金额10元'},{id:'c#text',text:'王某'}]};
  const plan=expandSparsePlanTexts({texts:[{id:'c#text',text:'李某'},{id:'zz#text',text:'x'}],documents:[],unresolved:[]},source);
  expect(plan.texts).toEqual([{id:'a#text',text:'周某'},{id:'b#text',text:'金额10元'},{id:'c#text',text:'李某'},{id:'zz#text',text:'x'}]);
  expect(expandSparsePlanTexts({invalid:true},source)).toEqual({invalid:true});
});
