export const sensitivePatterns = [/(?<!\d)\d{17}[\dXx](?!\d)/g, /(?<!\d)1[3-9]\d{9}(?!\d)/g, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, /(?<!\d)\d{16,19}(?!\d)/g];
export function redactTexts(texts: string[], entities: string[], maskStyle: 'partial' | 'placeholder' = 'placeholder') {
 const all = texts.join('\n');
 const values = [...new Set([...entities, ...sensitivePatterns.flatMap(pattern => all.match(pattern) ?? [])])].filter(value => value.length >= 2).sort((a,b) => b.length-a.length || a.localeCompare(b, 'zh-CN'));
 const mapping = values.map((original, index) => ({ original, replacement: maskStyle === 'partial' ? (original.length <= 2 ? `${original.slice(0,1)}*` : original.length <= 4 ? `${original.slice(0,1)}**${original.slice(-1)}` : `${original.slice(0,2)}****${original.slice(-2)}`) : `【主体${String(index+1).padStart(3,'0')}】` }));
 const replace = (text: string) => {
  if (!values.length) return text;
  const pattern = new RegExp(values.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const lookup = new Map(mapping.map(v => [v.original,v.replacement]));
  return text.replace(pattern, original => lookup.get(original)!);
 };
 const redacted = texts.map(replace);
 const issues = redacted.flatMap((text,index) => sensitivePatterns.some(pattern => { pattern.lastIndex=0; return pattern.test(text); }) ? [{ page_index: index, kind: 'sensitive_residue' }] : []);
 return { texts: redacted, mapping, issues };
}
