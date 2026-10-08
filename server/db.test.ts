import{test,expect}from'bun:test';
import{createPool}from'./db';
test('database URL is required',()=>{expect(()=>createPool({})).toThrow('DATABASE_URL');});
test('database configuration verifies TLS and retains channel binding',async()=>{
 const pool=createPool({DATABASE_URL:'postgresql://test:test@example.invalid/test?sslmode=require&channel_binding=require'});
 try{expect(pool.options.ssl).toEqual({rejectUnauthorized:true});expect(pool.options.enableChannelBinding).toBe(true);expect(pool.options.max).toBe(4);expect(pool.options.connectionString).not.toContain('sslmode');expect(pool.options.connectionString).not.toContain('channel_binding');}finally{await pool.end();}
});
