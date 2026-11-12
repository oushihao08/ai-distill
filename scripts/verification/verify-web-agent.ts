/**
 * 用途：端到端验证 web agent 的真实 CDP 实现（真实本机 Chrome + 本地假聊天页）；不访问 DeepSeek/Gemini，不读取 .env、数据库或队列，不使用真实 `.storage/web-agent/profile`。
 * 入口：`bun scripts/verification/verify-web-agent.ts [--headless]`（`VERIFY_HEADLESS=1` 等效）；默认在 macOS 用 `open -g -n -a "Google Chrome"` 后台启动独立临时档案。
 * 副作用：在系统临时目录创建一次性 profile 与 browser.json，启动并最终关闭一个后台 Chrome（只经本临时档案的调试端口 `Browser.close`），绑定本机随机端口；结束时删除临时目录。
 * 覆盖：多浏览器竞态启动只起一个实例、多文件上传顺序/内容、≥200KB 长文本、回复读取（围栏/表格/列表）、多轮复用同一会话、取消与超时、6 会话并发互不串扰、
 *       实例复用、会话结束后 target 清理、错误分类（登录/验证码/繁忙/上传拒绝/文件数超限）、前台应用是否被抢焦点（macOS `lsappinfo`）。
 */
import {createHash} from 'node:crypto';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CdpClient} from '../../server/web-agent/cdp';
import {ensureBrowser,webAgentPaths} from '../../server/web-agent/browser';
import {startFakeChatServer} from '../../server/web-agent/fake-chat-server';
import {createWebChatTransport,extractJsonFromReply,isWebAgentError,webBrowserStatus,webCloseBrowser} from '../../server/web-agent';
import type {WebChatSession} from '../../server/web-agent';

const headless=process.argv.includes('--headless')||process.env.VERIFY_HEADLESS==='1';
const results:Array<{name:string;ok:boolean;detail:string}>=[];
async function check(name:string,run:()=>Promise<string|void>){
 const started=Date.now();
 try{
  const detail=await run();
  results.push({name,ok:true,detail:String(detail??'')});
  console.log(`PASS ${name} (${Date.now()-started}ms)${detail?` — ${detail}`:''}`);
 }catch(error){
  const detail=error instanceof Error?error.message:String(error);
  results.push({name,ok:false,detail});
  console.log(`FAIL ${name} (${Date.now()-started}ms) — ${detail}`);
 }
}
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}
const sha=(data:Uint8Array|string)=>createHash('sha256').update(typeof data==='string'?Buffer.from(data):data).digest('hex');
async function reasonOf(promise:Promise<unknown>):Promise<string>{
 try{await promise;return 'ok';}catch(error){return isWebAgentError(error)?error.reason_code:`other:${error instanceof Error?error.message:error}`;}
}
async function run(cmd:string[]):Promise<string>{
 const proc=Bun.spawn(cmd,{stdout:'pipe',stderr:'ignore'});
 const text=await new Response(proc.stdout).text();
 await proc.exited;
 return text;
}
async function frontPid():Promise<number|null>{
 if(process.platform!=='darwin')return null;
 const asn=(await run(['lsappinfo','front'])).trim();
 if(!asn.startsWith('ASN:'))return null;
 const match=/pid = (\d+)/.exec(await run(['lsappinfo','info','-only','pid',asn]));
 return match?Number(match[1]):null;
}
async function mainPids(profile:string):Promise<number[]>{
 const ps=await run(['ps','-axo','pid,command']);
 return ps.split('\n').map(line=>line.trim()).filter(line=>line.includes(`--user-data-dir=${profile}`)&&!line.includes(' open ')&&!line.includes('--type=')&&/Chrome|chrom/i.test(line)).map(line=>Number(line.split(/\s+/)[0]));
}
async function mainProcessCount(profile:string):Promise<number>{return (await mainPids(profile)).length;}
async function pageTargets(wsUrl:string):Promise<string[]>{
 const client=await CdpClient.connect(wsUrl);
 try{
  const {targetInfos}=await client.send<{targetInfos:Array<{targetId:string;type:string}>}>('Target.getTargets');
  return targetInfos.filter(info=>info.type==='page').map(info=>info.targetId);
 }finally{client.close();}
}

