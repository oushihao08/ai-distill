/** 豆包材料DOCX布局注册：现行豆包高经济价值按真实脱敏文书分件输出，仅历史旧名豆包高经保留合册兼容。 */
import type {SyncProjectImplementations} from '../project-registry';
import type {ProjectIdentity} from '../step-types';
import type {MaterialDocxLayout} from '../material-docx';
export function registerDoubaoMaterialLayouts(registry:SyncProjectImplementations<ProjectIdentity,MaterialDocxLayout>){
 registry.register('豆包高经济价值',()=>'separate');
 registry.register('豆包高经',()=>'combined');
}
