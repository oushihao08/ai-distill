/** 验证整包计划在原结构内替换、分册和覆盖边界；不调用数据库或模型。 */
import {test,expect} from 'bun:test';
import {documentBlocksToText,type DocumentBlock} from './document-structure';
import {prepareStructuredMaterialData} from './prepared-structure';
const source=()=>{
 const structure:DocumentBlock[]=[{id:'h',kind:'heading',text:'确认书',level:1},{id:'t',kind:'table',rows:[{cells:[{text:'姓名',rowSpan:2},{text:'张三',columnSpan:2}]},{cells:[{text:'金额100元，2021年1月1日'}]}]},{id:'p',kind:'paragraph',text:'张三签收'}];
 return {file_id:'f',page:1,structure,text:documentBlocksToText(structure)};
};
function plan(p=source()){
 const edits=[...p.text.matchAll(/张三/g)].map(m=>({file_id:'f',page:1,start:m.index!,end:m.index!+2,source_text:'张三',replacement_text:'人员甲'}));
 const text=p.text.replaceAll('张三','人员甲');return {edits,documents:[{id:'d',title:'确认书',segments:[{file_id:'f',page:1,start:0,end:text.length}]}]};
}
test('保留表格行列、合并和空字段，代称一致且金额日期不变，原输入不变',()=>{
 const p=source(),before=JSON.stringify(p),result=prepareStructuredMaterialData(plan(p),[p]);
 const table=result.documents[0]!.document.pages[0]!.blocks[1] as Extract<DocumentBlock,{kind:'table'}>;
 expect(table.rows[0]!.cells[0]!.rowSpan).toBe(2);expect(table.rows[0]!.cells[1]!.columnSpan).toBe(2);expect(table.rows[0]!.cells[1]!.text).toBe('人员甲');
 expect(result.documents[0]!.text).toContain('金额100元，2021年1月1日');expect(JSON.stringify(p)).toBe(before);
 expect(result.documents[0]!.document.pages.map(p=>documentBlocksToText(p.blocks)).join('\n\n')).toBe(result.documents[0]!.text);
});
test('跨单元格编辑明确拒绝，不能因替换文字合法而压平',()=>{
 const p=source(),q=plan(p),start=p.text.indexOf('姓名');q.edits=[{file_id:'f',page:1,start,end:start+5,source_text:p.text.slice(start,start+5),replacement_text:'人员甲'}];q.documents[0]!.segments[0]!.end=p.text.length-2;
 expect(()=>prepareStructuredMaterialData(q,[p])).toThrow('跨越');
});
test('分册切断表格拒绝；整表边界可分册并完整覆盖正文',()=>{
 const p=source(),q=plan(p),text=p.text.replaceAll('张三','人员甲'),start=text.indexOf('人员甲');q.documents=[{id:'a',title:'一',segments:[{file_id:'f',page:1,start:0,end:start}]},{id:'b',title:'二',segments:[{file_id:'f',page:1,start,end:text.length}]}];
 expect(()=>prepareStructuredMaterialData(q,[p])).toThrow('切断');
 const boundary=text.lastIndexOf('\n')+1;q.documents[0]!.segments[0]!.end=boundary;q.documents[1]!.segments[0]!.start=boundary;
 const result=prepareStructuredMaterialData(q,[p]);expect(result.documents.map(d=>d.text).join('')).toBe(text);
});
test('段内分册、空白字段、列表、换行和UTF16偏移保持一致',()=>{
 const structure:DocumentBlock[]=[{id:'p',kind:'paragraph',text:'😀甲乙'},{id:'t',kind:'table',caption:'表',rows:[{cells:[{text:''},{text:'张三'}]}],footnotes:['注']},{id:'l',kind:'list',items:['甲','乙']}];
 const p={file_id:'f',page:1,structure,text:documentBlocksToText(structure)},q=plan(p);expect(prepareStructuredMaterialData(q,[p]).pages[0]!.text).toContain('😀甲乙');
});

test('旧文本计划不能携带编辑前的原结构，避免正式导入出现文字与结构不一致',async()=>{
 const {prepareMaterialData}=await import('./material-preparation');const p=source();
 const out=prepareMaterialData(plan(p),[p]);
 expect(out.pages[0]!.text).toContain('人员甲');
 expect(out.pages[0]).not.toHaveProperty('structure');
 expect(p.text).toContain('张三');
});


test('删除扫描尾注后的纯换行分段仍保持完整覆盖且不伪造正文',()=>{
 const structure:DocumentBlock[]=[{id:'a',kind:'paragraph',text:'正文'},{id:'b',kind:'paragraph',text:'8836'},{id:'c',kind:'paragraph',text:''}];
 const text=documentBlocksToText(structure),source={file_id:'f',page:1,structure,text};
 const result=prepareStructuredMaterialData({edits:[{file_id:'f',page:1,start:3,end:7,source_text:'8836',replacement_text:''}],documents:[{id:'body',title:'文书',segments:[{file_id:'f',page:1,start:0,end:3}]},{id:'tail',title:'尾注',segments:[{file_id:'f',page:1,start:3,end:4}]}]},[source]);
 expect(result.documents.map(d=>d.text).join('')).toBe('正文\n\n');
 expect(documentBlocksToText(result.documents[1]!.document.pages[0]!.blocks)).toBe('\n');
});
