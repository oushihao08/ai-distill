/**
 * 职责：验证 BrowserSkill 传输适配器（`bsk-transport.ts`）与后端自动选择逻辑（`resolveBackend`）。
 * 边界：通过本地伪造的可执行 `bsk` 脚本模拟 CLI 协议（含多实例报错、document_changed 重试、分块上传、取消回收），不触碰真实浏览器。
 */
import {afterEach,describe,expect,test} from 'bun:test';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWebChatTransport,resolveBackend,WebAgentError} from './index';

const dirs:string[]=[];
afterEach(async()=>{
 while(dirs.length){
  const dir=dirs.pop()!;
  await rm(dir,{recursive:true,force:true});
 }
});

async function makeFakeBsk(mode:'ok'|'multi'|'empty'|'doc_change'){
 const dir=await mkdtemp(join(tmpdir(),'fake-bsk-'));
 dirs.push(dir);
 const logFile=join(dir,'calls.jsonl');
 const script=join(dir,'bsk');
 const code=`#!/usr/bin/env bun
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2).filter(a=>a!=='--json');
appendFileSync(${JSON.stringify(logFile)},JSON.stringify(args)+'\\n');
const stateFile=${JSON.stringify(join(dir,'state.json'))};
const state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{evalCount:0};
const mode=${JSON.stringify(mode)};
if(args[0]==='browsers'){
 if(mode==='empty')console.log('[]');
 else if(mode==='multi')console.log(JSON.stringify([{instance_id:'a1',browser_name:'chrome'},{instance_id:'b2',browser_name:'chrome'}]));
 else console.log(JSON.stringify([{instance_id:'inst-1',browser_name:'chrome',browser_version:'156.0'},{instance_id:'dead',browser_name:'chrome',unresponsive:true}]));
 process.exit(0);
}
if(args[0]==='session'&&args[1]==='start'){console.log(JSON.stringify({session_id:'sess-1',browser_instance_id:'inst-1'}));process.exit(0);}
if(args[0]==='session'&&args[1]==='stop'){console.log(JSON.stringify({stopped:[args[2]]}));process.exit(0);}
if(args[0]==='navigate'){console.log(JSON.stringify({ok:true,url:args[1]}));process.exit(0);}
if(args[0]==='cooperate'&&args[1]==='sync'){console.log(JSON.stringify({context_id:'ctx-1',observation_id:'obs-'+state.evalCount}));process.exit(0);}
if(args[0]==='evaluate'){
 state.evalCount++;
 writeFileSync(stateFile,JSON.stringify(state));
 if(mode==='doc_change'&&state.evalCount===1){
  console.log(JSON.stringify({code:'permission_denied',message:'frame changed',data:{effect_state:'none',reason:'document_changed'}}));
  process.exit(1);
 }
 const expr=args[args.length-1];
 let value:any=true;
 if(expr.includes('var raw=window.__waFiles'))value={ok:true,count:1};
 else if(expr.includes('beforeUsers='))value={ok:true};
 else if(expr.includes('beforeAsst='))value={ok:true,text:'\`\`\`json\\n{"ok":1}\\n\`\`\`',href:'https://chat.deepseek.com/a/chat/s/11111111-1111-1111-1111-111111111111',visOverridden:false};
 else if(expr.includes('visibilityState')&&expr.includes('composer:'))value={url:'https://chat.deepseek.com/',composer:true,login:false,challenge:false,visibility:'visible'};
 else if(expr.includes('thinking:')&&expr.includes('search:'))value={thinking:false,search:false};
 else if(expr.includes('last_user_key:')&&expr.includes('reply_sig:'))value={users:0,assistants:0,last_user_key:'',last_assistant_key:'',reply_len:0,reply_sig:'0:',generating:false,complete:false,visibility:'visible'};
 else if(expr.startsWith('(()=>{')&&expr.includes('READY='))value=[];
 console.log(JSON.stringify({ok:true,value}));
 process.exit(0);
}
process.exit(1);
`;
 await writeFile(script,code,{mode:0o755});
 await chmod(script,0o755);
 return {bin:script,logFile};
}

describe('bsk-transport 与后端选择',()=>{
 test('auto 在有可用 bsk 实例时选 bsk，空实例或指定独立 root/fake 时选 cdp',async()=>{
  const ok=await makeFakeBsk('ok');
  const empty=await makeFakeBsk('empty');
  expect(await resolveBackend('deepseek',{bskBin:ok.bin})).toBe('bsk');
  expect(await resolveBackend('deepseek',{bskBin:empty.bin})).toBe('cdp');
  expect(await resolveBackend('fake',{bskBin:ok.bin,fake_url:'http://127.0.0.1:9'})).toBe('cdp');
  expect(await resolveBackend('deepseek',{bskBin:ok.bin,root:'/tmp/custom'})).toBe('cdp');
  expect(await resolveBackend('deepseek',{bskBin:ok.bin,backend:'cdp'})).toBe('cdp');
 });

 test('多浏览器实例未指定时明确报 web_browser_unavailable，指定 instance_id 可匹配',async()=>{
  const multi=await makeFakeBsk('multi');
  const t1=createWebChatTransport({backend:'bsk',bskBin:multi.bin});
  await expect(t1.open('deepseek')).rejects.toMatchObject({reason_code:'web_browser_unavailable'} as Partial<WebAgentError>);
  const t2=createWebChatTransport({backend:'bsk',bskBin:multi.bin,bskBrowser:'b2'});
  const session=await t2.open('deepseek');
  await session.close();
 });

 test('effect_state=none 的同步失效自动重试，上传+发送+取回回复并在 close 时释放 session',async()=>{
  const {bin,logFile}=await makeFakeBsk('doc_change');
  const transport=createWebChatTransport({backend:'bsk',bskBin:bin});
  const session=await transport.open('deepseek');
  const reply=await session.ask({prompt:'请输出JSON',files:[{name:'a.txt',content:'内容A'}]},{timeout_ms:30_000});
  expect(reply.text).toContain('{"ok":1}');
  expect(reply.conversation_url).toContain('/a/chat/s/');
  await session.close();
  const calls=(await readFile(logFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
  expect(calls.some(c=>c[0]==='session'&&c[1]==='stop'&&c[2]==='sess-1')).toBe(true);
 });
});
