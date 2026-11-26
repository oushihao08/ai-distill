/**
 * 职责：ALE 确定性 DOCX 输入材料构建器与前置输入匹配器（唯一共享实现）。
 * 主要公开入口：
 * - `normalizeDocxZipDeterministic()`：将 OOXML `.docx` ZIP 包内的文件时间戳与 `docProps/core.xml` 创建/修改时间规范为固定常量，确保同结构同正文多次渲染产生逐字节一致的 SHA-256。
 * - `buildDeterministicAleMaterialDocx()`：优先合并 `prepared_documents`（通过 `combineMaterialSections` 保留原生 Word 表格与标题层次），否则降级按正文渲染为确定性 `.docx` 字节。
 * - `resolveAleInputMaterials()`：统一服务于 `verify-gate.ts` 沙盒校验与 `delivery.ts` 第 8 步归档，保证声明输入 `environment/input/附件N.docx` 均写入合法且逐字节一致的 `.docx` 二进制文件。
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { buildDocx, type RedactedDocumentStructure } from '../../../server/document-generation/docx';
import { combineMaterialSections } from '../../../server/materials/redacted-docx-export';

const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021; // 1980-01-01
const FIXED_OOXML_TIMESTAMP = '2026-01-01T00:00:00Z';

const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function sha256HexBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface AleMaterialSourceDoc {
  id?: string;
  title?: string;
  duplicate_of?: string | null;
  text?: string;
  document?: RedactedDocumentStructure;
}

export interface AleMaterialAttachmentInput {
  id?: string;
  name?: string;
  sha256?: string;
  text?: string;
  model_sha256?: string;
  model_text?: string;
  prepared_documents?: ReadonlyArray<AleMaterialSourceDoc>;
  original_files?: ReadonlyArray<{ name: string; sha256: string; content_base64: string }>;
}

/**
 * 规范化 `.docx` ZIP 容器的非业务时间戳，使相同内容在不同时间渲染得到完全相同的 SHA-256。
 */
export function normalizeDocxZipDeterministic(zipBytes: Uint8Array): Uint8Array {
  const buf = Buffer.from(zipBytes);
  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('无效 DOCX ZIP：未找到 End of Central Directory');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let cursor = cdOffset;
  let newOffset = 0;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`无效 DOCX ZIP：Central Directory 条目 #${idx} 签名不匹配`);
    }
    const versionMadeBy = buf.readUInt16LE(cursor + 4);
    const versionNeeded = buf.readUInt16LE(cursor + 6);
    const flags = buf.readUInt16LE(cursor + 8) & ~0x0008;
    const method = buf.readUInt16LE(cursor + 10);
    let crc = buf.readUInt32LE(cursor + 16);
    let compSize = buf.readUInt32LE(cursor + 20);
    let uncompSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const cdExtraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const diskStart = buf.readUInt16LE(cursor + 34);
    const intAttr = buf.readUInt16LE(cursor + 36);
    const extAttr = buf.readUInt32LE(cursor + 38);
    const origLocalOffset = buf.readUInt32LE(cursor + 42);

    const nameBytes = buf.subarray(cursor + 46, cursor + 46 + nameLen);
    const entryName = nameBytes.toString('utf8');
    const cdExtraBytes = buf.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + cdExtraLen);
    const commentBytes = buf.subarray(
      cursor + 46 + nameLen + cdExtraLen,
      cursor + 46 + nameLen + cdExtraLen + commentLen,
    );
    cursor += 46 + nameLen + cdExtraLen + commentLen;

    if (buf.readUInt32LE(origLocalOffset) !== 0x04034b50) {
      throw new Error(`无效 DOCX ZIP：Local Header 签名不匹配 (${entryName})`);
    }
    const lfNameLen = buf.readUInt16LE(origLocalOffset + 26);
    const lfExtraLen = buf.readUInt16LE(origLocalOffset + 28);
    const lfExtraBytes = buf.subarray(origLocalOffset + 30 + lfNameLen, origLocalOffset + 30 + lfNameLen + lfExtraLen);
    const dataStart = origLocalOffset + 30 + lfNameLen + lfExtraLen;
    let payload: Buffer<ArrayBufferLike> = buf.subarray(dataStart, dataStart + compSize);

    if (entryName === 'docProps/core.xml') {
      const rawXml = (method === 8 ? inflateRawSync(payload) : payload).toString('utf8');
      const fixedXml = rawXml
        .replace(/<dcterms:created([^>]*)>[^<]*<\/dcterms:created>/g, `<dcterms:created$1>${FIXED_OOXML_TIMESTAMP}</dcterms:created>`)
        .replace(/<dcterms:modified([^>]*)>[^<]*<\/dcterms:modified>/g, `<dcterms:modified$1>${FIXED_OOXML_TIMESTAMP}</dcterms:modified>`);
      const xmlBytes = Buffer.from(fixedXml, 'utf8');
      uncompSize = xmlBytes.length;
      crc = crc32(xmlBytes);
      payload = method === 8 ? Buffer.from(deflateRawSync(xmlBytes)) : xmlBytes;
      compSize = payload.length;
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(versionNeeded, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(crc >>> 0, 14);
    localHeader.writeUInt32LE(compSize >>> 0, 18);
    localHeader.writeUInt32LE(uncompSize >>> 0, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(lfExtraBytes.length, 28);

    localParts.push(localHeader, nameBytes, lfExtraBytes, payload);

    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(versionMadeBy, 4);
    cdEntry.writeUInt16LE(versionNeeded, 6);
    cdEntry.writeUInt16LE(flags, 8);
    cdEntry.writeUInt16LE(method, 10);
    cdEntry.writeUInt16LE(FIXED_DOS_TIME, 12);
    cdEntry.writeUInt16LE(FIXED_DOS_DATE, 14);
    cdEntry.writeUInt32LE(crc >>> 0, 16);
    cdEntry.writeUInt32LE(compSize >>> 0, 20);
    cdEntry.writeUInt32LE(uncompSize >>> 0, 24);
    cdEntry.writeUInt16LE(nameBytes.length, 28);
    cdEntry.writeUInt16LE(cdExtraBytes.length, 30);
    cdEntry.writeUInt16LE(commentBytes.length, 32);
    cdEntry.writeUInt16LE(diskStart, 34);
    cdEntry.writeUInt16LE(intAttr, 36);
    cdEntry.writeUInt32LE(extAttr, 38);
    cdEntry.writeUInt32LE(newOffset >>> 0, 42);

    cdParts.push(cdEntry, nameBytes, cdExtraBytes, commentBytes);
    newOffset += localHeader.length + nameBytes.length + lfExtraBytes.length + payload.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(totalEntries, 8);
  eocd.writeUInt16LE(totalEntries, 10);
  eocd.writeUInt32LE(cdBuf.length >>> 0, 12);
  eocd.writeUInt32LE(newOffset >>> 0, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...localParts, cdBuf, eocd]));
}

