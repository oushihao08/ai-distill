/** 验证飞书六字段精确比较及材料身份约束；纯函数测试，不访问数据库、飞书或模型。 */
import {expect,test} from 'bun:test';
import {feishuTextFields,compareFeishuText,assertAuthoringMaterialBinding,assertOriginalManifest} from './feishu-verification';
const q={task_name:'任务',task_type:'法律服务',question:'题面\n第二行',rubric:[{id:'R1',max_score:1,criterion:'核对债权',rule:'完整给分'}],answer_approach:'思路',reference_answer:'标答'};
test('六字段及可见题目ID固定投影，rubric不丢计分规则',()=>{const f=feishuTextFields('uuid',q);expect(f['题目ID']).toBe('uuid');expect(f['考点rubric']).toBe('1、核对债权\n计分规则：完整给分');expect(compareFeishuText(f,{...f})).toEqual([]);});
for(const field of ['任务名称','任务类型','prompt','考点rubric','作答思路','标准答案-文本'])test(`检测${field}末尾空格差异`,()=>{const f=feishuTextFields('uuid',q),d=compareFeishuText(f,{...f,[field]:f[field]+' '});expect(d).toHaveLength(1);expect(d[0]?.field).toBe(field);expect(JSON.stringify(d)).not.toContain('题面');});
test('检测换行、截断、缺字段及错误类型',()=>{const f=feishuTextFields('uuid',q);for(const value of ['题面\r\n第二行','题面',undefined,42])expect(compareFeishuText(f,{...f,prompt:value})).toHaveLength(1);});
const source={origin:{kind:'library_v1',package_id:'p',revision_id:'r',redaction_id:'d',snapshot_digest:'s'},attachments:[{id:'a',sha256:'hash'}]};
test('同版材料通过',()=>expect(()=>assertAuthoringMaterialBinding({material_origin:source.origin,materials:source.attachments},source)).not.toThrow());
test('同数量不同材料拒绝',()=>expect(()=>assertAuthoringMaterialBinding({material_origin:source.origin,materials:[{id:'wrong',sha256:'hash'}]},source)).toThrow('feishu_material_binding_mismatch'));
test('版本改变拒绝',()=>expect(()=>assertAuthoringMaterialBinding({material_origin:{...source.origin,revision_id:'new'},materials:source.attachments},source)).toThrow('feishu_material_version_mismatch'));
test('旧来源脱敏版本仍校验',()=>{const legacy={origin:{kind:'legacy',redaction_attempt_id:'a'},attachments:source.attachments};expect(()=>assertAuthoringMaterialBinding({redaction_attempt_id:'a',materials:source.attachments},legacy)).not.toThrow();expect(()=>assertAuthoringMaterialBinding({redaction_attempt_id:'b',materials:source.attachments},legacy)).toThrow();});
test('附件数、ID、大小、SHA任一不同均拒绝',()=>{const f={id:'a',sha256:'hash',size_bytes:12};expect(()=>assertOriginalManifest([f],[f])).not.toThrow();for(const actual of [[],[f,f],[{...f,id:'b'}],[{...f,size_bytes:13}],[{...f,sha256:'other'}]])expect(()=>assertOriginalManifest([f],actual)).toThrow();});
