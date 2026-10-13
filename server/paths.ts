/**
 * 职责：统一仓库内配置路径，避免服务启动目录改变材料和存储位置。
 * 公开入口：repositoryRoot、resolveRepositoryPath()、storageDirectory()；供 API、worker、迁移与工具使用。
 * 兼容边界：绝对路径保持原位置，不修改数据库路径或历史任务指纹。
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const repositoryRoot=fileURLToPath(new URL('../',import.meta.url));
export function resolveRepositoryPath(path:string){return resolve(repositoryRoot,path);}
export function storageDirectory(env:NodeJS.ProcessEnv=process.env){return resolveRepositoryPath(env.STORAGE_DIR??'.storage');}
