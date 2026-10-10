/** 验证 Qwen 原生与 OpenRouter 配置、密钥隔离、响应校验、用量和取消行为。
 * 运行方式：由 Bun test 收集本文件用例；修改对应模块时针对该文件回归验证。
 */
import { expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { createQwenClient, QwenError, resolveQwenConfig, type QwenAnswerInput, type QwenErrorKind } from './qwen';

const env = { QWEN_API_KEY: 'test-only-secret' };
const config = { provider: 'qwen' as const, base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' };
const input: QwenAnswerInput = { config, question: '计算剩余应付金额。', materials: [{ name: '附件一', text: '应付100元，已付40元。' }] };
const routerConfig = { ...config, base_url: 'https://openrouter.ai/api/v1', model: 'qwen/qwen-plus' };
test('OpenRouter key alone resolves a Qwen gateway configuration without exposing the key', () => {
 expect(resolveQwenConfig({}, { OPEN_ROUTER_KEY: 'router-test-secret' })).toEqual(routerConfig);
});
test('blank environment template fields do not prevent OpenRouter key-only configuration', () => {
 expect(resolveQwenConfig({}, { OPEN_ROUTER_KEY: 'router-test-secret', QWEN_BASE_URL: '', QWEN_MODEL: '' })).toEqual(routerConfig);
});
test('OpenRouter uses only its own credential and preserves gateway usage cost', async () => {
 const result = await createQwenClient({ ...env, OPEN_ROUTER_KEY: 'router-test-secret' }, async (url, init) => {
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer router-test-secret');
  const body = JSON.parse(init!.body as string);
  expect(body.model).toBe('qwen/qwen-plus'); expect(body).not.toHaveProperty('enable_thinking');
  expect(body.reasoning).toEqual({ enabled: false }); expect(body.provider).toEqual({ require_parameters: true });
  return Response.json({ ...answer, model: 'qwen/qwen-plus', usage: { ...answer.usage, cost: 0.0001 } });
 }).answer({ ...input, config: { ...routerConfig, enable_thinking: false } });
 expect(result.usage?.cost).toBe(0.0001);
});
test('OpenRouter credentials never go to an Alibaba endpoint', async () => {
 let calls = 0;
 await failure(() => createQwenClient({ OPEN_ROUTER_KEY: 'router-test-secret' }, async () => { calls++; return Response.json(answer); }).answer(input), 'configuration');
 expect(calls).toBe(0);
});
test('Alibaba credentials never go to the gateway when its key is missing', async () => {
 let calls = 0;
 await failure(() => createQwenClient(env, async () => { calls++; return Response.json(answer); }).answer({ ...input, config: routerConfig }), 'configuration');
 expect(calls).toBe(0);
});
for (const model of ['qwen-plus', 'openai/gpt-5', 'qwen/']) test(`rejects non-Qwen or malformed gateway model ${model}`, () => {
 expect(() => resolveQwenConfig({ ...routerConfig, model }, {})).toThrow(QwenError);
});
for (const [status, kind] of [[402, 'quota'], [408, 'timeout'], [429, 'rate_limit']] as const) test(`classifies OpenRouter numeric error ${status}`, async () => {
 const error = await failure(() => createQwenClient({ OPEN_ROUTER_KEY: 'router-test-secret' }, async () => Response.json({ error: { code: status, message: 'private gateway message' } }, { status })).answer({ ...input, config: routerConfig }), kind);
 expect(error.provider_code).toBe(String(status)); expect(inspect(error)).not.toContain('private gateway message');
});
const answer = { id: 'chatcmpl-fixture', model: 'qwen-plus-actual', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '  剩余60元。\n' } }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26, prompt_tokens_details: { cached_tokens: 0 } } };

async function failure(run: () => Promise<unknown>, kind: QwenErrorKind) {
 try { await run(); } catch (error) {
  expect(error).toBeInstanceOf(QwenError);
  const value = error as QwenError;
  expect(value.kind).toBe(kind);
  return value;
 }
 throw new Error(`Expected ${kind} failure`);
}

