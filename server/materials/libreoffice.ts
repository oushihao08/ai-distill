/** 职责：为本机 LibreOffice 转换创建隔离环境，并在 macOS 补入系统字体资源目录；供材料预处理与原件预览复用，不修改全局字体配置。 */
import {readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function createLibreOfficeEnvironment(temporary:string){
 const env={...process.env};
 if(process.platform!=='darwin'||env.FONTCONFIG_FILE)return env;
 let assets:string[]=[];
 try{assets=(await readdir('/System/Library/AssetsV2')).filter(name=>/^com_apple_MobileAsset_Font\d+$/.test(name)).map(name=>join('/System/Library/AssetsV2',name));}
 catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
 const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const config=join(temporary,'fonts.conf');
 await writeFile(config,`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>${['/System/Library/Fonts','/Library/Fonts',...assets].map(path=>`<dir>${escape(path)}</dir>`).join('')}<cachedir>${escape(join(temporary,'font-cache'))}</cachedir></fontconfig>`,{mode:0o600});
 env.FONTCONFIG_FILE=config;
 return env;
}
