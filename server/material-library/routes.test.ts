/**
 * 职责：验证材料库 HTTP 路由在进入数据库与文件处理前执行记录身份、版本及请求格式校验。
 * 入口：`bun test server/material-library/routes.test.ts`；使用 Hono 内存请求和拒绝数据库替身。
 * 边界：不连接业务数据库、不写入材料、不调用模型；业务事务与产物内容由各 service 测试负责。
 */
import {describe,expect,test} from 'bun:test';
import {Hono} from 'hono';
import {registerMaterialLibraryRoutes} from './routes';

function app(){
 const instance=new Hono();
 const pool={query:async()=>{throw new Error('输入校验失败时不得访问数据库');}};
 registerMaterialLibraryRoutes(instance,pool as any,'/tmp/material-library-route-test');
 return instance;
}

describe('材料库 HTTP 路由输入边界',()=>{
 test('所有直接使用记录ID的入口在访问数据库前拒绝无效ID',async()=>{
  const cases:[string,string,RequestInit?][]=[
   ['GET','/api/material-library/files/not-an-id/content'],
   ['GET','/api/material-library/files/not-an-id/preview'],
   ['GET','/api/material-library/packages/not-an-id'],
   ['GET','/api/material-library/packages/not-an-id/usage'],
   ['GET','/api/material-library/packages/not-an-id/revisions'],
   ['GET','/api/material-library/jobs/not-an-id'],
   ['POST','/api/material-library/jobs/not-an-id/cancel'],
   ['POST','/api/material-library/redactions/not-an-id/revalidate'],
   ['GET','/api/material-library/redactions/not-an-id/preview'],
   ['GET','/api/material-library/revisions/not-an-id/documents?extraction_job_id=11111111-1111-4111-8111-111111111111'],
   ['POST','/api/material-library/revisions/not-an-id/jobs',{headers:{'content-type':'application/json'},body:'{}'}],
   ['POST','/api/material-library/revisions/not-an-id/prepared-redactions',{headers:{'content-type':'application/json'},body:'{}'}],
   ['POST','/api/material-library/revisions/not-an-id/mineru-extractions',{headers:{'content-type':'application/json'},body:'{}'}],
  ];
  for(const [method,path,init] of cases){
   const response=await app().request(path,{...init,method});
   expect(response.status,`${method} ${path}`).toBe(400);
   expect(await response.text()).toContain('无效的记录ID');
  }
 });

 test('版本化修改必须携带有效If-Match且不会先访问数据库',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  for(const [method,path] of [['PATCH',`/api/material-library/packages/${id}`],['DELETE',`/api/material-library/packages/${id}`],['POST',`/api/material-library/packages/${id}/restore`]]){
   const missing=await app().request(path,{method,headers:{'content-type':'application/json'},body:method==='PATCH'?'{}':undefined});
   expect(missing.status).toBe(428);
   const invalid=await app().request(path,{method,headers:{'If-Match':'not-a-version','content-type':'application/json'},body:method==='PATCH'?'{}':undefined});
   expect(invalid.status).toBe(400);
  }
  const revision=await app().request(`/api/material-library/packages/${id}/revisions`,{method:'POST'});
  expect(revision.status).toBe(428);
 });

 test('JSON与multipart入口拒绝错误传输格式和缺失必要字段',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const malformed=await app().request(`/api/material-library/revisions/${id}/jobs`,{method:'POST',headers:{'content-type':'application/json'},body:'{'});
  expect(malformed.status).toBe(400);expect(await malformed.text()).toContain('有效JSON');
  const plainImport=await app().request('/api/material-library/imports',{method:'POST',headers:{'content-type':'text/plain'},body:'not multipart'});
  expect(plainImport.status).toBe(400);
  const emptyForm=new FormData();
  const incomplete=await app().request('/api/material-library/imports',{method:'POST',body:emptyForm});
  expect(incomplete.status).toBe(400);expect(await incomplete.text()).toContain('缺少导入名称或request_key');
  const invalidProvider=new FormData();invalidProvider.set('name','测试包');invalidProvider.set('request_key','11111111-1111-4111-8111-111111111111');invalidProvider.set('pdf_provider','unknown');
  const rejectedProvider=await app().request('/api/material-library/imports',{method:'POST',body:invalidProvider});
  expect(rejectedProvider.status).toBe(400);expect(await rejectedProvider.text()).toContain('PDF OCR provider 仅支持MinerU');
  const retired=await app().request('/api/material-library/packages',{method:'POST'});
  expect(retired.status).toBe(410);
 });

 test('保图参数与逐文件判断标记在入库前校验',async()=>{
  const base=()=>{const form=new FormData();form.set('name','医疗材料');form.set('request_key','11111111-1111-4111-8111-111111111111');form.append('files',new File(['正文'],'source.txt',{type:'text/plain'}));return form;};
  const wrongFlag=base();wrongFlag.set('preserve_images','yes');
  const response=await app().request('/api/material-library/imports',{method:'POST',body:wrongFlag});
  expect(response.status).toBe(400);expect(await response.text()).toContain('preserve_images');
  const wrongCount=base();wrongCount.set('preserve_images','true');wrongCount.set('image_review_files','[true,false]');
  const count=await app().request('/api/material-library/imports',{method:'POST',body:wrongCount});
  expect(count.status).toBe(400);expect(await count.text()).toContain('逐项对应');
 });

 test('文书读取同时校验版本ID、提取任务ID和可选文件ID',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const missing=await app().request(`/api/material-library/revisions/${id}/documents`);
  expect(missing.status).toBe(400);expect(await missing.text()).toContain('请选择成功的提取任务');
  const badJob=await app().request(`/api/material-library/revisions/${id}/documents?extraction_job_id=bad`);
  expect(badJob.status).toBe(400);
  const badFile=await app().request(`/api/material-library/revisions/${id}/documents?extraction_job_id=${id}&file_id=bad`);
  expect(badFile.status).toBe(400);
 });
});
