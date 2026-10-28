/**
 * 职责：验证 MinerU V1/V2 内容列表到可脱敏文档结构的完整转换。
 * 主要验证：标题、段落、表格、列表、脚注顺序和文字保留；图片路径不进入正文，图注不冒充图片 OCR。
 * 验证边界：只解析合成 MinerU 响应，不请求 MinerU API/CLI；修改 `mineru-cli.ts` 时可定向回归。
 */
import {expect,test} from 'bun:test';
import {parseMineruDocxJson,parseMineruJson} from './mineru-cli';

test('known MinerU page furniture and aside text retain source text without false unknown-type issues',()=>{
 const [page]=parseMineruJson([
  {type:'header',page_idx:0,text:'原文页眉'},
  {type:'text',page_idx:0,text:'正文'},
  {type:'aside_text',page_idx:0,text:'原文旁注'},
  {type:'footer',page_idx:0,text:'原文页脚'},
  {type:'page_number',page_idx:0,text:'1'},
 ],1);
 expect(page!.text).toBe('原文页眉\n正文\n原文旁注\n原文页脚\n1');
 expect(page!.issues??[]).toEqual([]);
 const [unknown]=parseMineruJson([{type:'unexpected_source_shape',page_idx:0,text:'未知形状正文'}],1);
 expect(unknown!.text).toBe('未知形状正文');
 expect(unknown!.issues).toContain('unsupported_block_type');
});

test('DOCX keeps document order and structured text without requiring PDF page numbers',()=>{
 const [page]=parseMineruDocxJson([
  {type:'title',text:'标题',text_level:1},
  {type:'paragraph',text:'段落'},
  {type:'list',list_items:['项目一','项目二']},
  {type:'table',table_body:'<table><tr><td>列一</td><td>列二</td></tr></table>'},
  {type:'image',img_path:'private/photo.png',image_caption:'不读取图片'},
 ]);
 expect(page.page).toBe(1);
 expect(page.method).toBe('text');
 expect(page.structure?.map(block=>block.kind)).toEqual(['heading','paragraph','list','table']);
 expect(page.text).toContain('列一\t列二');
 expect(page.text).not.toContain('private/photo.png');
 expect(page.text).not.toContain('不读取图片');
});

test('parses MinerU page-grouped V2 blocks and preserves every text field in order',()=>{
 const pages=[[ 
  {type:'title',page_idx:0,content:{title_content:[{type:'text',content:'合同标题'}],level:1}},
  {type:'paragraph',page_idx:0,content:{paragraph_content:[{type:'text',content:'甲方：测试主体。'}]}},
  {type:'table',page_idx:0,content:{table_caption:[{type:'text',content:'付款记录'}],table_body:'<table><tr><th>日期</th><th>金额</th></tr><tr><td>2025-01-02</td><td>人民币 9,876 元</td></tr></table>',table_footnote:[{type:'text',content:'表下注释。'}]}},
  {type:'list',page_idx:0,content:{list_items:['第一项；不可删除。','第二项；也要保留。']}},
  {type:'page_footnote',page_idx:0,content:{page_footnote_content:[{type:'text',content:'页脚内容。'}]}},
  {type:'image',page_idx:0,content:{img_path:'images/private.png',image_caption:[]}},
 ]];
 const [page]=parseMineruJson(pages,1) as any[];
 expect(page.text).toBe('合同标题\n甲方：测试主体。\n付款记录\n日期\t金额\n2025-01-02\t人民币 9,876 元\n表下注释。\n第一项；不可删除。\n第二项；也要保留。\n页脚内容。');
 expect(page.text).toContain('合同标题');
 expect(page.text).toContain('人民币 9,876 元');
 expect(page.text).toContain('第一项；不可删除。');
 expect(page.text).toContain('页脚内容。');
 expect(page.text).not.toContain('images/private.png');
 expect(page.structure.map((block:any)=>block.kind)).toEqual(['heading','paragraph','table','list','footnote']);
 expect(page.structure[2].rows.map((row:any)=>row.cells.map((cell:any)=>cell.text))).toEqual([
  ['日期','金额'],['2025-01-02','人民币 9,876 元'],
 ]);
});