test('config resolves explicit server environment into a secret-free snapshot', () => {
 const result = resolveQwenConfig({}, { ...env, QWEN_BASE_URL: config.base_url + '/', QWEN_MODEL: 'qwen-plus' });
 expect(result).toEqual(config);
 expect(inspect(result)).not.toContain(env.QWEN_API_KEY);
});
test('explicit settings override defaults and preserve false', () => {
 expect(resolveQwenConfig({ ...config, enable_thinking: false, max_tokens: 9000 }, { QWEN_BASE_URL: 'invalid', QWEN_MODEL: 'other' })).toEqual({ ...config, enable_thinking: false, max_tokens: 9000 });
});
for (const field of ['model', 'base_url']) test(`explicit null ${field} cannot silently switch to an environment default`, () => {
 expect(() => resolveQwenConfig({ ...config, [field]: null }, { QWEN_BASE_URL: config.base_url, QWEN_MODEL: config.model })).toThrow(QwenError);
});
test('rejects a non-assistant response rather than accepting a returned user message', async () => {
 await failure(() => createQwenClient(env, async () => Response.json({ ...answer, choices: [{ ...answer.choices[0], message: { role: 'user', content: input.question } }] })).answer(input), 'invalid_response');
});
test('successful requests remove the external cancellation listener', async () => {
 const external = new AbortController(); let signal: AbortSignal | null | undefined;
 await createQwenClient(env, async (_url, init) => { signal = init?.signal; return Response.json(answer); }).answer({ ...input, signal: external.signal });
 external.abort();
 expect(signal?.aborted).toBe(false);
});
test('timeout aborts a request that has not returned headers', async () => {
 let aborted = false;
 const client = createQwenClient(env, async (_url, init) => {
  return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('private transport error')); }, { once: true }));
 });
 const error = await failure(() => client.answer({ ...input, timeout_ms: 20 }), 'timeout');
 expect(aborted).toBe(true); expect(error.retryable).toBe(true); expect(inspect(error)).not.toContain('private transport error');
});
for (const base_url of [
 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
 'https://workspace123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
 'https://workspace123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
 'https://workspace123.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
 'https://workspace123.us-east-1.maas.aliyuncs.com/compatible-mode/v1',
]) test(`supports documented regional endpoint ${new URL(base_url).hostname}`, () => {
 expect(resolveQwenConfig({ ...config, base_url }, {}).base_url).toBe(base_url);
});
for (const raw of [null, [], {}, { ...config, model: '' }, { ...config, model: 'qwen plus' }, { ...config, provider: 'codex' }, { ...config, reasoning_effort: 'high' }, { ...config, api_key: 'must-not-snapshot' }, { ...config, enable_thinking: 'false' }, { ...config, max_tokens: 0 }, { ...config, max_tokens: 1.5 }]) test(`rejects invalid config ${JSON.stringify(raw)}`, () => {
 expect(() => resolveQwenConfig(raw, {})).toThrow(QwenError);
});
for (const base_url of [
 'http://dashscope.aliyuncs.com/compatible-mode/v1',
 'https://example.com/compatible-mode/v1',
 'https://dashscope.aliyuncs.com.evil.test/compatible-mode/v1',
 'https://secret@dashscope.aliyuncs.com/compatible-mode/v1',
 'https://dashscope.aliyuncs.com/compatible-mode/v1?secret=test',
 'https://dashscope.aliyuncs.com/compatible-mode/v1#secret',
 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
 'https://dashscope.aliyuncs.com:8443/compatible-mode/v1',
 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
]) test(`rejects unsafe or incomplete endpoint ${base_url}`, () => {
 expect(() => resolveQwenConfig({ ...config, base_url }, {})).toThrow(QwenError);
});

