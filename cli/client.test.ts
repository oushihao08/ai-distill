/** CLI HTTP 边界测试：本机限制、响应异常和写请求不重试；全部使用注入 fetch，不连接业务环境。 */
import {describe, expect, test} from 'bun:test';
import {ApiClient, CliError} from './client';
import {
  atomicWriteJson,
  fetchAllProjectWorkflowItems,
  mapWithConcurrency,
  parseStrictFlagPairs,
  withExclusiveFileLock,
  writeExclusiveJson,
} from './shared';
import {mkdtemp,readFile,readdir,stat,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

describe('本机 API 客户端', () => {
  test('容量拒绝明确表示未派发，保留容量回执且不重试',async()=>{
    let calls=0;const client=new ApiClient(undefined,async()=>{calls++;return Response.json({error:'本机待领取容量不足，未派发',code:'local_queue_full',dispatched:false,lane:'agent',limit:4,waiting:4,requested:1},{status:429});});
    try{await client.json('/api/workflows/one/author','POST',{});throw new Error('expected failure');}
    catch(error){expect(error).toBeInstanceOf(CliError);expect((error as CliError).detail).toMatchObject({code:'local_queue_full',outcome_unknown:false,dispatched:false,lane:'agent',limit:4});}
    expect(calls).toBe(1);
  });
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

// 下载落盘契约：精确字节、私有权限、不覆盖，以及HTTP/文件错误分离。
test('下载到文件保留字节和权限，失败不覆盖或创建伪产物',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cli-download-contract-'));
 const payload=new Uint8Array([0,1,127,128,255]);let calls=0;
 const client=new ApiClient(undefined,async()=>{calls++;return new Response(payload);});
 const out=join(root,'结果.bin');
 try{
  expect(await client.downloadTo('/api/artifacts/a/download',out)).toEqual({path:out,bytes:5});
  expect(new Uint8Array(await readFile(out))).toEqual(payload);
  expect((await stat(out)).mode&0o777).toBe(0o600);
  await expect(client.downloadTo('/api/artifacts/a/download',out)).rejects.toMatchObject({detail:{kind:'file_error'}});
  expect(new Uint8Array(await readFile(out))).toEqual(payload);
  await expect(client.downloadTo('/api/artifacts/a/download',join(root,'missing','out'))).rejects.toMatchObject({detail:{kind:'file_error'}});
  expect(calls).toBe(3);
  const failed=new ApiClient(undefined,async()=>new Response('private error',{status:404}));
  const missing=join(root,'not-created');
  await expect(failed.downloadTo('/api/artifacts/a/download',missing)).rejects.toMatchObject({detail:{kind:'http_error',http_status:404}});
  await expect(stat(missing)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});

describe('CLI 共用基础设施 (cli/shared.ts)', () => {
  test('writeExclusiveJson、atomicWriteJson 与 withExclusiveFileLock 保证 0600 独占、原子替换不留临时文件且互斥保护', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-shared-fs-'));
    try {
      const target = join(root, 'state.json');
      await writeExclusiveJson(target, { step: 1 }, '文件已存在');
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      await expect(writeExclusiveJson(target, { step: 2 }, '文件已存在')).rejects.toThrow('文件已存在');

      await atomicWriteJson(target, { step: 2, ok: true });
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ step: 2, ok: true });
      expect((await readdir(root)).filter((f: string) => f.endsWith('.tmp'))).toEqual([]);

      const lockPath = `${target}.lock`;
      await writeFile(lockPath, 'busy');
      await expect(withExclusiveFileLock(lockPath, async () => 1, { busyMessage: '锁占用' })).rejects.toThrow('锁占用');
      await rm(lockPath);
      const lockedValue = await withExclusiveFileLock(lockPath, async () => {
        expect((await readdir(root)).includes('state.json.lock')).toBe(true);
        return 42;
      });
      expect(lockedValue).toBe(42);
      expect((await readdir(root)).includes('state.json.lock')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('mapWithConcurrency 严格保持输入顺序，并在首错或中断后停止领取剩余项', async () => {
    const ordered = await mapWithConcurrency([30, 5, 15, 1], 2, async (delay, idx) => {
      await new Promise((r) => setTimeout(r, delay));
      return `${idx}:${delay}`;
    });
    expect(ordered).toEqual(['0:30', '1:5', '2:15', '3:1']);

    const seen: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4], 2, async (n) => {
        seen.push(n);
        if (n === 1) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 15));
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(seen.includes(4)).toBe(false);
  });

  test('fetchAllProjectWorkflowItems 完整翻页并校验 UUID，parseStrictFlagPairs 拒绝重复与缺值', async () => {
    const w1 = '00000000-0000-4000-8000-000000000011';
    const w2 = '00000000-0000-4000-8000-000000000012';
    const requestedPaths: string[] = [];
    const items = await fetchAllProjectWorkflowItems(
      async (path) => {
        requestedPaths.push(path);
        return path.includes('page=1')
          ? { items: [{ id: w1, workflow_kind: 'question' }], has_more: true }
          : { items: [{ id: w2, workflow_kind: 'question' }], has_more: false };
      },
      '00000000-0000-4000-8000-000000000001',
      { kind: 'question', pageSize: 1 },
    );
    expect(items.map((x) => x.id)).toEqual([w1, w2]);
    expect(requestedPaths[0]).toContain('kind=question&page=1&page_size=1');

    const flags = parseStrictFlagPairs(['--workflow', w1, '--request-key', w2], '参数错误');
    expect(flags.get('workflow')).toBe(w1);
    expect(() => parseStrictFlagPairs(['--workflow', w1, '--workflow', w2], '参数错误')).toThrow('参数错误');
    expect(() => parseStrictFlagPairs(['--workflow'], '参数错误')).toThrow('参数错误');
  });
});
