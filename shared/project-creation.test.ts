/** 验证丢失回执恢复严格匹配身份及配置，不发起写请求。 */
import {test,expect} from 'bun:test';
import {matchCreatedPhase} from './project-creation';
const input={name:'甲 - 第一期',parent_name:'甲',phase_name:'第一期',phase_no:1,description:'',workspace_path:'/tmp/phase',local_skill_path:'/tmp/shared',question_tags:['L4']};
const created={...input,id:'receipt',material_backend:'library_v1',material_mode:'material_packages',material_root:null};
test('恢复相同创建回执，未知请求不伪造成功',()=>{
 expect(matchCreatedPhase(input,[created])?.id).toBe('receipt');expect(matchCreatedPhase(input,[])).toBeNull();
 for(const change of [{description:'其他'},{workspace_path:'/tmp/other'},{local_skill_path:'/tmp/other'},{question_tags:[]}])expect(()=>matchCreatedPhase(input,[{...created,...change}])).toThrow('不一致');
 expect(matchCreatedPhase({...input,project_group_id:'A'},[{...created,project_group_id:'B'}])).toBeNull();
 expect(()=>matchCreatedPhase(input,[created,created])).toThrow('多条');
});
