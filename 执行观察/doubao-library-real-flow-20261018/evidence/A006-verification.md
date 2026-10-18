# A006 修复及检查

新增已知MinerU块回归先失败（unsupported_block_type），修复后通过。派发/执行前质量检查的三个新用例覆盖未解决issues、缺issues、空文档/空页及健康输入保留；新导出缺失的首次失败属于尚未实现入口，未冒充运行时故障。

扩大检查发现旧“健康缓存”fixture实际带image_without_text，与当前process.ts已有的有问题OCR复识别行为冲突。保留process.ts现有修改，健康缓存fixture改为无issues，另增有问题缓存只复识别一次、源件/旧缓存不修改的用例。

最终5文件31项通过、113 expectations；材料库/出题/作答/评分上下文/归档/DOCX/Excel 12文件141项通过、480 expectations。bun run check exit0。原PDF对应私有诊断JSON离线重放：57页，原93条问题中的56条未知类型误报消除；剩37条（23无文字图片、9空块、5占位符）仍保留，不能宣称正文已完整。没有本轮外部调用，没有重启尚在出题的worker。