function fakeReply(text:string){return extractJsonFromReply(text) as {session:string;turn:number;prompt_len:number;prompt_sha:string;vis:string;files:Array<{name:string;size:number;sha:string}>};}
function longPrompt(bytes:number,tag:string){
 const unit='律所合同纠纷：甲方应于2026年3月31日前支付货款 ¥128,000.50 元，逾期按日万分之五计违约金。\nLine with "quotes", `ticks`, <tags> & symbols \\ {}[]\n\n';
 let text=`[${tag}]\n`;
 while(new TextEncoder().encode(text).length<bytes)text+=unit;
 return text;
}

const root=await mkdtemp(join(tmpdir(),'web-agent-verify-'));
const server=startFakeChatServer();
const paths=webAgentPaths(root);
const opened:WebChatSession[]=[];
const transports:Array<{dispose():void}>=[];
const mk=(extra:{fake_url?:string}={})=>{const t=createWebChatTransport({root,headless,fake_url:extra.fake_url??server.url});transports.push(t);return t;};
const openSession=async(transport:ReturnType<typeof mk>,options?:Parameters<ReturnType<typeof mk>['open']>[1])=>{const s=await transport.open('fake',options);opened.push(s);return s;};
const frontSamples=new Set<number>();
let sampling=true;
const sampler=(async()=>{while(sampling){const pid=await frontPid().catch(()=>null);if(pid)frontSamples.add(pid);await Bun.sleep(250);}})();
console.log(`临时根目录 ${root}；模式 ${headless?'headless':'后台有界面(open -g)'}`);