test('sends only question and selected text materials, with no SDK, history or tools', async () => {
 const client = createQwenClient(env, async (url, init) => {
  expect(url).toBe(config.base_url + '/chat/completions');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + env.QWEN_API_KEY);
  expect(init?.redirect).toBe('error');
  const body = JSON.parse(init!.body as string);
  expect(body).toEqual({ model: config.model, stream: false, enable_thinking: false, max_tokens: 9000, messages: [{ role: 'user', content: JSON.stringify({ question: input.question, materials: input.materials }) }] });
  return Response.json(answer);
 });
 const result = await client.answer({ ...input, config: { ...config, enable_thinking: false, max_tokens: 9000 } });
 expect(result.text).toBe(answer.choices[0].message.content);
 expect(result.usage).toEqual(answer.usage);
 expect(result.model).toBe(answer.model);
 expect(result.requested_model).toBe(config.model);
 expect(result.completion_id).toBe(answer.id);
 expect(result.request_id).toBeNull();
 expect(Number.isFinite(Date.parse(result.started_at))).toBe(true);
 expect(Date.parse(result.finished_at)).toBeGreaterThanOrEqual(Date.parse(result.started_at));
 expect(result.duration_ms).toBeGreaterThanOrEqual(0);
 expect(inspect(result)).not.toContain(env.QWEN_API_KEY);
});
test('does not guess usage or actual model when the provider omits them', async () => {
 const result = await createQwenClient(env, async (_url, init) => {
  const body = JSON.parse(init!.body as string);
  expect(body).not.toHaveProperty('enable_thinking');
  expect(body).not.toHaveProperty('max_tokens');
  return Response.json({ choices: answer.choices });
 }).answer(input);
 expect(result.usage).toBeNull(); expect(result.model).toBeNull(); expect(result.completion_id).toBeNull();
});
test('takes the provider request ID from the header rather than inventing one from completion ID', async () => {
 const id = '649b2bbc-c541-9e16-9845-db7fe4fe5b2d';
 const result = await createQwenClient(env, async () => Response.json(answer, { headers: { 'x-request-id': id } })).answer(input);
 expect(result.request_id).toBe(id);
});
test('uses DASHSCOPE_API_KEY when the project-specific key is absent', async () => {
 await createQwenClient({ DASHSCOPE_API_KEY: 'dashscope-test-secret' }, async (_url, init) => {
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer dashscope-test-secret'); return Response.json(answer);
 }).answer(input);
});
test('reads a refreshed credential at the next invocation', async () => {
 const credentials = { ...env }; const used: (string | null)[] = [];
 const client = createQwenClient(credentials, async (_url, init) => { used.push(new Headers(init?.headers).get('Authorization')); return Response.json(answer); });
 await client.answer(input); credentials.QWEN_API_KEY = 'refreshed-test-secret'; await client.answer(input);
 expect(used).toEqual(['Bearer test-only-secret', 'Bearer refreshed-test-secret']);
});
for (const credentials of [{}, { QWEN_API_KEY: ' ' }, { QWEN_API_KEY: 'bad\nheader' }]) test(`invalid credentials never send a request ${JSON.stringify(credentials)}`, async () => {
 let calls = 0;
 await failure(() => createQwenClient(credentials, async () => { calls++; return Response.json(answer); }).answer(input), 'configuration');
 expect(calls).toBe(0);
});
for (const extra of [{ rubric: 'private rubric' }, { reference_answer: 'private answer' }, { target_score: 0 }, { mapping: 'private mapping' }, { messages: [] }, { tools: [] }]) test(`rejects unexpected answer input ${Object.keys(extra)[0]}`, async () => {
 let calls = 0;
 await failure(() => createQwenClient(env, async () => { calls++; return Response.json(answer); }).answer({ ...input, ...extra }), 'configuration');
 expect(calls).toBe(0);
});
for (const changed of [
 { question: '' }, { materials: [{ name: 'file', text: '' }] }, { materials: [{ name: 'file', text: 5 }] },
 { materials: [{ name: 'file', text: 'public', path: '/private/source.pdf' }] }, { materials: [{ name: 'file', image_url: 'data:private' }] },
 { materials: 'not an array' }, { timeout_ms: 0 }, { timeout_ms: 0.5 }, { timeout_ms: 2147483648 }, { signal: {} },
]) test(`rejects unsupported input ${JSON.stringify(changed)}`, async () => {
 let calls = 0;
 await failure(() => createQwenClient(env, async () => { calls++; return Response.json(answer); }).answer({ ...input, ...changed } as QwenAnswerInput), 'configuration');
 expect(calls).toBe(0);
});

