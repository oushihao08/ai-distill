/**
 * 职责：保存本地材料库所有包共用的处理设置，复用本机SQLite配置持久化模式。
 * 入口：readLibraryProcessingSettings/saveLibraryProcessingSettings 供API设置和任务入队使用；
 * 配置只存STORAGE_DIR的私有SQLite，不迁移业务库；入队后仍使用任务冻结快照。
 */
import {Database} from 'bun:sqlite';
import {chmodSync,existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {storageDirectory} from '../paths';
import {buildDefaultProcessingSettings,validateProcessingSettings} from './service';
import {libraryRedactionTemplates} from '../../shared/redaction-templates';

function open(root:string){
 const directory=join(root,'material-library');mkdirSync(directory,{recursive:true,mode:0o700});
 const path=join(directory,'processing-settings.sqlite3'),db=new Database(path);
 db.exec('PRAGMA busy_timeout = 5000');
 db.exec('CREATE TABLE IF NOT EXISTS processing_settings (id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL)');
 chmodSync(path,0o600);return db;
}
export async function readLibraryProcessingSettings(pool:Pick<Pool,'query'>,root=storageDirectory()){
 if(existsSync(join(root,'material-library','processing-settings.sqlite3'))){
  const db=open(root);
  try{const row=db.query('SELECT settings,version FROM processing_settings WHERE id=1').get() as {settings:string;version:number}|null;if(row)return{processing_settings:validateProcessingSettings(JSON.parse(row.settings)),lock_version:row.version};}
  finally{db.close();}
 }
 const defaults=await buildDefaultProcessingSettings(pool);
 try{const saved=saveLibraryProcessingSettings(root,0,defaults);return{processing_settings:defaults,lock_version:saved.lock_version};}
 catch(error){if(error instanceof HTTPException&&error.status===409)return readLibraryProcessingSettings(pool,root);throw error;}
}
export function saveLibraryProcessingSettings(root:string,version:number,value:unknown){
 if(!Number.isSafeInteger(version)||version<0)throw new HTTPException(400,{message:'共用设置版本无效'});
 const raw=validateProcessingSettings(value);
 const templates=raw.redaction_templates as Array<{workflow:string}>|undefined;
 if(templates?.some(template=>template.workflow!=='codex_plan'))throw new HTTPException(400,{message:'字段映射模板已退役，新设置仅支持Agent化名模板'});
 const settings=validateProcessingSettings({...raw,redaction_templates:libraryRedactionTemplates(raw).filter(t=>t.id!=='mask')}),db=open(root);let active=false;
 try{
  db.exec('BEGIN IMMEDIATE');
  active=true;
  const row=db.query('SELECT version FROM processing_settings WHERE id=1').get() as {version:number}|null;
  if((row?.version??0)!==version)throw new HTTPException(409,{message:'共用设置已更新，请关闭后重新打开设置'});
  db.query('INSERT INTO processing_settings(id,settings,version,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings,version=excluded.version,updated_at=excluded.updated_at').run(JSON.stringify(settings),version+1,new Date().toISOString());
  db.exec('COMMIT');active=false;return{lock_version:version+1};
 }catch(error){if(active){try{db.exec('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'共用处理设置保存失败且回滚失败');}}throw error;}finally{db.close();}
}
