/**
 * 职责：验证 MinerU V1/V2 内容列表到可脱敏文档结构的完整转换。
 * 主要验证：标题、段落、表格、列表、脚注顺序和文字保留；图片路径不进入正文，图注不冒充图片 OCR。
 * 使用场景：修改 `mineru-cli.ts` 的 MinerU 输出适配时运行。
 */
import {expect,test} from 'bun:test';
import {parseMineruJson} from './mineru-cli';

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
