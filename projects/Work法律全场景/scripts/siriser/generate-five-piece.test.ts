/** 验证题目信息保留Work新字段、冻结作者检索不被表述为归档新联网事件；不调用模型或数据库。 */
import {test,expect} from 'bun:test';
import * as generator from './generate-five-piece';

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
