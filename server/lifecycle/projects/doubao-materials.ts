/** 豆包普通材料DOCX布局注册；选用材料快照由导出器强制逐份输出，不受此合册策略覆盖。 */
import type {SyncProjectImplementations} from '../project-registry';
import type {ProjectIdentity} from '../step-types';
import type {MaterialDocxLayout} from '../material-docx';
export function registerDoubaoMaterialLayouts(registry:SyncProjectImplementations<ProjectIdentity,MaterialDocxLayout>){
 for(const key of ['豆包高经济价值','豆包高经'])registry.register(key,()=>'combined');
}
