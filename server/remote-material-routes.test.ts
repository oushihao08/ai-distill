/** 验证远程作答 HTTP 的令牌、workflow/request key 绑定和多 attempt 状态聚合；使用 Pool 替身，不连接业务数据库或模型。 */
import {expect,test} from 'bun:test';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import {registerRemoteMaterialRoutes} from './remote-material-routes';

const token='t'.repeat(32);
const workflow='12345678-1234-4234-8234-123456789abc';
const requestKey='22345678-1234-4234-8234-123456789abc';
const ids=['32345678-1234-4234-8234-123456789abc','42345678-1234-4234-8234-123456789abc'];

function appFor(attempts:any[]){
 const calls:{sql:string;values?:unknown[]}[]=[];
 const pool={query:async(sql:string,values?:unknown[])=>{calls.push({sql,values});if(sql.includes("execution_target='server'")&&sql.includes("remote_request_key"))return{rows:attempts,rowCount:attempts.length};throw new Error(`unexpected query: ${sql}`);}} as unknown as Pool;
 const app=new Hono();app.onError(error=>Response.json({error:error.message},{status:'status' in error&&typeof error.status==='number'?error.status:500}));registerRemoteMaterialRoutes(app,pool,'.storage',token,true);return{app,calls};
}
const get=(app:Hono,w=workflow,key=requestKey,authorization=`Bearer ${token}`)=>app.request(`/api/remote-answer-operations/by-request?workflow_id=${w}&request_key=${key}`,{headers:{Authorization:authorization}});

test('by-request 只按精确 workflow/request key 查服务器作答',async()=>{
 const {app,calls}=appFor([{id:ids[0],status:'waiting',started_at:null,finished_at:null}]);const response=await get(app);expect(response.status).toBe(200);expect(await response.json()).toEqual({workflow_id:workflow,request_key:requestKey,status:'waiting',attempts:[{id:ids[0],status:'waiting',started_at:null,finished_at:null}]});expect(calls).toHaveLength(1);expect(calls[0]?.values).toEqual([workflow,requestKey]);
});

test('attempt 集合只在全部终结后返回终态，混合失败不冒充成功',async()=>{
 for(const [attempts,status] of [
  [[{id:ids[0],status:'succeeded'},{id:ids[1],status:'running'}],'running'],
  [[{id:ids[0],status:'succeeded'},{id:ids[1],status:'succeeded'}],'succeeded'],
  [[{id:ids[0],status:'succeeded'},{id:ids[1],status:'failed'}],'failed'],
  [[{id:ids[0],status:'skipped'},{id:ids[1],status:'skipped'}],'skipped'],
 ] as const){const response=await get(appFor([...attempts]).app);expect((await response.json() as any).status).toBe(status);}
});

test('缺失或错误令牌在访问数据前拒绝',async()=>{
 const fixture=appFor([{id:ids[0],status:'waiting'}]);for(const authorization of ['',`Bearer ${'x'.repeat(32)}`])expect((await get(fixture.app,workflow,requestKey,authorization)).status).toBe(401);expect(fixture.calls).toHaveLength(0);
});

test('无效或错位的查询身份不访问数据',async()=>{
 const fixture=appFor([{id:ids[0],status:'waiting'}]);for(const [w,key] of [['bad',requestKey],[workflow,'bad'],['',requestKey],[workflow,'']])expect((await get(fixture.app,w,key)).status).toBe(400);expect(fixture.calls).toHaveLength(0);
});

test('提交只接受精确 workflow/request key，不允许客户端覆盖执行语义',async()=>{
 const fixture=appFor([{id:ids[0],status:'waiting'}]),headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
 for(const body of ['{',JSON.stringify({workflow_id:workflow}),JSON.stringify({workflow_id:workflow,request_key:requestKey,execution_target:'local'}),JSON.stringify({workflow_id:workflow,request_key:5})]){
  const response=await fixture.app.request('/api/remote-answer-operations',{method:'POST',headers,body});
  expect(response.status).toBe(400);
 }
 expect(fixture.calls).toHaveLength(0);
});

test('不存在的精确请求返回404且不创建替代任务',async()=>{
 const fixture=appFor([]);const response=await get(fixture.app);expect(response.status).toBe(404);expect(fixture.calls).toHaveLength(1);expect(fixture.calls[0]?.sql).toContain('SELECT id,status,started_at,finished_at');
});