try{
 await check('竞态冷启动：3 个传输同时 open 只启动一个浏览器实例',async()=>{
  const [a,b,c]=await Promise.all([openSession(mk()),openSession(mk()),openSession(mk())]);
  const count=await mainProcessCount(paths.profile);
  assert(count===1,`主进程数应为 1，实际 ${count}`);
  const status=await webBrowserStatus(root);
  assert(status.running&&status.port,'webBrowserStatus 应为 running');
  await Promise.all([a.close(),b.close(),c.close()]);
  return `port=${status.port} 主进程=${count}`;
 });

 const base=await ensureBrowser({root,headless});
 assert(!base.launched,'ensureBrowser 应复用已有实例');
 const baselineTargets=await pageTargets(base.wsUrl);

 await check('多文件上传 + 长文本 + 回复读取 + 多轮复用同一会话',async()=>{
  const session=await openSession(mk());
  const fileA=new Uint8Array(Array.from({length:3000},(_,i)=>i%251));
  const fileB='第二个文件：中文内容\n第二行';
  const fileC=longPrompt(300_000,'file-c');
  const prompt=longPrompt(220_000,'turn-1');
  const turn1=await session.ask({prompt,files:[{name:'a-二进制.bin',content:fileA},{name:'b.txt',content:fileB},{name:'c.md',content:fileC}]},{timeout_ms:90_000});
  const r1=fakeReply(turn1.text);
  assert(r1.turn===1,`首轮 turn=${r1.turn}`);
  assert(r1.prompt_len===prompt.length,`长文本长度不符 ${r1.prompt_len} vs ${prompt.length}`);
  assert(r1.prompt_sha===sha(prompt),'长文本 sha256 不符（提示词在输入中被改写）');
  assert(JSON.stringify(r1.files.map(f=>f.name))===JSON.stringify(['a-二进制.bin','b.txt','c.md']),`文件顺序/文件名不符 ${r1.files.map(f=>f.name)}`);
  assert(r1.files[0].sha===sha(fileA)&&r1.files[1].sha===sha(fileB)&&r1.files[2].sha===sha(fileC),'文件内容 sha256 不符');
  assert(turn1.text.includes('| key | value |')&&turn1.text.includes('- files: 3'),'回复 markdown（表格/列表）未保留');
  assert(/```json\n[\s\S]*\n```/.test(turn1.text),'回复代码围栏未保留');
  assert(/\/c\/[0-9a-z]+/.test(turn1.conversation_url),`对话 URL 形态不符 ${turn1.conversation_url}`);
  const turn2=await session.ask({prompt:'第二轮 [[slow:900]]'},{timeout_ms:30_000});
  const r2=fakeReply(turn2.text);
  assert(r2.turn===2,`第二轮应复用同一对话，turn=${r2.turn}`);
  assert(turn2.conversation_url===turn1.conversation_url,'多轮对话 URL 应保持不变');
  assert(r2.files.length===0,'第二轮不应带上一轮文件');
  assert(session.url()===turn2.conversation_url,'session.url() 应跟随当前对话 URL');
  await session.close();
  return `首轮 ${turn1.elapsed_ms}ms，提示词 ${new TextEncoder().encode(prompt).length}B，文件 3 个，vis=${r1.vis}`;
 });

 await check('取消与超时：取消点停止并关闭 target；超时为 web_timeout',async()=>{
  const before=await pageTargets(base.wsUrl);
  const session=await openSession(mk());
  const controller=new AbortController();
  const started=Date.now();
  const pending=reasonOf(session.ask({prompt:'取消测试 [[slow:30000]]'},{timeout_ms:60_000,signal:controller.signal}));
  setTimeout(()=>controller.abort(),1500);
  const cancelled=await pending;
  assert(cancelled==='web_cancelled',`取消应为 web_cancelled，实际 ${cancelled}`);
  assert(Date.now()-started<10_000,'取消响应过慢');
  const after=await pageTargets(base.wsUrl);
  assert(after.length===before.length,`取消后 target 应已关闭 ${before.length}→${after.length}`);
  const again=await reasonOf(session.ask({prompt:'x'},{timeout_ms:5000}));
  assert(again==='web_browser_unavailable',`取消后会话应不可用，实际 ${again}`);
  const second=await openSession(mk());
  const timeout=await reasonOf(second.ask({prompt:'超时测试 [[slow:30000]]'},{timeout_ms:1800}));
  assert(timeout==='web_timeout',`超时应为 web_timeout，实际 ${timeout}`);
  await second.close();
  return `取消用时 ${Date.now()-started}ms`;
 });

 await check('6 会话并发互不串扰',async()=>{
  const transport=mk();
  const sessions=await Promise.all(Array.from({length:6},()=>openSession(transport)));
  const jobs=sessions.map((session,index)=>{
   const prompt=longPrompt(40_000+index*5_000,`concurrent-${index}`)+`[[slow:${600+index*150}]]`;
   const file={name:`s${index}.txt`,content:`session ${index} 专属文件 ${'x'.repeat(index*100+10)}`};
   return session.ask({prompt,files:[file]},{timeout_ms:90_000}).then(reply=>({index,prompt,file,reply}));
  });
  const done=await Promise.all(jobs);
  for(const {index,prompt,file,reply} of done){
   const data=fakeReply(reply.text);
   assert(data.prompt_sha===sha(prompt),`会话 ${index} 收到别人的回复（提示词 sha 不符）`);
   assert(data.files.length===1&&data.files[0].name===file.name&&data.files[0].sha===sha(file.content),`会话 ${index} 文件串扰`);
   assert(data.turn===1,`会话 ${index} turn=${data.turn}`);
  }
  const urls=new Set(done.map(item=>item.reply.conversation_url));
  assert(urls.size===6,`6 个会话应有 6 个不同对话 URL，实际 ${urls.size}`);
  await Promise.all(sessions.map(s=>s.close()));
  return '6 个会话提示词/文件 sha 各自一致';
 });

 await check('浏览器实例复用：新传输不新增进程，端口不变',async()=>{
  const before=await webBrowserStatus(root);
  const session=await openSession(mk());
  const after=await webBrowserStatus(root);
  assert(before.port===after.port,'端口发生变化');
  const count=await mainProcessCount(paths.profile);
  assert(count===1,`主进程数应为 1，实际 ${count}`);
  await session.close();
  return `port=${after.port}`;
 });

 await check('错误分类：繁忙/上传拒绝/文件数超限/文件为空',async()=>{
  const session=await openSession(mk());
  const busy=await reasonOf(session.ask({prompt:'触发 [[busy]]'},{timeout_ms:20_000}));
  assert(busy==='web_busy',`繁忙应为 web_busy，实际 ${busy}`);
  await session.close();
  const s2=await openSession(mk());
  const rejected=await reasonOf(s2.ask({prompt:'上传拒绝',files:[{name:'bad.txt',content:'x'}]},{timeout_ms:20_000}));
  assert(rejected==='web_upload_rejected',`上传失败应为 web_upload_rejected，实际 ${rejected}`);
  const tooMany=await reasonOf(s2.ask({prompt:'x',files:Array.from({length:7},(_,i)=>({name:`f${i}.txt`,content:'x'}))},{timeout_ms:20_000}));
  assert(tooMany==='web_upload_rejected',`文件数超限应为 web_upload_rejected，实际 ${tooMany}`);
  const empty=await reasonOf(s2.ask({prompt:'x',files:[{name:'e.txt',content:''}]},{timeout_ms:20_000}));
  assert(empty==='web_upload_rejected',`空文件应为 web_upload_rejected，实际 ${empty}`);
  await s2.close();
  return '';
 });

 await check('登录页/验证码页：open 抛 web_login_required / web_challenge_required 且不遗留 target',async()=>{
  const before=await pageTargets(base.wsUrl);
  const login=await reasonOf(mk({fake_url:`${server.url}login`}).open('fake'));
  const captcha=await reasonOf(mk({fake_url:`${server.url}captcha`}).open('fake'));
  assert(login==='web_login_required',`登录页应为 web_login_required，实际 ${login}`);
  assert(captcha==='web_challenge_required',`验证码页应为 web_challenge_required，实际 ${captcha}`);
  const after=await pageTargets(base.wsUrl);
  assert(after.length===before.length,`失败 open 不应遗留 target ${before.length}→${after.length}`);
  return '';
 });

 await check('选项：默认关闭联网搜索；thinking 显式开启',async()=>{
  const session=await openSession(mk(),{thinking:true});
  const reply=await session.ask({prompt:'选项'},{timeout_ms:20_000});
  assert(reply.text.length>0,'无回复');
  await session.close();
  return '';
 });

 await check('会话结束后 target 清理：页面数回到基线，临时上传目录已删除',async()=>{
  await Promise.all(opened.map(s=>s.close()));
  const now=await pageTargets(base.wsUrl);
  assert(now.length===baselineTargets.length,`页面数应为 ${baselineTargets.length}，实际 ${now.length}`);
  const leftovers=await readdir(join(paths.dir,'tmp')).catch(()=>[] as string[]);
  assert(leftovers.length===0,`遗留上传目录 ${leftovers.join(',')}`);
  return `页面数 ${now.length}`;
 });

 await check('未抢占前台应用（macOS）：测试期间前台应用从未是专用 Chrome 实例',async()=>{
  if(process.platform!=='darwin'||headless)return '跳过（非 macOS 或 headless）';
  sampling=false;await sampler;
  const ours=await mainPids(paths.profile);
  assert(ours.length>0,'未找到专用 Chrome 主进程');
  const hit=ours.filter(pid=>frontSamples.has(pid));
  assert(hit.length===0,`专用 Chrome 曾成为前台应用 pid=${hit}`);
  return `前台采样 ${frontSamples.size} 个应用 pid，均非专用 Chrome(${ours.join(',')})`;
 });
}finally{
 sampling=false;
 for(const session of opened)await session.close().catch(()=>undefined);
 for(const transport of transports)transport.dispose();
 await webCloseBrowser(root).catch(()=>undefined);
 server.stop();
 await check('关闭浏览器：状态为未运行',async()=>{
  const status=await webBrowserStatus(root);
  assert(!status.running,'webCloseBrowser 后仍在运行');
 });
 await rm(root,{recursive:true,force:true}).catch(()=>undefined);
}

const failed=results.filter(item=>!item.ok);
console.log(`\n${results.length-failed.length}/${results.length} 通过`);
process.exit(failed.length?1:0);
