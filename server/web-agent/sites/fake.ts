/**
 * 职责：本地假聊天页的适配器与页面 HTML，仅用于自动化测试 `provider:'fake'`（不访问任何真实站点）。
 * 公开入口：`fakeAdapter(url)`、`fakeChatPageHtml()`；`fake-chat-server.ts` 用 `Bun.serve` 提供该页面，测试/验证脚本通过 `fake_url` 注入。
 * 页面行为（由提示词指令控制）：`[[slow:N]]` 生成 N ms；文件名以 `bad` 开头则上传失败；`[[busy]]` 以助手消息显示“服务器繁忙”；`[[incomplete]]` 回复结束但不标记完成（用于测试无完成信号时的稳定等待）。
 * 回复含 session 标记、轮次、提示词长度与 sha256、文件名/大小/sha256，用于验证多文件、长文本、多会话互不串扰。
 */
import {DOM_MARKDOWN_FN} from './dom-markdown';
import {jsArg,type WebSiteAdapter} from './types';

export function fakeAdapter(baseUrl:string):WebSiteAdapter{
 return {
  provider:'fake',
  label:'Fake',
  startUrl:baseUrl,
  conversationUrl:/\/c\/[0-9a-z-]+/,
  max_files:6,
  max_file_bytes:50*1024*1024,
  supports:{thinking:true,search_toggle:true,model:false},
  upload:{mode:'input',selector:'#file'},
  pageState:String.raw`(()=>({url:location.href,composer:!!document.querySelector('#composer'),login:!!document.querySelector('input[type=password]'),challenge:!!document.querySelector('#captcha'),text:document.querySelector('#composer')?'':(document.body.innerText||'').slice(0,500),visibility:document.visibilityState}))()`,
  notice:String.raw`(()=>[].slice.call(document.querySelectorAll('#toast,[role=alert]')).map(function(e){return (e.innerText||'').trim();}).filter(Boolean).join(' | '))()`,
  options:String.raw`(()=>({thinking:document.querySelector('#think')?document.querySelector('#think').getAttribute('aria-pressed')==='true':null,search:document.querySelector('#search')?document.querySelector('#search').getAttribute('aria-pressed')==='true':null}))()`,
  setOption:(kind,on)=>String.raw`((on)=>{var el=document.querySelector(${jsArg(kind==='thinking'?'#think':'#search')});if(!el)return false;if((el.getAttribute('aria-pressed')==='true')!==on)el.click();return true;})(${jsArg(on)})`,
  composerFocus:String.raw`(()=>{var t=document.querySelector('#composer');if(!t)return false;t.focus();t.select();return true;})()`,
  composerLength:String.raw`(()=>{var t=document.querySelector('#composer');return t?t.value.replace(/\s+/g,'').length:-1;})()`,
  composerFallback:text=>String.raw`((text)=>{var el=document.querySelector('#composer');if(!el)return -1;var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));return el.value.replace(/\s+/g,'').length;})(${jsArg(text)})`,
  composerFromExpr:expr=>String.raw`((text)=>{var el=document.querySelector('#composer');if(!el)return -1;var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));return el.value.replace(/\s+/g,'').length;})(${expr})`,
  attachments:String.raw`(()=>[].slice.call(document.querySelectorAll('#chips .chip')).map(function(c){return {name:c.getAttribute('data-name')||'',state:c.getAttribute('data-state')||'uploading',text:c.innerText};}))()`,
  sendReady:String.raw`(()=>{var b=document.querySelector('#send');return !!b&&!b.disabled;})()`,
  send:String.raw`(()=>{var b=document.querySelector('#send');if(!b||b.disabled)return false;b.click();return true;})()`,
  chatState:String.raw`(()=>{
   var us=[].slice.call(document.querySelectorAll('#log .msg.user')),as=[].slice.call(document.querySelectorAll('#log .msg.assistant'));
   var last=as[as.length-1]||null,txt=last?(last.querySelector('.md').textContent||''):'';
   var stop=document.querySelector('#stop');
   return {users:us.length,assistants:as.length,last_user_key:us.length?us[us.length-1].id:'',last_assistant_key:last?last.id:'',
    reply_len:txt.length,reply_sig:txt.length+':'+txt.slice(-48),
    generating:!!stop&&!stop.hidden,complete:!!last&&last.getAttribute('data-complete')==='1',visibility:document.visibilityState};
  })()`,
  lastReply:String.raw`(()=>{
   ${DOM_MARKDOWN_FN}
   var as=[].slice.call(document.querySelectorAll('#log .msg.assistant')),last=as[as.length-1];
   return last?__waMarkdown(last.querySelector('.md')):'';
  })()`,
  stop:String.raw`(()=>{var b=document.querySelector('#stop');if(!b||b.hidden)return false;b.click();return true;})()`,
 };
}

