/**
 * 职责：将 Downloads 下的 10 个高经九期目录包完整同步至第九期 questions 目录：
 *   - /Users/jack/Downloads/高经九期14-3
 *   - /Users/jack/Downloads/高经九期13-2
 *   - /Users/jack/Downloads/高经九期13-1
 *   - /Users/jack/Downloads/高经九期14-1
 *   - /Users/jack/Downloads/高经九期 12-2
 *   - /Users/jack/Downloads/高经九期12-1
 *   - /Users/jack/Downloads/高经九期11-2
 *   - /Users/jack/Downloads/高经九期11-1
 *   - /Users/jack/Downloads/高经九期10-2
 *   - /Users/jack/Downloads/高经九期10-1
 * 
 * 规则：
 *   1. 每个文件夹都是一个材料包，目标目录：projects/豆包高经济价值/第九期/questions
 *   2. 同名冲突自动后缀 -2（如 曾祥勇 与 曾祥勇-2，武汉旭盛鑫... 与 武汉旭盛鑫...-2）
 *   3. 6张鹏 内的 6-2 独立抽取为同级材料包 questions/6-2
 *   4. 单文件包含子目录的特殊电子卷宗：
 *      - (2024)鄂0111执1907号：使用 qpdf 合并 15 册分类下的 614 页为单个正卷
 *      - 孟现明：提取诉讼卷.pdf与执行卷.pdf及文书至根目录
 *      - 东湖-孙亮、明文芳-蔡甸法院：提取子卷宗PDF至根目录
 *      - 张奇才：忽略空的新建文件夹
 * 
 * 入口：`bun scripts/runtime/sync-phase9-new-downloads.ts`
 */