export async function buildDeterministicAleMaterialDocx(source: {
  prepared_documents?: ReadonlyArray<AleMaterialSourceDoc>;
  text?: string;
}): Promise<Uint8Array> {
  const structuredDocs = Array.isArray(source.prepared_documents)
    ? source.prepared_documents.filter(
        (doc): doc is AleMaterialSourceDoc & { title: string; document: RedactedDocumentStructure } =>
          Boolean(doc && typeof doc.title === 'string' && doc.title.trim() && doc.document?.format === 'redacted-structure-v1'),
      )
    : [];

  if (structuredDocs.length > 0) {
    const combined = combineMaterialSections(
      structuredDocs.map((doc) => ({
        title: doc.title,
        duplicate_of: doc.duplicate_of ?? null,
        document: doc.document,
      })),
    );
    const rawDocx = await buildDocx(combined, { pagination: 'flow', materialMath: true });
    return normalizeDocxZipDeterministic(rawDocx);
  }

  const preparedTextOnly = Array.isArray(source.prepared_documents)
    ? source.prepared_documents.filter((doc) => typeof doc?.text === 'string' && doc.text.trim())
    : [];
  const markdownText = preparedTextOnly.length
    ? preparedTextOnly
        .map((doc, i) => `## ${doc.title?.trim() || `文书${i + 1}`}\n\n${doc.text!.trim()}`)
        .join('\n\n')
    : String(source.text ?? '').trim();

  if (!markdownText) {
    throw new Error('构建 ALE 输入 DOCX 失败：材料正文为空');
  }
  const rawDocx = await buildDocx(markdownText, { pagination: 'flow', materialMath: true });
  return normalizeDocxZipDeterministic(rawDocx);
}

/**
 * 统一把工作台冻结附件解析为 `environment/input/` 的实体输入列表。
 * 若声明路径以 `.docx` 结尾（当前默认标准 `environment/input/附件N.docx`），始终写出确定性 `.docx` 二进制字节，绝不把纯文本写进 `.docx` 后缀。
 */