export function fakeChatPageHtml():string{
 return String.raw`<!doctype html><html><head><meta charset="utf-8"><title>fake chat</title>
<style>body{font:14px sans-serif;margin:0}#log{padding:8px;max-height:60vh;overflow:auto}.msg{margin:6px 0;padding:6px;border:1px solid #ddd}.chip{display:inline-block;margin:2px;padding:2px 6px;border:1px solid #888}.chip[data-state=failed]{border-color:red}</style></head>
<body>
<div id="log"></div>
<div id="chips"></div>
<div id="toast" role="status"></div>
<textarea id="composer" rows="3" style="width:90%"></textarea>
<input id="file" type="file" multiple>
<button id="think" aria-pressed="false">DeepThink</button><button id="search" aria-pressed="true">Search</button>
<button id="send" disabled>send</button><button id="stop" hidden>stop</button>
<div id="vis"></div>
<script>
(function(){
 var params=new URLSearchParams(location.search),session=params.get('s')||'anon',convId=null,turn=0,files=[],generating=false,stopFlag=false;
 var $=function(s){return document.querySelector(s);};
 function setVis(){$('#vis').textContent=document.visibilityState;}
 document.addEventListener('visibilitychange',setVis);setVis();
 $('#think').onclick=function(){this.setAttribute('aria-pressed',String(this.getAttribute('aria-pressed')!=='true'));};
 $('#search').onclick=function(){this.setAttribute('aria-pressed',String(this.getAttribute('aria-pressed')!=='true'));};
 function refresh(){$('#send').disabled=generating||!($('#composer').value.trim().length)||files.some(function(f){return f.state!=='ready';});}
 $('#composer').addEventListener('input',refresh);
 function sha(buf){return crypto.subtle.digest('SHA-256',buf).then(function(d){return Array.from(new Uint8Array(d)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');});}
 $('#file').addEventListener('change',function(){
  var list=Array.from(this.files);this.value='';
  list.forEach(function(f){
   var chip=document.createElement('div');chip.className='chip';chip.setAttribute('data-name',f.name);chip.setAttribute('data-state','uploading');chip.textContent=f.name+' Uploading...';
   $('#chips').appendChild(chip);
   var rec={name:f.name,state:'uploading',file:f,chip:chip};files.push(rec);refresh();
   f.arrayBuffer().then(function(buf){return sha(buf).then(function(h){rec.size=buf.byteLength;rec.sha=h;});}).then(function(){
    return new Promise(function(r){setTimeout(r,150+Math.random()*250);});
   }).then(function(){
    var reject=/^bad/.test(f.name);
    rec.state=reject?'failed':'ready';chip.setAttribute('data-state',rec.state);chip.textContent=f.name+(reject?' No text extracted':' TXT '+rec.size+'B');refresh();
   });
  });
 });
 function add(cls,html){var d=document.createElement('div');d.className='msg '+cls;d.id=cls+'-'+(++turnId);var md=document.createElement('div');md.className='md';d.appendChild(md);$('#log').appendChild(d);return d;}
 var turnId=0;
 $('#send').onclick=async function(){
  if(this.disabled)return;
  var prompt=$('#composer').value,used=files.slice();
  var u=add('user','');u.querySelector('.md').textContent=prompt.slice(0,80);
  $('#composer').value='';files=[];$('#chips').textContent='';
  generating=true;stopFlag=false;refresh();$('#stop').hidden=false;
  if(!convId){convId=Math.random().toString(36).slice(2,10);history.replaceState(null,'','/c/'+convId+location.search);}
  turn++;
  var enc=new TextEncoder().encode(prompt),ph=await sha(enc);
  var a=add('assistant','');a.setAttribute('data-complete','0');
  var md=a.querySelector('.md');
  var slow=/\[\[slow:(\d+)\]\]/.exec(prompt);var total=slow?Number(slow[1]):400;
  var info={session:session,turn:turn,prompt_len:prompt.length,prompt_sha:ph,vis:document.visibilityState,files:used.map(function(f){return {name:f.name,size:f.size,sha:f.sha};})};
  var parts=[];
  if(prompt.indexOf('[[busy]]')>=0){parts=['服务器繁忙，请稍后再试。'];}
  else{
   parts.push('SESSION '+session+' TURN '+turn+'\n\n');
   parts.push('- files: '+used.length+'\n- prompt_len: '+prompt.length+'\n\n');
   parts.push('| key | value |\n| --- | --- |\n| session | '+session+' |\n| turn | '+turn+' |\n\n');
   parts.push('\u0060\u0060\u0060json\n'+JSON.stringify(info)+(prompt.indexOf('[[incomplete]]')>=0?'':'\n\u0060\u0060\u0060')+'\n');
  }
  var steps=Math.max(parts.length,Math.ceil(total/40));
  var buf='';
  function render(){
   // 极简 markdown→DOM：围栏、表格、列表、段落
   while(md.firstChild)md.removeChild(md.firstChild);
   var lines=buf.split('\n'),i=0;
   while(i<lines.length){
    var ln=lines[i];
    if(ln.indexOf('\u0060\u0060\u0060')===0){var lang=ln.slice(3).trim(),body=[];i++;while(i<lines.length&&lines[i].indexOf('\u0060\u0060\u0060')!==0){body.push(lines[i]);i++;}i++;var pre=document.createElement('pre'),code=document.createElement('code');if(lang)code.className='language-'+lang;code.textContent=body.join('\n');pre.appendChild(code);md.appendChild(pre);continue;}
    if(ln.indexOf('|')===0){var rows=[];while(i<lines.length&&lines[i].indexOf('|')===0){rows.push(lines[i]);i++;}var t=document.createElement('table');rows.filter(function(r){return !/^\|\s*-/.test(r);}).forEach(function(r){var tr=document.createElement('tr');r.split('|').slice(1,-1).forEach(function(c){var td=document.createElement('td');td.textContent=c.trim();tr.appendChild(td);});t.appendChild(tr);});md.appendChild(t);continue;}
    if(ln.indexOf('- ')===0){var ul=document.createElement('ul');while(i<lines.length&&lines[i].indexOf('- ')===0){var li=document.createElement('li');li.textContent=lines[i].slice(2);ul.appendChild(li);i++;}md.appendChild(ul);continue;}
    if(ln.trim()){var p=document.createElement('p');p.textContent=ln;md.appendChild(p);}
    i++;
   }
  }
  for(var k=0;k<steps&&!stopFlag;k++){
   if(k<parts.length)buf+=parts[k];
   render();
   await new Promise(function(r){setTimeout(r,Math.max(10,total/steps));});
  }
  if(stopFlag){buf+='\n(stopped)';render();}
  if(prompt.indexOf('[[incomplete]]')<0||stopFlag)a.setAttribute('data-complete','1');
  generating=false;$('#stop').hidden=true;
  refresh();
 };
 $('#stop').onclick=function(){stopFlag=true;};
})();
</script></body></html>`;
}