import { readdir, stat, copyFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const TARGET_QUESTIONS = resolve('projects/豆包高经济价值/第九期/questions');

const SRC_DIRS = [
  '/Users/jack/Downloads/高经九期10-1',
  '/Users/jack/Downloads/高经九期10-2',
  '/Users/jack/Downloads/高经九期11-1',
  '/Users/jack/Downloads/高经九期11-2',
  '/Users/jack/Downloads/高经九期12-1',
  '/Users/jack/Downloads/高经九期 12-2',
  '/Users/jack/Downloads/高经九期13-1',
  '/Users/jack/Downloads/高经九期13-2',
  '/Users/jack/Downloads/高经九期14-1',
  '/Users/jack/Downloads/高经九期14-3'
];

async function copyFolderFiles(srcPath: string, destPath: string) {
  await mkdir(destPath, { recursive: true });
  const entries = await readdir(srcPath, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const srcFile = join(srcPath, e.name);
    const destFile = join(destPath, e.name);
    if (e.isFile()) {
      await copyFile(srcFile, destFile);
    }
  }
}

async function mergeEcourtVolume(ecourtDir: string, destFile: string) {
  console.log(`[Merge] 合并电子卷宗: ${ecourtDir} -> ${destFile}...`);
  const cats = (await readdir(ecourtDir, { withFileTypes: true }))
    .filter((x) => x.isDirectory())
    .map((x) => x.name);

  cats.sort((a, b) => {
    const numA = parseInt(a.split('、')[0], 10) || 0;
    const numB = parseInt(b.split('、')[0], 10) || 0;
    return numA - numB;
  });

  const pdfFiles: string[] = [];
  for (const c of cats) {
    const files = (await readdir(join(ecourtDir, c))).filter(
      (f) => f.endsWith('.pdf') && !f.startsWith('.')
    );
    files.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
    for (const f of files) {
      pdfFiles.push(join(ecourtDir, c, f));
    }
  }

  console.log(`  共 ${pdfFiles.length} 个文件待合并...`);
  const qpdfRes = spawnSync('/opt/homebrew/bin/qpdf', [
    '--empty',
    '--pages',
    ...pdfFiles,
    '--',
    destFile
  ]);

  if (qpdfRes.status !== 0) {
    throw new Error(`qpdf 合并失败: ${qpdfRes.stderr.toString()}`);
  }
  const st = await stat(destFile);
  console.log(`  合并成功! 文件大小: ${(st.size / (1024 * 1024)).toFixed(2)} MB`);
}

async function main() {
  console.log(`[Sync] 开始同步 10 个 Downloads 目录至 ${TARGET_QUESTIONS}...`);
  await mkdir(TARGET_QUESTIONS, { recursive: true });

  const existingInTarget = new Set(await readdir(TARGET_QUESTIONS));
  const createdPackages: { name: string; srcDir: string }[] = [];

  for (const srcDir of SRC_DIRS) {
    console.log(`\n---> 处理源目录: ${srcDir}`);
    const entries = await readdir(srcDir, { withFileTypes: true });

    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;

      let targetName = e.name;
      const srcSubPath = join(srcDir, e.name);

      // 处理特定名称重复冲突
      if (existingInTarget.has(targetName)) {
        let suffix = 2;
        while (existingInTarget.has(`${targetName}-${suffix}`)) {
          suffix++;
        }
        targetName = `${targetName}-${suffix}`;
        console.log(`  [重命名冲突] ${e.name} 存在重复，自动重命名为: ${targetName}`);
      }

      const targetDestPath = join(TARGET_QUESTIONS, targetName);

      // 特殊情况 1: 6张鹏 内含 6-2
      if (e.name === '6张鹏') {
        await mkdir(targetDestPath, { recursive: true });
        const p62 = join(srcSubPath, '6-2');
        const p62Target = join(TARGET_QUESTIONS, '6-2');
        await mkdir(p62Target, { recursive: true });

        // 复制 6-2 里的文件
        const p62Files = await readdir(p62);
        for (const f of p62Files) {
          if (!f.startsWith('.')) {
            await copyFile(join(p62, f), join(p62Target, f));
          }
        }
        existingInTarget.add('6-2');
        createdPackages.push({ name: '6-2', srcDir: p62 });
        console.log(`  [抽取] 独立抽取材料包: 6-2`);

        // 复制 6张鹏 自身顶层文件
        const p6Files = await readdir(srcSubPath);
        for (const f of p6Files) {
          if (f !== '6-2' && !f.startsWith('.')) {
            const st = await stat(join(srcSubPath, f));
            if (st.isFile()) {
              await copyFile(join(srcSubPath, f), join(targetDestPath, f));
            }
          }
        }
        existingInTarget.add(targetName);
        createdPackages.push({ name: targetName, srcDir: srcSubPath });
        console.log(`  [完成] 6张鹏`);
        continue;
      }

      // 特殊情况 2: (2024)鄂0111执1907号 包含 614 页未合并电子卷宗
      if (e.name === '(2024)鄂0111执1907号') {
        await mkdir(targetDestPath, { recursive: true });
        const ecourt = join(srcSubPath, '1、正卷第1册');
        const destPdf = join(targetDestPath, '1、(2024)鄂0111执1907号_正卷第1册.pdf');
        await mergeEcourtVolume(ecourt, destPdf);
        existingInTarget.add(targetName);
        createdPackages.push({ name: targetName, srcDir: srcSubPath });
        continue;
      }

      // 特殊情况 3: 孟现明 包含两个子案号卷宗
      if (e.name === '孟现明') {
        await mkdir(targetDestPath, { recursive: true });
        // 顶层文件
        const topFiles = await readdir(srcSubPath, { withFileTypes: true });
        for (const tf of topFiles) {
          if (tf.isFile() && !tf.name.startsWith('.')) {
            await copyFile(join(srcSubPath, tf.name), join(targetDestPath, tf.name));
          }
        }
        // 诉讼卷
        const p1 = join(srcSubPath, '(2021)鄂0112民初9485号', '诉讼卷.pdf');
        await copyFile(p1, join(targetDestPath, '诉讼卷-(2021)鄂0112民初9485号.pdf'));
        // 执行卷
        const p2 = join(srcSubPath, '(2022)鄂0112执3060号', '执行卷.pdf');
        await copyFile(p2, join(targetDestPath, '执行卷-(2022)鄂0112执3060号.pdf'));

        existingInTarget.add(targetName);
        createdPackages.push({ name: targetName, srcDir: srcSubPath });
        console.log(`  [完成] 孟现明 (已提取诉讼卷与执行卷)`);
        continue;
      }

      // 特殊情况 4: 东湖-孙亮
      if (e.name === '东湖-孙亮') {
        await mkdir(targetDestPath, { recursive: true });
        const subPdf = join(srcSubPath, '(2024)鄂0192民初1130号', '1、(2024)鄂0192民初1130号_正卷第1册.pdf');
        await copyFile(subPdf, join(targetDestPath, '1、(2024)鄂0192民初1130号_正卷第1册.pdf'));
        existingInTarget.add(targetName);
        createdPackages.push({ name: targetName, srcDir: srcSubPath });
        console.log(`  [完成] 东湖-孙亮 (已提取正卷第1册)`);
        continue;
      }

      // 特殊情况 5: 明文芳-蔡甸法院
      if (e.name === '明文芳-蔡甸法院') {
        await mkdir(targetDestPath, { recursive: true });
        const subPdf = join(srcSubPath, '2022鄂0114民初255号', '诉讼卷 (1).pdf');
        await copyFile(subPdf, join(targetDestPath, '诉讼卷 (1).pdf'));
        existingInTarget.add(targetName);
        createdPackages.push({ name: targetName, srcDir: srcSubPath });
        console.log(`  [完成] 明文芳-蔡甸法院 (已提取诉讼卷)`);
        continue;
      }

      // 特殊情况 6: 张奇才
      if (e.name === '张奇才') {
        await copyFolderFiles(srcSubPath, targetDestPath);
        existingInTarget.add(targetName);
        createdPackages.push({ name: targetName, srcDir: srcSubPath });
        console.log(`  [完成] 张奇才 (已忽略空的新建文件夹)`);
        continue;
      }

      // 普通情况：直接拷贝该目录下全部文件
      await copyFolderFiles(srcSubPath, targetDestPath);
      existingInTarget.add(targetName);
      createdPackages.push({ name: targetName, srcDir: srcSubPath });
      console.log(`  [完成] ${targetName}`);
    }
  }

  console.log(`\n=== 同步完成 ===`);
  console.log(`本次新增同步材料包数量: ${createdPackages.length}`);
  const finalAll = (await readdir(TARGET_QUESTIONS)).filter((x) => !x.startsWith('.'));
  console.log(`第九期 questions 目录下材料包总数: ${finalAll.length}`);
}

main().catch((err) => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
