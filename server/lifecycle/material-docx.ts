/** 材料DOCX交付布局纯策略；导出器按项目身份选择，不修改脱敏数据或执行业务步骤。 */
import {SyncProjectImplementations} from './project-registry';
import {registerDoubaoMaterialLayouts} from './projects/doubao-materials';
import {resolveStepProjectKey} from './steps';
import type {ProjectIdentity} from './step-types';
export type MaterialDocxLayout='separate'|'combined';
const layouts=new SyncProjectImplementations<ProjectIdentity,MaterialDocxLayout>(()=>'separate');
/** 项目注册固定交付布局；未注册项目逐文书输出，不额外插入标题。 */
export function registerMaterialDocxLayout(key:string,layout:MaterialDocxLayout){return layouts.register(key,()=>layout);}
export function materialDocxLayout(project:ProjectIdentity){return layouts.execute(resolveStepProjectKey(project),project);}

registerDoubaoMaterialLayouts(layouts);
