// Run the real scheduler in a fresh process against an isolated verification schema.
import {createPool} from '../server/db';
import {runAutomationTick} from '../server/automation/jobs';
import type {Pool} from 'pg';
const [schema,root]=process.argv.slice(2);
if(!/^test_automation_[a-f0-9]{32}$/.test(schema??'')||!root)throw new Error('Isolated fixture schema and root required');
const source=createPool();
const transform=(sql:string)=>sql.replaceAll('ai_distill',schema);
const pool={query:async(sql:string,values?:unknown[])=>{try{return await source.query(transform(sql),values);}catch(error){throw error;}},connect:async()=>{
 try{const db=await source.connect();return {query:async(sql:string,values?:unknown[])=>{try{return await db.query(transform(sql),values);}catch(error){throw error;}},release:()=>db.release()};}catch(error){throw error;}
}} as unknown as Pool;
try{await runAutomationTick(pool,root);}finally{await source.end();}
