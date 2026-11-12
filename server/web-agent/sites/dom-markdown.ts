/**
 * 职责：提供在页面内执行的「DOM → Markdown 纯文本」函数源码，保留标题、列表、表格、引用及代码围栏（```lang）语义。
 * 公开入口：`DOM_MARKDOWN_FN`（函数声明源码，定义 `__waMarkdown(root)`），由各站点表达式内嵌；既可经 CDP `Runtime.evaluate` 执行，也可经 `bsk evaluate` 复核。
 * 约束：只读 DOM，不依赖站点类名之外的全局；代码块文本取 `textContent`（保持换行/缩进），按块内最长反引号串自动加长围栏。
 * 站点特有的代码块容器（DeepSeek `.md-code-block`、Gemini `code-block`）及需忽略的控件在此统一识别。
 */
export const DOM_MARKDOWN_FN=String.raw`
function __waMarkdown(root){
 var SKIP=/^(SCRIPT|STYLE|SVG|NOSCRIPT|BUTTON|MAT-ICON|GEM-ICON|GEM-ICON-BUTTON|SOURCES-LIST|THINKING-OVERLAY)$/i;
 function skipNode(n){
  if(SKIP.test(n.tagName))return true;
  var c=n.classList;
  if(!c)return false;
  return c.contains('md-code-block-banner-wrap')||c.contains('code-block-decoration')||c.contains('cdk-visually-hidden')||c.contains('ds-think-content')||c.contains('citation-chip');
 }
 function fence(code,lang){
  var longest=0,m=code.match(/\x60+/g);
  if(m)m.forEach(function(s){if(s.length>longest)longest=s.length;});
  var f=new Array(Math.max(3,longest+1)+1).join('\x60');
  return f+(lang||'')+'\n'+code.replace(/\n+$/,'')+'\n'+f;
 }
 function langOf(el){
  var banner=el.querySelector('.md-code-block-infostring,.md-code-block-banner span,.code-block-decoration span');
  var t=banner?(banner.textContent||'').trim():'';
  if(t&&t.length<=24&&!/\s/.test(t)&&!/^(copy|download)$/i.test(t))return t.toLowerCase();
  var code=el.querySelector('code');
  var cls=code?code.className:'';
  var mm=/language-([\w+#-]+)/.exec(cls||'');
  return mm?mm[1]:'';
 }
 function isCodeBlock(n){
  var t=n.tagName,c=n.classList;
  return t==='PRE'||t==='CODE-BLOCK'||(c&&c.contains('md-code-block'));
 }
 function codeBlock(n){
  var pre=n.tagName==='PRE'?n:n.querySelector('pre');
  var code=pre?pre.textContent:n.textContent;
  return fence(code||'',langOf(n.tagName==='PRE'&&n.parentElement?n.parentElement:n)||langOf(n));
 }
 function kids(n){var s='';for(var c=n.firstChild;c;c=c.nextSibling)s+=inl(c);return s;}
 function inl(n){
  if(n.nodeType===3)return n.nodeValue.replace(/[ \t\r\n\f]+/g,' ');
  if(n.nodeType!==1||skipNode(n))return '';
  var t=n.tagName;
  if(t==='BR')return '\n';
  if(t==='CODE'&&!(n.parentElement&&n.parentElement.tagName==='PRE'))return '\x60'+n.textContent+'\x60';
  if(t==='STRONG'||t==='B')return '**'+kids(n).trim()+'**';
  if(t==='EM'||t==='I')return '*'+kids(n).trim()+'*';
  if(t==='A'){var h=n.getAttribute('href'),k=kids(n);return h&&/^https?:/i.test(h)&&k.trim()?'['+k.trim()+']('+h+')':k;}
  if(isCodeBlock(n)||/^(P|DIV|UL|OL|TABLE|BLOCKQUOTE|H[1-6]|HR|LI)$/.test(t))return '\n'+blocks(n)+'\n';
  return kids(n);
 }
 function table(n){
  var rows=[].slice.call(n.querySelectorAll('tr')).map(function(tr){
   return [].slice.call(tr.children).map(function(c){return kids(c).replace(/\s*\n\s*/g,' ').replace(/\|/g,'\\|').trim();});
  }).filter(function(r){return r.length;});
  if(!rows.length)return '';
  var w=Math.max.apply(null,rows.map(function(r){return r.length;}));
  rows=rows.map(function(r){while(r.length<w)r.push('');return '| '+r.join(' | ')+' |';});
  var sep='|'+new Array(w+1).join(' --- |');
  return [rows[0],sep].concat(rows.slice(1)).join('\n');
 }
 function list(n,depth){
  var ordered=n.tagName==='OL',i=Number(n.getAttribute('start'))||1,out=[];
  for(var li=n.firstElementChild;li;li=li.nextElementSibling){
   if(li.tagName!=='LI')continue;
   var head='',rest=[];
   for(var c=li.firstChild;c;c=c.nextSibling){
    if(c.nodeType===1&&(c.tagName==='UL'||c.tagName==='OL'))rest.push(list(c,depth+1));
    else if(c.nodeType===1&&isCodeBlock(c))rest.push(codeBlock(c));
    else head+=inl(c);
   }
   var pad=new Array(depth*2+1).join(' '),mark=ordered?(i++)+'. ':'- ';
   out.push(pad+mark+head.replace(/\s*\n\s*/g,' ').trim());
   rest.forEach(function(r){out.push(r);});
  }
  return out.join('\n');
 }
 function blocks(n){
  var parts=[],buf='';
  function flush(){var t=buf.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();if(t)parts.push(t);buf='';}
  for(var c=n.firstChild;c;c=c.nextSibling){
   if(c.nodeType===3){buf+=c.nodeValue.replace(/[ \t\r\n\f]+/g,' ');continue;}
   if(c.nodeType!==1||skipNode(c))continue;
   var t=c.tagName;
   if(isCodeBlock(c)){flush();parts.push(codeBlock(c));}
   else if(t==='UL'||t==='OL'){flush();parts.push(list(c,0));}
   else if(t==='TABLE'){flush();parts.push(table(c));}
   else if(/^H[1-6]$/.test(t)){flush();parts.push(new Array(Number(t[1])+1).join('#')+' '+kids(c).trim());}
   else if(t==='HR'){flush();parts.push('---');}
   else if(t==='BLOCKQUOTE'){flush();parts.push(blocks(c).split('\n').map(function(l){return '> '+l;}).join('\n'));}
   else if(t==='P'||t==='LI'){flush();var p=kids(c).replace(/[ \t]+\n/g,'\n').trim();if(p)parts.push(p);}
   else if(t==='DIV'||t==='SECTION'||t==='ARTICLE'||t==='MESSAGE-CONTENT'||t==='STRUCTURED-CONTENT-CONTAINER'||/-/.test(t)){
    var hasBlock=c.querySelector('p,pre,ul,ol,table,h1,h2,h3,h4,h5,h6,blockquote,code-block,div.md-code-block,div');
    if(hasBlock){flush();var inner=blocks(c);if(inner)parts.push(inner);}
    else buf+=inl(c);
   }
   else buf+=inl(c);
  }
  flush();
  return parts.join('\n\n');
 }
 return blocks(root).replace(/\n{3,}/g,'\n\n').trim();
}
`;
