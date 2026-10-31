/** 验证名称修订后的材料结构/摘要与题包字段，损坏输入必须拒绝；不连接真实业务库或调用模型。 */
import {expect,test} from 'bun:test';
import {nameRevisionHash as hash,previewMaterialNames,previewQuestionNames} from './name-revision-preview';
const mappings=[{original:'杨政',before:'林知远',after:'杨正',kind:'person' as const}];
function source(){
 const text='林知远申请100元',document={format:'redacted-structure-v1',pages:[{page:1,blocks:[{id:'林知远',kind:'paragraph',text}]}]};
 return{markdown:text,index:JSON.stringify({format:'redacted-index-v2',redacted_sha256:hash(text),pages:[{material_id:'林知远',page:1}],materials:[{material_id:'林知远',markdown:text,document,structure_sha256:hash(JSON.stringify(document))}],prepared_documents:[{id:'林知远',title:'申请',text,document}]})};
}
test('材料正文、文件结构、分册及摘要同时更新，身份保持不变',()=>{
 const s=source(),p=previewMaterialNames(s.markdown,s.index,mappings),index=JSON.parse(p.index);
 expect(p.markdown).toBe('杨正申请100元');expect(index.materials[0].document.pages[0].blocks[0].text).toBe(p.markdown);
 expect(index.prepared_documents[0].text).toBe(p.markdown);expect(index.materials[0].material_id).toBe('林知远');expect(index.materials[0].document.pages[0].blocks[0].id).toBe('林知远');
 expect(index.redacted_sha256).toBe(hash(p.markdown));expect(index.materials[0].structure_sha256).toBe(hash(JSON.stringify(index.materials[0].document)));
});
test('旧正文或结构损坏拒绝修订，跨块替换不能伪造一致结果',()=>{
 const s=source();expect(()=>previewMaterialNames('错误正文',s.index,mappings)).toThrow('摘要');
 const i=JSON.parse(s.index);i.materials[0].document.pages[0].blocks[0].text='损坏';expect(()=>previewMaterialNames(s.markdown,JSON.stringify(i),mappings)).toThrow('投影');
});
test('题面、rubric、思路和标答更新；历史证据和附件ID保留，材料变化产生新版本',()=>{
 const q={question:'林知远',rubric:[{id:'林知远',criterion:'林知远享有权利'}],answer_approach:'林知远',reference_answer:'林知远',attachment_ids:['林知远'],manual_revision:{before:'林知远'},codex:{author:'林知远'}};
 const a=previewQuestionNames(q,mappings,'材料一'),b=previewQuestionNames(q,mappings,'材料二');
 expect(a.question.question).toBe('杨正');expect(a.question.rubric[0]).toEqual({id:'林知远',criterion:'杨正享有权利'});
 expect(a.question.answer_approach).toBe('杨正');expect(a.question.reference_answer).toBe('杨正');expect(a.question.attachment_ids).toEqual(q.attachment_ids);expect(a.question.manual_revision).toEqual(q.manual_revision);expect(a.question.codex).toEqual(q.codex);expect(a.question.question_version).not.toBe(b.question.question_version);
});
test('应用阶段可绑定新材料附件身份并纳入题目版本',()=>{
 const q={question:'林知远',rubric:[],attachment_ids:['old-md'],answer_requirements:{input_mode:'text',output_mode:'text',tools:[]}};
 const before=previewQuestionNames(q,mappings,'材料摘要',['new-md']),after=previewQuestionNames(q,mappings,'材料摘要',['another-md']);
 expect(before.question.attachment_ids).toEqual(['new-md']);expect(before.question.question_version).not.toBe(after.question.question_version);
 expect(()=>previewQuestionNames(q,mappings,'材料摘要',[])).toThrow('附件身份无效');
});
