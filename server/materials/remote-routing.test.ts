/** 测试入库、提取、脱敏三类队列按执行归属领取和恢复，不触发实际文件或模型处理。 */
import {expect,test} from 'bun:test';
import type {Pool} from 'pg';
import {runNextIntake} from '../intake-jobs';
import {runNextExtraction} from './jobs';
import {runNextRedaction} from './redaction-jobs';

function emptyQueue(){
 const calls:{sql:string;values:unknown[]}[]=[];
 const query=async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});return{rows:[],rowCount:0};};
 return{pool:{connect:async()=>({query,release(){}}),query} as unknown as Pool,calls};
}

test('本机材料 worker 仅查询 local 任务',async()=>{
 const intake=emptyQueue();expect(await runNextIntake(intake.pool,'/unused')).toBe(false);
 const extraction=emptyQueue();expect(await runNextExtraction(extraction.pool,'/unused')).toBe(false);
 const redaction=emptyQueue();expect(await runNextRedaction(redaction.pool,'/unused')).toBe(false);
 for(const queue of [intake,extraction,redaction]){
  const claims=queue.calls.filter(call=>call.sql.includes('FOR UPDATE OF w,a SKIP LOCKED'));
  expect(claims.length).toBeGreaterThanOrEqual(2);
  expect(claims.every(call=>call.sql.includes('a.execution_target=')&&call.values.includes('local'))).toBe(true);
 }
});

test('服务器材料 worker 仅查询 server 任务',async()=>{
 const intake=emptyQueue();expect(await runNextIntake(intake.pool,'/unused',undefined,undefined,'server')).toBe(false);
 const extraction=emptyQueue();expect(await runNextExtraction(extraction.pool,'/unused',undefined,undefined,undefined,'server')).toBe(false);
 const redaction=emptyQueue();expect(await runNextRedaction(redaction.pool,'/unused',undefined,undefined,'api','server')).toBe(false);
 for(const queue of [intake,extraction,redaction]){
  const claims=queue.calls.filter(call=>call.sql.includes('FOR UPDATE OF w,a SKIP LOCKED'));
  expect(claims.every(call=>call.sql.includes('a.execution_target=')&&call.values.includes('server'))).toBe(true);
 }
});