export async function resolveAleInputMaterials(
  declaredInputs: ReadonlyArray<{ path?: string; sha256?: string }> | undefined,
  attachments: ReadonlyArray<AleMaterialAttachmentInput>,
): Promise<Array<{ name: string; bytes?: Uint8Array; text?: string }>> {
  const materials: Array<{ name: string; bytes?: Uint8Array; text?: string }> = [];
  const matchedByIndex = new Set<number>();
  const matchedOriginalKeys = new Set<string>();
  const cachedDocxBytes = new Map<number, Uint8Array>();

  const getDocxBytes = async (idx: number): Promise<Uint8Array | null> => {
    if (cachedDocxBytes.has(idx)) return cachedDocxBytes.get(idx)!;
    const att = attachments[idx];
    if (!att) return null;
    const text = att.model_text ?? att.text;
    const hasDocs = Array.isArray(att.prepared_documents) && att.prepared_documents.length > 0;
    if (!hasDocs && (typeof text !== 'string' || !text.trim())) return null;
    const built = await buildDeterministicAleMaterialDocx({
      prepared_documents: att.prepared_documents,
      text: text ?? '',
    });
    cachedDocxBytes.set(idx, built);
    return built;
  };

  for (const decl of declaredInputs ?? []) {
    const relPath = String(decl?.path ?? '');
    const targetName = relPath.startsWith('environment/input/') ? basename(relPath) : '';
    if (!targetName) continue;
    const expectsDocx = targetName.toLowerCase().endsWith('.docx');

    // 1. 优先匹配原件二进制文件
    let matchedOriginal = false;
    for (const [idx, att] of attachments.entries()) {
      if (!Array.isArray(att.original_files)) continue;
      for (const orig of att.original_files) {
        const bytes = new Uint8Array(Buffer.from(orig.content_base64, 'base64'));
        if (sha256HexBytes(bytes) !== orig.sha256) {
          throw new Error(`原件 SHA-256 校验不匹配: ${orig.name}`);
        }
        if (orig.sha256 === decl.sha256 || (!decl.sha256 && orig.name === targetName) || (attachments.length === 1 && orig.name === targetName)) {
          materials.push({ name: targetName, bytes });
          matchedByIndex.add(idx);
          matchedOriginalKeys.add(`${idx}:${orig.name}:${orig.sha256}`);
          matchedOriginal = true;
          break;
        }
      }
      if (matchedOriginal) break;
    }
    if (matchedOriginal) continue;

    // 2. 匹配文本摘要（model_sha256 / sha256）
    const textIdx = attachments.findIndex(
      (att) =>
        (typeof att?.model_sha256 === 'string' && att.model_sha256 === decl.sha256 && typeof att?.model_text === 'string') ||
        (typeof att?.sha256 === 'string' && att.sha256 === decl.sha256 && typeof att?.text === 'string'),
    );
    if (textIdx >= 0) {
      const att = attachments[textIdx]!;
      const exactText = att.model_sha256 === decl.sha256 ? att.model_text! : att.text!;
      if (expectsDocx) {
        const bytes = await buildDeterministicAleMaterialDocx({
          prepared_documents: att.prepared_documents,
          text: exactText,
        });
        materials.push({ name: targetName, bytes });
      } else {
        materials.push({ name: targetName, text: exactText });
      }
      matchedByIndex.add(textIdx);
      continue;
    }

    // 3. 匹配确定性 DOCX 二进制 SHA-256
    if (expectsDocx) {
      let matchedDocxIdx = -1;
      let matchedBytes: Uint8Array | null = null;
      for (const [idx] of attachments.entries()) {
        const docxBytes = await getDocxBytes(idx);
        if (docxBytes && sha256HexBytes(docxBytes) === decl.sha256) {
          matchedDocxIdx = idx;
          matchedBytes = docxBytes;
          break;
        }
      }
      if (matchedDocxIdx >= 0 && matchedBytes) {
        materials.push({ name: targetName, bytes: matchedBytes });
        matchedByIndex.add(matchedDocxIdx);
        continue;
      }
    }
  }

  for (const [idx, att] of attachments.entries()) {
    if (Array.isArray(att.original_files) && att.original_files.length) {
      for (const orig of att.original_files) {
        if (matchedOriginalKeys.has(`${idx}:${orig.name}:${orig.sha256}`)) continue;
        const bytes = new Uint8Array(Buffer.from(orig.content_base64, 'base64'));
        if (sha256HexBytes(bytes) !== orig.sha256) {
          throw new Error(`原件 SHA-256 校验不匹配: ${orig.name}`);
        }
        materials.push({ name: orig.name, bytes });
      }
      continue;
    }
    if (matchedByIndex.has(idx)) continue;
    const docxBytes = await getDocxBytes(idx);
    if (docxBytes) {
      materials.push({ name: `附件${idx + 1}.docx`, bytes: docxBytes });
    }
  }

  return materials;
}