test('parses MinerU flat V1 blocks without trimming or dropping repeated text',()=>{
 const blocks=[
  {type:'text',text:'  同一段文字  ',text_level:1,page_idx:0},
  {type:'text',text:'同一段文字',page_idx:0},
  {type:'paragraph',text:'V1段落原文',page_idx:0},
  {type:'title',text:'V1标题原文',page_idx:0},
  {type:'image',img_path:'images/ignored.jpg',image_caption:['票据图注'],page_idx:0},
 ];
 const [page]=parseMineruJson(blocks,1) as any[];
 expect(page.text).toContain('  同一段文字  ');
 expect(page.text).toContain('同一段文字');
 expect(page.text).toContain('V1段落原文');expect(page.text).toContain('V1标题原文');
 expect(page.text).toContain('票据图注');
 expect(page.text).not.toContain('images/ignored.jpg');
 expect(page.structure[0]).toMatchObject({kind:'heading',level:1});
 expect(page.structure.filter((block:any)=>block.kind==='paragraph')).toHaveLength(2);
});

test('decodes table cell text and spans while retaining OCR text attached to an image block',()=>{
 const [page]=parseMineruJson([[
  {type:'table',page_idx:0,content:{table_caption:'结算表',table_body:'<table><tr><td rowspan="2">甲&amp;乙</td><td colspan="2">金额</td></tr><tr><td>100&nbsp;元</td><td>合计</td></tr></table>'}},
  {type:'image',page_idx:0,content:{img_path:'private/path.png',image_caption:'票据照片',text:'发票号码 12345'}}
 ]],1) as any[];
 expect(page.structure[0]).toMatchObject({kind:'table',caption:'结算表',rows:[
  {cells:[{text:'甲&乙',rowSpan:2},{text:'金额',columnSpan:2}]},
  {cells:[{text:'100\u00a0元'},{text:'合计'}]},
 ]});
 expect(page.text).toContain('发票号码 12345');expect(page.text).toContain('票据照片');
 expect(page.text).not.toContain('private/path.png');expect(JSON.stringify(page.structure)).not.toContain('img_path');
});

test('does not treat an image caption as a substitute for OCR text inside the image',()=>{
 const [page]=parseMineruJson([{type:'image',page_idx:0,img_path:'private/ticket.png',image_caption:'票据照片'}],1) as any[];
 expect(page.text).toBe('票据照片');
 expect(page.issues).toEqual(['image_without_text']);
});

test('only explicit HTML sources convert formatting; ordinary legal references and code stay literal',()=>{
 const ordinary='<中华人民共和国民法典>；a < b；<b>标签示例</b> &amp;';
 const [page]=parseMineruJson([
  {type:'text',page_idx:0,text:ordinary},
  {type:'paragraph',page_idx:0,html:'<p>本金<strong>10000元</strong><br/>2026-10-27</p><div>甲&amp;乙</div>'},
  {type:'html',page_idx:0,text:'<span>确认&#x4E66;</span>'},
  {type:'paragraph',page_idx:0,content:{paragraph_content:[{type:'html',content:'<b>嵌套格式</b>'}]}},
  {type:'list',page_idx:0,list_items:['首项','<b>原文字面量</b> &amp;']},
  {type:'code',page_idx:0,text:'<div>代码</div>'},
  {type:'code',page_idx:0,html:'<b>代码字面量</b> &amp;'},
  {type:'equation',page_idx:0,content:{latex:{type:'html',content:'a < b；&amp;'}}},
 ],1);
 expect(page!.text).toBe(ordinary+'\n本金10000元\n2026-10-27\n甲&乙\n确认书\n嵌套格式\n首项\n<b>原文字面量</b> &amp;\n<div>代码</div>\n<b>代码字面量</b> &amp;\na < b；&amp;');
 expect(page!.issues??[]).not.toContain('unsupported_block_type');
});

