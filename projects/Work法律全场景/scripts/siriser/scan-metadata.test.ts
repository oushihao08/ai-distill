/** 验证Poppler输出的扫描判定边界与检测失败降级；不访问业务材料或模型。 */
import {test,expect} from 'bun:test';
import {classifyPdfScan,inspectPdfScan} from './scan-metadata';
test('扫描页、纯文字页、图文混排分别处理，不把图像或视觉依赖当作扫描证明',()=>{
 expect(classifyPdfScan('\f','page num type\n 1 0 image 1200 1800').status).toBe('scanned');
 expect(classifyPdfScan('正文\f','page num type').status).toBe('not_scanned');
 expect(classifyPdfScan('正文\f',' 1 0 image 20 20').status).toBe('unknown');
 expect(classifyPdfScan('正文\f\f',' 2 0 image 1200 1800').status).toBe('scanned');
 expect(classifyPdfScan('正文\f',' 99 0 image 1200 1800').status).toBe('unknown');
});
test('损坏PDF或工具检测失败留unknown，不冒充非扫描、不阻断主流程',async()=>{
 const result=await inspectPdfScan(Buffer.from('%PDF-1.4 invalid fixture'));
 expect(result.status).toBe('unknown');expect(result.reason).toContain('检测不可用');
});
