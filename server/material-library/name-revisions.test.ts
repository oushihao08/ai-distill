/** 验证名称预览绑定源版本、拒绝无原件依据及漏命中；不证明应用事务、数据库或真实模型验收。 */
import {expect,test} from 'bun:test';
import {buildNameRevisionPreview,type NameRevisionContext} from './name-revisions';
import {nameRevisionHash as hash} from '../authoring/name-revision-preview';
const mappings=[{original:'杨政',before:'林知远',after:'杨正',kind:'person' as const}];
function context():NameRevisionContext{
 const markdown='林知远申请',document={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'p1',kind:'paragraph',text:markdown}]}]};
 const index=JSON.stringify({format:'redacted-index-v2',redacted_sha256:hash(markdown),materials:[{material_id:'file',markdown,document,structure_sha256:hash(JSON.stringify(document))}],prepared_documents:[{id:'d1',title:'申请',text:markdown,document}]});
 return{project_id:'project',redaction:{id:'red',package_id:'package',output_digest:'source',link_version:1,markdown,index_content:index},originals:[{document:JSON.stringify({pages:[{text:'杨政申请'}]})}],workflows:[{id:'workflow',source_attempt_id:'attempt',snapshot_digest:'frozen',markdown,index_content:index,source_input:{materials:[{id:'file',sha256:'old'}]},question:{question:markdown,attachment_ids:['file'],answer_requirements:{input_mode:'text',output_mode:'text',tools:[]},rubric:[{id:'R1',criterion:'林知远'}],question_version:'q1',rubric_version:'r1'}}]};
}
test('同输入预览可复现；变更题包、来源或加载版本均改变预览绑定',()=>{
 const c=context(),a=buildNameRevisionPreview(c,mappings);expect(a.preview_digest).toBe(buildNameRevisionPreview(c,mappings).preview_digest);
 for(const change of [(x:NameRevisionContext)=>x.redaction.link_version++,(x:NameRevisionContext)=>x.workflows[0].question.question+='变更',(x:NameRevisionContext)=>x.workflows[0].snapshot_digest='new']){
  const next=context();change(next);expect(buildNameRevisionPreview(next,mappings).preview_digest).not.toBe(a.preview_digest);
 }
});
test('原名必须在本次原件正文出现；旧名必须在本次库级正文出现',()=>{
 expect(()=>buildNameRevisionPreview(context(),[{...mappings[0],original:'无依据'}])).toThrow('原主体');
 expect(()=>buildNameRevisionPreview(context(),[{...mappings[0],before:'不存在'}])).toThrow('旧名称');
});
test('库级及题包预览同时改变正文，旧结构与题包不被原地改写',()=>{
 const c=context(),p=buildNameRevisionPreview(c,mappings);expect(p.library.markdown).toBe('杨正申请');expect(p.workflows[0].question.question).toBe('杨正申请');expect(p.workflows[0].question.rubric[0].criterion).toBe('杨正');expect(c.workflows[0].question.question).toBe('林知远申请');
});
