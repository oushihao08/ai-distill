/**
 * 职责：已退役的旧Vision OCR/实体检查集成入口，只保留无副作用的失败提示。
 * 旧脚本的配置快照与函数式提取器已不符合当前MinerU接口，不再执行或输出验收结论。
 * 本入口不加载配置、不读取真实材料、不连接数据库、不调用模型、不写文件。
 * 当前验证范围与独立入口见同目录README；隔离测试不等于真实OCR/脱敏验收。
 */
console.error('旧Vision集成验证入口已停用：配置与提取器接口已失效。请阅读 scripts/verification/README.md；MinerU适配器使用 server/materials/pdf-extraction/ 的定向单元测试，材料来源/使用账/交付的隔离链路另见 verify-project-material-usage.ts。它们不替代真实OCR或脱敏质量验收。');
process.exitCode=1;
