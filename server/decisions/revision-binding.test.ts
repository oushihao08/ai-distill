/** 验证返修链读取冻结设置、拒绝规则变更并兼容历史快照。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import {test,expect} from 'bun:test';
import {readRevisionSettings} from './revision-binding';
test('revision settings reject changed rules, including selection after a chain starts without rules',async()=>{
 for(const [frozen,current] of [['rule-a','rule-b'],[null,'rule-a']]){
  const db={query:async()=>({rows:[{config_snapshot:{rule_version_id:frozen,configs:{}},current_rule_version_id:current}]})} as any;
  await expect(readRevisionSettings(db,'workflow','round')).rejects.toThrow('规则版本已变化');
 }
});
test('unchanged frozen rules and legacy snapshots remain readable',async()=>{
 for(const snapshot of [{rule_version_id:'rule-a',configs:{}},{configs:{}}]){
  const db={query:async()=>({rows:[{config_snapshot:snapshot,current_rule_version_id:'rule-a'}]})} as any;
  expect(await readRevisionSettings(db,'workflow','round')).toEqual(snapshot);
 }
});