const errors: [number, string, QwenErrorKind, boolean][] = [
 [401, 'invalid_api_key', 'authentication', false], [403, 'AccessDenied', 'authentication', false],
 [400, 'Arrearage', 'quota', false], [429, 'PrepaidBillOverdue', 'quota', false],
 [429, 'Throttling.RateQuota', 'rate_limit', true], [429, 'Throttling.AllocationQuota', 'rate_limit', true],
 [429, 'insufficient_quota', 'rate_limit', true], [429, 'Throttling', 'rate_limit', true],
 [400, 'InvalidParameter', 'configuration', false], [404, 'model_not_supported', 'configuration', false],
 [500, 'InternalError', 'provider', true], [503, 'ServiceUnavailable', 'provider', true],
];
for (const [status, code, kind, retryable] of errors) test(`HTTP ${status} ${code} returns ${kind} without leaking or retrying`, async () => {
 let calls = 0;
 const error = await failure(() => createQwenClient(env, async () => {
  calls++; return Response.json({ error: { code, message: 'private body ' + env.QWEN_API_KEY + ' ' + input.question }, request_id: '649b2bbc-c541-9e16-9845-db7fe4fe5b2d' }, { status });
 }).answer(input), kind);
 expect(error.retryable).toBe(retryable); expect(error.http_status).toBe(status); expect(error.provider_code).toBe(code);
 expect(error.request_id).toBe('649b2bbc-c541-9e16-9845-db7fe4fe5b2d'); expect(calls).toBe(1);
 expect(inspect(error)).not.toContain('private body'); expect(inspect(error)).not.toContain(env.QWEN_API_KEY); expect(inspect(error)).not.toContain(input.question);
});
test('unknown provider diagnostics are discarded, including arbitrary code and request ID', async () => {
 const error = await failure(() => createQwenClient(env, async () => Response.json({ error: { code: env.QWEN_API_KEY, message: input.question }, request_id: input.question }, { status: 418, headers: { 'x-request-id': env.QWEN_API_KEY } })).answer(input), 'provider');
 expect(error.provider_code).toBeNull(); expect(error.request_id).toBeNull(); expect(error.retryable).toBe(false);
 expect(inspect(error)).not.toContain(env.QWEN_API_KEY); expect(inspect(error)).not.toContain(input.question);
});
test('plain-text HTTP errors are classified by status without exposing body', async () => {
 const error = await failure(() => createQwenClient(env, async () => new Response(env.QWEN_API_KEY, { status: 502 })).answer(input), 'provider');
 expect(error.http_status).toBe(502); expect(error.retryable).toBe(true); expect(inspect(error)).not.toContain(env.QWEN_API_KEY);
});
test('does not turn a network failure containing secrets into a logged error cause', async () => {
 const error = await failure(() => createQwenClient(env, async () => { throw new Error(env.QWEN_API_KEY + input.question); }).answer(input), 'network');
 expect(error.retryable).toBe(true); expect(error.cause).toBeUndefined();
 expect(inspect(error)).not.toContain(env.QWEN_API_KEY); expect(inspect(error)).not.toContain(input.question);
});
for (const data of [null, {}, { choices: [] }, { choices: [{ finish_reason: 'stop', message: { content: ' ' } }] }, { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, { choices: [{ finish_reason: 'tool_calls', message: { content: 'text' } }] }, { choices: [{ message: { content: 'unfinished' } }] }, { choices: [{ finish_reason: 'content_filter', message: { content: 'partial' } }] }, { ...answer, choices: [answer.choices[0], answer.choices[0]] }, { ...answer, usage: 'bad usage' }, { ...answer, choices: [{ ...answer.choices[0], message: { content: 'text', tool_calls: [{ id: 'tool' }] } }] }]) test(`rejects incomplete or malformed answers ${JSON.stringify(data)}`, async () => {
 await failure(() => createQwenClient(env, async () => Response.json(data)).answer(input), 'invalid_response');
});
test('rejects malformed JSON without preserving parser text', async () => {
 const error = await failure(() => createQwenClient(env, async () => new Response('private invalid JSON ' + env.QWEN_API_KEY)).answer(input), 'invalid_response');
 expect(inspect(error)).not.toContain(env.QWEN_API_KEY);
});
test('already cancelled work never invokes the provider', async () => {
 let calls = 0;
 const error = await failure(() => createQwenClient(env, async () => { calls++; return Response.json(answer); }).answer({ ...input, signal: AbortSignal.abort(new Error(env.QWEN_API_KEY)) }), 'cancelled');
 expect(calls).toBe(0); expect(error.retryable).toBe(false); expect(inspect(error)).not.toContain(env.QWEN_API_KEY);
});
test('cancellation aborts an in-flight request without returning a late answer', async () => {
 const controller = new AbortController(); let observedAbort = false;
 const client = createQwenClient(env, async (_url, init) => {
  const signal = init!.signal!;
  const waiting = new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => { observedAbort = true; reject(signal.reason); }, { once: true }));
  controller.abort(new Error('private cancellation reason'));
  return await waiting;
 });
 const error = await failure(() => client.answer({ ...input, signal: controller.signal }), 'cancelled');
 expect(observedAbort).toBe(true); expect(inspect(error)).not.toContain('private cancellation reason');
});
test('timeout covers a stalled response body using native fetch', async () => {
 let aborted = false;
 const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  request.signal.addEventListener('abort', () => { aborted = true; });
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"choices":')); } }), { headers: { 'Content-Type': 'application/json' } });
 } });
 try {
  const client = createQwenClient(env, async (_url, init) => await fetch(server.url, init));
  const started = performance.now();
  const error = await failure(() => client.answer({ ...input, timeout_ms: 80 }), 'timeout');
  expect(error.retryable).toBe(true); expect(performance.now() - started).toBeLessThan(1500);
  // Bun may deliver the server-side disconnect notification after the client rejection.
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(aborted).toBe(true);
 } finally { server.stop(true); }
});
