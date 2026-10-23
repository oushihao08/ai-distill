/** HTTP上传预算回归：临时随机端口Bun/Hono服务与合成流；不加载业务入口、连接数据库或读取原件。 */
import {test,expect} from 'bun:test';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {MAX_FOLDER_BATCH,MAX_DEFAULT_REQUEST_BYTES,MAX_UPLOAD_REQUEST_BYTES,requestBodyLimit} from './validation';
const path='/api/material-library/packages/11111111-1111-4111-8111-111111111111/revisions';
function app(){const app=new Hono();app.use('/api/*',(c,next)=>bodyLimit({maxSize:requestBodyLimit(c.req.path,c.req.method)})(c,next));app.post('*',async c=>c.json({bytes:(await c.req.arrayBuffer()).byteLength}));return app;}
test('only library revision uploads get the 200MiB business allowance plus framing',async()=>{
 expect(MAX_UPLOAD_REQUEST_BYTES).toBe(MAX_FOLDER_BATCH+1024*1024);
 expect(requestBodyLimit(path,'POST')).toBe(MAX_UPLOAD_REQUEST_BYTES);
 for(const [p,m] of [[path,'PUT'],['/api/projects/a/workflows','POST'],['/api/material-library/packages','POST']])expect(requestBodyLimit(p!,m!)).toBe(MAX_DEFAULT_REQUEST_BYTES);
 const rejected=await app().request(path,{method:'POST',headers:{'Content-Length':String(MAX_UPLOAD_REQUEST_BYTES+1)},body:'x'});expect(rejected.status).toBe(413);
 const ordinary=await app().request('/api/projects/a/workflows',{method:'POST',headers:{'Content-Length':String(MAX_DEFAULT_REQUEST_BYTES+1)},body:'x'});expect(ordinary.status).toBe(413);
});
test('actual Bun transport accepts a streamed upload above the previous 101MiB ceiling',async()=>{
 const a=app(),server=Bun.serve({hostname:'127.0.0.1',port:0,maxRequestBodySize:MAX_UPLOAD_REQUEST_BYTES,fetch:a.fetch});
 try{
  const bytes=102*1024*1024,chunk=new Uint8Array(64*1024);let left=bytes;
  const body=new ReadableStream<Uint8Array>({pull(controller){if(left<=0){controller.close();return;}const size=Math.min(left,chunk.length);controller.enqueue(chunk.subarray(0,size));left-=size;}});
  const response=await fetch(`http://127.0.0.1:${server.port}${path}`,{method:'POST',body});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({bytes});
 }finally{await server.stop(true);}
},15000);
