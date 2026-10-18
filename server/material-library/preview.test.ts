/** 职责：验证材料预览按对象身份限定查询、文本摘要校验和失败结果隔离；不读取业务原文或调用模型。 */
import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {readLibraryDocuments,readLibraryOriginal,readLibraryRedactionPreview} from './preview';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
test('document summary omits body; single-file preview verifies structure and text digests',async()=>{
 const content=JSON.stringify({version:1,pages:[{page:1,text:'合成正文',issues:[]}]});
 const queries:{sql:string;values:unknown[]}[]=[];
 const pool={query:async(sql:string,values:unknown[])=>{queries.push({sql,values});return{rows:sql.startsWith('SELECT j.id')?[{id:'job'}]:[{id:'doc',file_id:'file',original_name:'合成.txt',issues:[],text_sha256:hash('合成正文'),text_content:content,sha256:hash(content)}]};}} as any;
 expect((await readLibraryDocuments(pool,'revision','job')).items[0]).not.toHaveProperty('pages');
 expect((await readLibraryDocuments(pool,'revision','job','file')).items[0]).toMatchObject({pages:[{page:1,text:'合成正文'}]});
 expect(queries[0]?.sql).toContain("j.status='succeeded'");
 expect(queries.at(-1)?.values).toEqual(['revision','job','file']);
});
test('redaction preview rejects changed content and hides storage identity',async()=>{
 let content='合成正文';const pool={query:async()=>({rows:[{id:'r',text_content:content,sha256:hash('合成正文')}]})} as any;
 expect(await readLibraryRedactionPreview(pool,'r')).toEqual({id:'r',markdown:'合成正文'});
 content='改变后的正文';await expect(readLibraryRedactionPreview(pool,'r')).rejects.toThrow('摘要校验失败');
});
test('wrong or absent object identity cannot expose arbitrary blobs',async()=>{
 const pool={query:async()=>({rows:[]})} as any;
 await expect(readLibraryOriginal(pool,'/tmp/unused','unknown')).rejects.toThrow('不存在');
 await expect(readLibraryDocuments(pool,'wrong-revision','wrong-job')).rejects.toThrow('不存在');
 await expect(readLibraryRedactionPreview(pool,'unknown')).rejects.toThrow('不存在');
});