test('HTML conversion preserves unknown, unbalanced and script/style fragments without guessing',()=>{
 const samples=['<p><中华人民共和国民法典>与<custom>原文</custom></p>','<p>未闭合正文','<b><i>错配</b></i>','<script>const x="<b>字面量</b>";</script>','<style>.x { color:red }</style>'];
 const [page]=parseMineruDocxJson(samples.map(html=>({type:'html',html})));
 expect(page!.text).toBe(['<中华人民共和国民法典>与<custom>原文</custom>',...samples.slice(1)].join('\n'));
});

test('table HTML keeps legal brackets, comparisons, formatting and single-layer entity text',()=>{
 const [page]=parseMineruJson([{type:'table',page_idx:0,table_body:'<table><tbody><tr><td rowspan="2"><p>本金<b>10000元</b></p><p>2026-10-27</p></td><td>&amp;lt; &#x110000; &#55296; &unknown;</td></tr><tr><td>&lt;中华人民共和国民法典&gt;与<中华人民共和国民法典>；a < b；<custom>文字</custom></td></tr></tbody></table>'}],1);
 const table=page!.structure![0] as any;
 expect(table.rows[0].cells[0]).toEqual({text:'本金10000元\n2026-10-27',rowSpan:2});
 expect(table.rows[0].cells[1].text).toBe('&lt; &#x110000; &#55296; &unknown;');
 expect(table.rows[1].cells[0].text).toBe('<中华人民共和国民法典>与<中华人民共和国民法典>；a < b；<custom>文字</custom>');
});

test('malformed tables and text outside cells fall back without losing any source text',()=>{
 for(const html of ['<table><tr><td>10000元</td><td>未闭合','前置说明<table><tr><td>10000元</td></tr></table>','<table><caption>重要说明</caption><tr><td>10000元</td></tr></table>']){
  const [page]=parseMineruJson([{type:'table',page_idx:0,table_body:html}],1);
  expect(page!.text).toBe(html);expect(page!.issues).toContain('table_structure_unparsed');
 }
});

test('nested HTML table bodies decode entities once and malformed nested tables retain raw text',()=>{
 for(const table of ['<table><tr><td>&amp;lt; &amp;amp; 10000元</td></tr></table>','<table><tr><td>&amp;lt; 10000元']){
  const [page]=parseMineruDocxJson([{type:'table',content:{table_body:[{type:'html',content:table}]}}]);
  if(table.endsWith('</table>'))expect(page!.text).toBe('&lt; &amp; 10000元');
  else {expect(page!.text).toBe(table);expect(page!.issues).toContain('table_structure_unparsed');}
 }
});

test.each([
 ['<哈哈></哈哈>','<哈哈></哈哈>'],
 ['<哈哈>本金10000元</哈哈>','<哈哈>本金10000元</哈哈>'],
 ['<p><哈哈>正文2026-10-27</哈哈></p>','<哈哈>正文2026-10-27</哈哈>'],
 ['<custom data-x="1">甲&amp;乙</custom>','<custom data-x="1">甲&乙</custom>'],
 ['<b>金额10000元</哈哈>','<b>金额10000元</哈哈>'],
 ['<p>本金10000元<br','<p>本金10000元<br'],
 ['&lt;哈哈&gt;正文&lt;/哈哈&gt;','<哈哈>正文</哈哈>'],
 ['&amp;lt;哈哈&amp;gt;','&lt;哈哈&gt;'],
 ['<中华人民共和国民法典>；1 < 2；3 > 2','<中华人民共和国民法典>；1 < 2；3 > 2'],
])('adversarial HTML %s retains meaningful text and unknown markup', (input,expected)=>{
 const ordinary=parseMineruDocxJson([{type:'text',text:input}])[0]!;
 const html=parseMineruDocxJson([{type:'html',html:input}])[0]!;
 const table=parseMineruDocxJson([{type:'table',table_body:`<table><tr><td>${input}</td></tr></table>`}])[0]!;
 expect(ordinary.text).toBe(input);expect(html.text).toBe(expected);expect(table.text).toBe(expected);
});
