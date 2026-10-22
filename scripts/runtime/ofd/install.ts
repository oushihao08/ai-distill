/** 职责：显式安装固定OFDRW运行依赖至受管目录并编译本地桥接；入口bun scripts/runtime/ofd/install.ts。会联网下载Maven依赖，不改package.json、不自动在任务中安装。 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {storageDirectory} from '../../../server/paths';
const run=promisify(execFile),source=fileURLToPath(new URL('.',import.meta.url)),target=join(storageDirectory(),'tools/ofd-2.4.0');
try{
 await mkdir(join(target,'lib'),{recursive:true,mode:0o700});
 await run('mvn',['-q','-f',join(source,'pom.xml'),'org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy-dependencies',`-DoutputDirectory=${join(target,'lib')}`],{timeout:300000,maxBuffer:2*1024*1024});
 await run('javac',['-encoding','UTF-8','-cp',join(target,'lib/*'),'-d',target,join(source,'OfdToPdf.java')],{timeout:60000,maxBuffer:1024*1024});
 console.log(JSON.stringify({installed:true,version:'2.4.0',path:target}));
}catch(error){console.error('OFD转换器安装失败：'+(error instanceof Error?error.message:'未知错误'));process.exitCode=1;}
