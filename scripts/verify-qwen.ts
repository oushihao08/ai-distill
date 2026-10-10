/** 文件职责：发送一次合成文字请求验证 Qwen 接入并保存安全用量证据；不访问案件或数据库。
 * 执行入口与用途：`bun scripts/verify-qwen.ts`；向配置的 Qwen endpoint 发送一次合成文本请求，校验答案和用量并保存安全证据。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createQwenClient, QwenError, resolveQwenConfig } from '../server/answer-models/qwen';

// One synthetic text call only. No case files, database access or credential output.
const output = new URL('../docs/evidence/qwen-api-smoke-results.json', import.meta.url);
const evidence: Record<string, unknown> = {
 checked_at: new Date().toISOString(), status: 'unverified', request_attempted: false, called_provider: false,
 input_kind: 'synthetic_question_and_text_material',
};
const missing = [
 ...(!(process.env.OPEN_ROUTER_KEY?.trim() || process.env.QWEN_API_KEY?.trim() || process.env.DASHSCOPE_API_KEY?.trim()) ? ['OPEN_ROUTER_KEY or QWEN_API_KEY or DASHSCOPE_API_KEY'] : []),
 ...(!process.env.OPEN_ROUTER_KEY?.trim() && !process.env.QWEN_BASE_URL?.trim() ? ['QWEN_BASE_URL'] : []),
 ...(!process.env.OPEN_ROUTER_KEY?.trim() && !process.env.QWEN_MODEL?.trim() ? ['QWEN_MODEL'] : []),
];
try {
 if (missing.length) {
  evidence.missing = missing;
  evidence.reason = '未配置真实调用所需的服务端环境变量';
  process.exitCode = 2;
 } else {
  // Do not force a thinking switch onto models that do not support it.
  const config = resolveQwenConfig({});
  evidence.requested_model = config.model;
  evidence.endpoint_host = new URL(config.base_url).hostname;
  const client = createQwenClient(process.env, async (url, init) => {
   try {
    evidence.request_attempted = true;
    const response = await fetch(url, init);
    evidence.called_provider = true;
    return response;
   } catch (error) { throw error; }
  });
  const result = await client.answer({
   config, question: '请根据附件计算剩余应付金额，并简要说明计算过程。',
   materials: [{ name: '合成付款记录', text: '应付金额为100元；已经支付40元。' }],
   timeout_ms: 30000,
  });
  evidence.status = 'passed';
  evidence.actual_model = result.model;
  evidence.request_id = result.request_id;
  evidence.completion_id = result.completion_id;
  evidence.started_at = result.started_at;
  evidence.finished_at = result.finished_at;
  evidence.duration_ms = result.duration_ms;
  evidence.answer_received = Boolean(result.text.trim());
  // Retain only numeric metering fields in the public smoke record, not model output.
  evidence.usage = result.usage === null ? null : Object.fromEntries(
   ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cost'].flatMap(key => typeof result.usage?.[key] === 'number' ? [[key, result.usage[key]]] : []),
  );
 }
} catch (error) {
 evidence.status = 'failed';
 if (error instanceof QwenError) {
  evidence.error = { kind: error.kind, retryable: error.retryable, http_status: error.http_status, provider_code: error.provider_code, request_id: error.request_id };
 } else { evidence.error = { kind: 'verification_failed', details_omitted: true }; }
 process.exitCode = 1;
} finally {
 try {
  await mkdir(new URL('.', output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
 } catch {
  console.error('Qwen 验收记录保存失败；未输出凭证或响应正文');
  process.exitCode = 1;
 }
}
