/** 验证名称置换的同时执行、歧义拒绝及正文边界；不证明读音正确、数据库事务或真实材料验收。 */
import {expect,test} from 'bun:test';
import {replaceNames,replaceNameTextTree,validateNameReplacements} from './name-replacements';
const map=(before:string,after:string,original=before)=>({original,before,after,kind:'person' as const});
test('同时替换不会串联，且完整长名称优先',()=>{
 const result=replaceNames('林知远与林知远公司、杨正',[map('林知远','杨正'),{...map('林知远公司','杨正公司'),kind:'organization'},map('杨正','杨政')]);
 expect(result.text).toBe('杨正与杨正公司、杨政');expect(result.counts['林知远']).toBe(1);expect(result.counts['林知远公司']).toBe(1);
});
test('同旧名多主体及不同主体目标重名均拒绝',()=>{
 expect(()=>validateNameReplacements([map('旧名','甲','主体一'),map('旧名','乙','主体二')])).toThrow('主体歧义');
 expect(()=>validateNameReplacements([map('旧一','新名','主体一'),map('旧二','新名','主体二')])).toThrow('同一个新名称');
});
test('仅修改指定文本字段，保留ID、对象键和版本，输入不变',()=>{
 const source={question:'林知远申请',question_version:'林知远',rubric:[{id:'林知远',criterion:'林知远受领'}],texts:[{id:'林知远',text:'林知远'}]};
 const result=replaceNameTextTree(source,[map('林知远','杨正')],new Set(['question','criterion','text']));
 expect(result.value).toEqual({...source,question:'杨正申请',rubric:[{id:'林知远',criterion:'杨正受领'}],texts:[{id:'林知远',text:'杨正'}]});
 expect(source.question).toBe('林知远申请');expect(result.changes).toHaveLength(3);
});
test('映射内容按字面匹配正则符号，第二次无旧名时不再修改',()=>{
 const mapping=validateNameReplacements([{original:'某公司',before:'旧(集团)',after:'新(集团)',kind:'organization'}]);
 const first=replaceNames('旧(集团)',mapping);expect(first.text).toBe('新(集团)');expect(replaceNames(first.text,mapping).counts).toEqual({});
});
