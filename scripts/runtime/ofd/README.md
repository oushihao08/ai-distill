# 本地OFD转换运行工具

供维护者显式安装及材料预处理调用。`install.ts`下载固定OFDRW 2.4.0运行依赖到`.storage/tools/ofd-2.4.0`（随STORAGE_DIR变化），需要Java/Javac、Maven和网络；不修改项目npm依赖。入口：`bun scripts/runtime/ofd/install.ts`。安装不是自动任务行为，先取得授权。

`pom.xml`固定转换器依赖；`OfdToPdf.java`调用IText导出完整页面，返回OFD页数供TypeScript复核。源文件只读，PDF是新副本，不继承原件数字签名验证效力。官方不保证所有OFD转换版式一致；页数一致不代替页面抽查。

预处理入口及来源记录见`server/materials/prepare-library-files.ts`和CLI `library files prepare`。转换失败保留失败记录，不发布可上传manifest；不调用模型、不访问数据库。

超限PDF切割建议安装qpdf（本机已安装），按范围导出并移除未引用资源，不重新编码图片。缺失时沿用Poppler路径，某些共享资源PDF会膨胀或报告单页超限，不能绕过大小校验。IText及传递依赖的许可证随安装jar保留，部署/分发时须核对相应许可。
