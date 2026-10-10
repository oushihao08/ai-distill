/**
 * 职责：通过独立 Agent 模块暴露本机执行配置、模型能力目录及项目默认配置。
 * 关键方法：读取／保存系统及项目配置、检查凭证路径、列出模型和推理强度。
 * 使用场景：HTTP 设置 API 和任务创建／执行准备；具体持久化沿用现有配置表。
 */
import type {Pool} from 'pg';
import {readCodexModelCatalog,validateCodexModelSettings,validateCodexModel} from '../codex/models';
import {readCodexSettings} from '../codex/system-config';

export {
 mergeCodexDefaults,
 readCodexSettings as readAgentSettings,
 readCodexDefaults as readAgentDefaults,
 readProjectCodexSettings as readProjectAgentSettings,
 readProjectCodexDefaults as readProjectAgentDefaults,
 saveCodexSettings as saveAgentSettings,
 saveProjectCodexSettings as saveProjectAgentSettings,
 clearProjectCodexSettings as clearProjectAgentSettings,
 readCodexCredentialHome as readAgentCredentialHome,
 saveCodexCredentialHome as saveAgentCredentialHome,
} from '../codex/system-config';

/** 模型目录和登录凭证共用同一个 CODEX_HOME；显式路径优先于进程默认值。 */
export function readAgentModelCatalog(credentialHome?:string){return readCodexModelCatalog(credentialHome);}
export async function readConfiguredAgentModelCatalog(pool:Pick<Pool,'query'>){
 const settings=await readCodexSettings(pool);
 return readAgentModelCatalog(settings.credential_home??undefined);
}
export const validateAgentModelSettings=validateCodexModelSettings;
export const validateAgentModel=validateCodexModel;
export {configureCodexCredentialsHome as configureAgentCredentialHome,codexLoginStatus as agentLoginStatus} from '../codex/client';
