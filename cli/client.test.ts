/** CLI HTTP 边界测试：本机限制、响应异常和写请求不重试；全部使用注入 fetch，不连接业务环境。 */
import {describe, expect, test} from 'bun:test';
import {ApiClient, CliError} from './client';

describe('本机 API 客户端', () => {
  test('JSON和multipart共享成功、HTTP错误及无效响应契约', async () => {
    for (const multipart of [false, true]) {
      for (const scenario of ['success', 'http', 'invalid'] as const) {
        let calls = 0;
        const client = new ApiClient(undefined, async () => {
          calls++;
          if (scenario === 'success') return Response.json({id:'attempt-1'});
          if (scenario === 'http') return Response.json({error:'输入不合法'}, {status:409,headers:{'X-Request-ID':'request-form'}});
          return new Response('private response');
        });
        const invoke = () => multipart ? client.form('/api/upload', 'POST', new FormData()) : client.json('/api/upload', 'POST', {});
        if (scenario === 'success') expect(await invoke()).toEqual({id:'attempt-1'});
        else {
          let captured:unknown;
          try { await invoke(); } catch (error) { captured=error; }
          expect(captured).toBeInstanceOf(CliError);
          expect((captured as CliError).detail).toMatchObject({kind:scenario==='http'?'http_error':'invalid_response',http_status:scenario==='http'?409:200,outcome_unknown:true});
          if (scenario === 'http') expect((captured as CliError).detail.request_id).toBe('request-form');
          expect(String(captured)).not.toContain('private response');
        }
        expect(calls).toBe(1);
      }
    }
  });
  test('拒绝远程、带凭证、非 HTTP 和带路径的地址', () => {
    for (const url of ['https://example.com', 'http://user:pass@localhost', 'file:///tmp/api', 'http://localhost/foo']) {
      expect(() => new ApiClient(url)).toThrow();
    }
  });
  test('拒绝重定向，避免向远程转发', async () => {
    const client = new ApiClient(undefined, async (_url, init) => {
      expect(init?.redirect).toBe('error');
      return Response.json({ok: true});
    });
    expect(await client.json('/api/health')).toEqual({ok: true});
  });
  test('空响应保留 HTTP 状态与请求关联号', async () => {
    const client = new ApiClient(undefined, async () => new Response('', {status: 502, headers: {'X-Request-ID':'request-1'}}));
    try { await client.json('/api/health'); throw new Error('expected failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).detail).toMatchObject({kind:'http_error', http_status:502, request_id:'request-1'});
    }
  });
  test('200 非 JSON 不暴露响应原文', async () => {
    const client = new ApiClient(undefined, async () => new Response('private HTML'));
    await expect(client.json('/api/projects')).rejects.toThrow('响应不是有效 JSON');
  });
  test('写请求断开只尝试一次并标记结果未知', async () => {
    let calls = 0;
    const client = new ApiClient(undefined, async () => { calls++; throw new Error('secret endpoint'); });
    try { await client.json('/api/projects', 'POST', {}); } catch (error) {
      expect((error as CliError).detail).toMatchObject({kind:'network_error', outcome_unknown:true});
      expect(String(error)).not.toContain('secret endpoint');
    }
    expect(calls).toBe(1);
  });
});
