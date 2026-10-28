/** 豆包材料交付布局注册；独立于飞书执行器，供公共材料DOCX策略装配。 */
import type {SyncProjectImplementations} from '../project-registry';
import type {ProjectIdentity} from '../step-types';
import type {MaterialDocxLayout} from '../material-docx';
export function registerDoubaoMaterialLayouts(registry:SyncProjectImplementations<ProjectIdentity,MaterialDocxLayout>){
 for(const key of ['豆包高经济价值','豆包高经'])registry.register(key,()=>'combined');
}
