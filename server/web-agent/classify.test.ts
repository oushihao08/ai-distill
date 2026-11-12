/**
 * 测试对象：`classify.ts`（登录/验证码/限额/服务繁忙分类）。验证边界：纯函数文案与页面快照判定；真实站点触发形态未实测。
 */
import {describe,expect,test} from 'bun:test';
import {classifyNotice,classifyPage,classifyShortReply,providerHealth} from './classify';

describe('classifyNotice / classifyShortReply',()=>{
 test('验证码文本',()=>{
  for(const text of ['Please verify you are human','Checking your browser before accessing','请完成验证后继续','检测到异常流量，请完成人机验证','unusual traffic from your network']){
   expect(classifyNotice(text)).toBe('web_challenge_required');
  }
 });
 test('限额文本',()=>{
  for(const text of ['You have reached your usage limit','Too many requests','发送消息过于频繁，请稍后再试','您已达到今日使用上限','You\'ve reached the daily limit']){
   expect(classifyNotice(text)).toBe('web_rate_limited');
  }
 });
 test('服务繁忙文本',()=>{
  for(const text of ['The server is busy. Please try again later.','服务器繁忙，请稍后再试。','Something went wrong']){
   expect(classifyNotice(text)).toBe('web_busy');
  }
 });
 test('普通文本与空文本不分类',()=>{
  expect(classifyNotice('')).toBeNull();
  expect(classifyNotice('OK')).toBeNull();
  expect(classifyNotice('The uploaded file format is not supported.')).toBeNull();
 });
 test('短回复：仅短、单行、无代码的回复才按错误处理',()=>{
  expect(classifyShortReply('服务器繁忙，请稍后再试。')).toBe('web_busy');
  expect(classifyShortReply('OK')).toBeNull();
  expect(classifyShortReply(`${'说明。'.repeat(80)}服务器繁忙`)).toBeNull();
  expect(classifyShortReply('第一行\n服务器繁忙')).toBeNull();
 });
});

describe('classifyPage',()=>{
 test('输入框存在且无登录特征为 ready',()=>{
  expect(classifyPage({url:'https://chat.deepseek.com/',composer:true,login:false})).toBe('ready');
 });
 test('登录特征优先于输入框（Gemini 匿名页含输入框与登录链接）',()=>{
  expect(classifyPage({url:'https://gemini.google.com/app',composer:true,login:true})).toBe('login');
 });
 test('验证码特征优先；Google sorry 页为挑战',()=>{
  expect(classifyPage({url:'https://x/',composer:false,login:true,challenge:true})).toBe('challenge');
  expect(classifyPage({url:'https://www.google.com/sorry/index?continue=x',composer:false,login:false})).toBe('challenge');
  expect(classifyPage({url:'https://x/',composer:false,login:false,text:'Verify you are human'})).toBe('challenge');
 });
 test('无输入框：按 URL 判登录，否则仍在加载',()=>{
  expect(classifyPage({url:'https://chat.deepseek.com/sign_in',composer:false,login:false})).toBe('login');
  expect(classifyPage({url:'https://accounts.google.com/v3/signin',composer:false,login:false})).toBe('login');
  expect(classifyPage({url:'https://chat.deepseek.com/',composer:false,login:false,text:''})).toBe('loading');
 });
 test('providerHealth 映射',()=>{
  expect(providerHealth('ready')).toBe('logged_in');
  expect(providerHealth('login')).toBe('login_required');
  expect(providerHealth('challenge')).toBe('challenge');
  expect(providerHealth('loading')).toBe('unknown');
  expect(providerHealth('error')).toBe('unknown');
 });
});
