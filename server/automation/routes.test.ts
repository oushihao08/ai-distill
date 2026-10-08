import {test,expect} from 'bun:test';
import {createApp} from '../app';
const project='11111111-1111-4111-8111-111111111111';
test('automation writes retain local-origin gate before touching database',async()=>{
 let queries=0;const app=createApp({query:async()=>{queries++;throw new Error('unexpected database access');}} as any,'/tmp/unused');
 const response=await app.request(`/api/projects/${project}/automation`,{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:JSON.stringify({mode:'horizontal'})});
 expect(response.status).toBe(403);expect(queries).toBe(0);
});
test('invalid automation body and invalid executor are explicit client errors',async()=>{
 const app=createApp({} as any,'/tmp/unused');
 expect((await app.request(`/api/projects/${project}/automation`,{method:'POST',body:'{'})).status).toBe(400);
 expect((await app.request('/api/executor-blocks/not-real/resume',{method:'POST'})).status).toBe(400);
});
