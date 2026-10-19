import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve('tmp/pdfs/pdf-redaction-20/mineru');
await mkdir(root, { recursive: true, mode: 0o700 });
const input = resolve('tmp/pdfs/pdf-redaction-20/first-20.pdf');
const bytes = await readFile(input);
const sha = createHash('sha256').update(bytes).digest('hex');
const apiKey = process.env.MINERU_KEY;
if (!apiKey) throw new Error('MINERU_KEY unavailable');
const started = Date.now();
const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
function check(data: any) {
  if (!data || data.code !== 0 || !data.data) throw new Error('MinerU API response rejected');
  return data.data;
}
const requested = await fetch('https://mineru.net/api/v4/file-urls/batch', {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ files: [{ name: 'redaction-sample-first20.pdf', data_id: sha }], model_version: 'vlm' }),
});
if (!requested.ok) throw new Error(`Upload URL request failed: HTTP ${requested.status}`);
const allocation = check(await requested.json());
if (typeof allocation.batch_id !== 'string' || !Array.isArray(allocation.file_urls) || typeof allocation.file_urls[0] !== 'string') throw new Error('Upload URL response incomplete');
const put = await fetch(allocation.file_urls[0], { method: 'PUT', body: bytes });
if (!put.ok) throw new Error(`PDF upload failed: HTTP ${put.status}`);
let contentList: unknown;
for (;;) {
  const poll = await fetch(`https://mineru.net/api/v4/extract-results/batch/${encodeURIComponent(allocation.batch_id)}`, { headers });
  if (!poll.ok) throw new Error(`MinerU polling failed: HTTP ${poll.status}`);
  const data = check(await poll.json());
  const result = Array.isArray(data.extract_result) ? data.extract_result.find((row: any) => row?.data_id === sha || row?.file_name === 'redaction-sample-first20.pdf') : undefined;
  if (result?.state === 'failed') throw new Error('MinerU extraction failed');
  if (result?.state === 'done' && typeof result.full_zip_url === 'string') {
    const zip = await fetch(result.full_zip_url);
    if (!zip.ok) throw new Error(`MinerU result download failed: HTTP ${zip.status}`);
    const zipPath = resolve(root, 'result.zip');
    await writeFile(zipPath, new Uint8Array(await zip.arrayBuffer()), { mode: 0o600 });
    const listed = Bun.spawnSync(['unzip', '-Z1', zipPath], { stdout: 'pipe', stderr: 'ignore' });
    if (listed.exitCode !== 0) throw new Error('MinerU result ZIP invalid');
    const entries = new TextDecoder().decode(listed.stdout).split(/\r?\n/).filter(Boolean);
    const name = entries.find((entry) => /(?:^|\/)content_list\.json$/i.test(entry) || /_content_list\.json$/i.test(entry));
    if (!name || name.split('/').includes('..')) throw new Error('MinerU content_list missing');
    const raw = Bun.spawnSync(['unzip', '-p', zipPath, name], { stdout: 'pipe', stderr: 'ignore' });
    if (raw.exitCode !== 0) throw new Error('MinerU content_list read failed');
    contentList = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.stdout));
    await writeFile(resolve(root, 'content_list.json'), JSON.stringify(contentList), { mode: 0o600 });
    await Bun.write(resolve(root, 'metadata.json'), JSON.stringify({ source_sha256: sha, page_count: 20, duration_ms: Date.now() - started, provider: 'MinerU v4 vlm' }));
    break;
  }
  await Bun.sleep(3000);
}
function visit(value: any, rows: any[] = []): any[] {
  if (Array.isArray(value)) for (const item of value) visit(item, rows);
  else if (value && typeof value === 'object') {
    rows.push(value);
    for (const item of Object.values(value)) visit(item, rows);
  }
  return rows;
}
const rows = visit(contentList);
const bboxRows = rows.filter((row) => Array.isArray(row.bbox) || Array.isArray(row.box) || Array.isArray(row.rect));
const pageIds = [...new Set(rows.map((row) => row.page_idx).filter((x) => Number.isInteger(x)))].sort((a, b) => a - b);
process.stdout.write(JSON.stringify({ status: 'completed', page_count: 20, duration_ms: Date.now() - started, bbox_blocks: bboxRows.length, page_indices: pageIds.length }));
