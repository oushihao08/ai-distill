/** 验证题目信息保留Work新字段、冻结作者检索不被表述为归档新联网事件；不调用模型或数据库。 */
import {test,expect} from 'bun:test';
import * as generator from './generate-five-piece';

test('TSV成果保留作者冻结的制表符和正文，不转换为Markdown表格',async()=>{
 const markdown='案件\t金额\n甲案\t100\n';
 const bytes=await generator.deliverableBytes({path:'核对表.tsv',markdown,sheets:[]});
 expect(bytes.toString('utf8')).toBe(markdown);
});

test('题目信息包含专业元数据及等级依据',()=>{
 const input:any={title:'测试题',workflow_id:'fixture',question_version:'q',rubric_version:'r',question:{task_name:'证据审查',task_type:'F2',header:{},task_metadata:{scenario:'LS02',role_perspective:'原告律师',domain_l2:null,capabilities:['证据评估'],professional_knowledge:['书证证明力'],level_basis:{estimated_hours:1.5,explanation:'逐份核验',documents:[]},target_level:'L2',source_note:'本次卷宗',tools:['文档编辑'],vl_dependency:false,generation_note:'AI模拟'}},simulation:{deliverable_type:'F2',deliverable_title:'意见'}};
 expect((generator as any).taskInfoMarkdown).toBeFunction();const text=(generator as any).taskInfoMarkdown(input);expect(text).toContain('书证证明力');expect(text).toContain('1.5');expect(text).toContain('LS02');expect(text).toContain('未提供正式二级标签');
});

test('作者冻结记录明确不等于归档实际联网事件',()=>{
 expect((generator as any).traceMarkdown).toBeFunction();const text=(generator as any).traceMarkdown({model:'author_snapshot',research_entries:[{id:'S1',query:'证据规则',title:'正文',url:'https://example.test/law',finding:'规则',version_or_date:'2020',used_in:'D1'}],actual_search_queries:[],actually_opened_urls:[]} as any);
 expect(text).toContain('作者冻结');expect(text).not.toContain('仅列与实际 Codex 网页搜索／打开事件匹配');
});

test('未采用检索保留失败原因，不生成空正文链接',()=>{
 const text=generator.traceMarkdown({model:'author_snapshot',research_entries:[{id:'S2',query:'可比案例',title:'未取得可采用正文',url:'',finding:'未核验：未采用',version_or_date:'本次基准日',used_in:'未采用'}],actual_search_queries:[],actually_opened_urls:[]} as any);
 expect(text).toContain('未取得正文URL');expect(text).toContain('未核验');expect(text).not.toContain(']()');
});


test('结构化正文内的附件及页码文字不被误当作外层定位标记',()=>{
 const docs:any=[{format:'redacted-structure-v1',pages:[{page:1,blocks:[{kind:'paragraph',text:'卷内引用【附件 4】与【原附件第 999 页】，均为正文。'}]},{page:2,blocks:[{kind:'paragraph',text:'第二页有效正文。'}]}]}];
 const text='【附件 1】\n\n【原附件第 1 页】\n卷内引用【附件 4】与【原附件第 999 页】，均为正文。\n\n【原附件第 2 页】\n第二页有效正文。\n\n【附件 1 结束】';
 const full:any=generator.confirmationDocument(text,[{start:0,end:text.length}],docs);
 expect(full.pages.map((p:any)=>p.page)).toEqual([1,2]);
 expect(full.pages[0].blocks[1].text).toContain('999');
 const start=text.indexOf('【原附件第 2 页】');
 const second:any=generator.confirmationDocument(text,[{start,end:text.length}],docs);
 expect(second.pages.map((p:any)=>p.page)).toEqual([2]);
 expect(()=>generator.confirmationDocument(text+'篡改',[{start:0,end:text.length}],docs)).toThrow('冻结正文不一致');
});
