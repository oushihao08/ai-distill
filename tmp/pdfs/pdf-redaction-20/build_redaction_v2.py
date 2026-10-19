import csv, json, unicodedata, os
from difflib import SequenceMatcher
from PIL import Image, ImageDraw

store='.storage/f7403b39-0b8f-4f98-8854-346ad207c875'
orig=json.load(open(store+'/34ae3f47-faa0-4fb3-bf86-efddb7b64857.extracted.json'))['pages']
red=json.load(open(store+'/redacted_index-6b2013ef-8be5-4ae1-821b-38722c760ae1.json'))['materials'][0]['document']['pages']
raw=json.load(open('tmp/pdfs/pdf-redaction-20/mineru/content_list.json'))

def norm(s):
    out=[]
    for c in unicodedata.normalize('NFKC',s or ''):
        if c.isspace() or unicodedata.category(c)[0] in ('P','Z','C','S'): continue
        if c.isalnum() or '\u3400'<=c<='\u9fff': out.append(c)
    return ''.join(out)
def flatten(x):
    if isinstance(x,str): return x
    if isinstance(x,list): return ''.join(flatten(y) for y in x)
    if isinstance(x,dict): return ''.join(flatten(v) for k,v in x.items() if k not in ('id','level','kind','rowSpan','columnSpan'))
    return ''
def rawtext(x):
    values=[]
    def walk(v):
        if isinstance(v,str): values.append(v)
        elif isinstance(v,list):
            for y in v: walk(y)
        elif isinstance(v,dict):
            for k in ('text','content','latex','value','table_body','html','table_caption','table_footnote'):
                if k in v: walk(v[k])
    walk(x);return ''.join(values)
def boxchars(tsv):
    chars=[]
    with open(tsv,encoding='utf8') as f:
        for row in csv.DictReader(f,delimiter='\t'):
            txt=row.get('text','')
            try: conf=float(row.get('conf') or -1)
            except ValueError: conf=-1
            if not txt.strip() or conf<0:continue
            x0,y0=int(row['left']),int(row['top']);x1=x0+int(row['width']);y1=y0+int(row['height'])
            for c in unicodedata.normalize('NFKC',txt):
                if c.isspace() or unicodedata.category(c)[0] in ('P','Z','C','S'):continue
                if c.isalnum() or '\u3400'<=c<='\u9fff':chars.append((c,(x0,y0,x1,y1)))
    return chars

all_masks=[];page_report=[];unresolved=[];block_misses=[];ambiguities=[]
for pi in range(20):
    page_no=pi+1
    chars=boxchars(f'tmp/pdfs/pdf-redaction-20/page-{page_no:02d}.tsv')
    stream=''.join(c for c,_ in chars)
    om={x['id']:x for x in orig[pi]['structure'] if 'id'in x}
    rm={x['id']:x for x in red[pi]['blocks'] if 'id'in x}
    page_raw=[x for x in raw if x.get('page_idx')==pi]
    masks=[]; flagged=precise=block=0
    for bid,ob in om.items():
        rb=rm.get(bid)
        rtext=flatten(rb) if rb else ''
        if '*' not in rtext and '＊' not in rtext: continue
        flagged+=1
        source=flatten(ob)
        # Match the current MinerU layout block by exact normalized source text.
        norm_source=norm(source)
        candidates=[x for x in page_raw if norm(rawtext(x))==norm_source and any(k in x for k in ('bbox','box','rect'))]
        if not candidates and ob.get('kind')=='table':
            table_rows=[x for x in page_raw if 'table' in str(x.get('type','')).lower() and any(k in x for k in ('bbox','box','rect'))]
            if len(table_rows)==1:candidates=table_rows
        if len(candidates)!=1:
            block_misses.append((page_no,bid,len(candidates)))
            continue
        row=candidates[0]
        bbox=row.get('bbox') or row.get('box') or row.get('rect')
        if not isinstance(bbox,list) or len(bbox)<4: block_misses.append((page_no,bid,0));continue
        # MinerU page coordinates use a 0-1000 coordinate plane.
        image=Image.open(f'tmp/pdfs/pdf-redaction-20/page-{page_no:02d}.jpg')
        sx,sy=image.width/1000,image.height/1000
        fullbox=(max(0,int(bbox[0]*sx)-4),max(0,int(bbox[1]*sy)-4),min(image.width,int(bbox[2]*sx)+4),min(image.height,int(bbox[3]*sy)+4))
        target_spans=[]
        for tag,i1,i2,j1,j2 in SequenceMatcher(a=source,b=rtext,autojunk=False).get_opcodes():
            if tag=='equal':continue
            replacement=rtext[j1:j2]
            if '*' in replacement or '＊' in replacement:
                needle=norm(source[i1:i2])
                if needle:target_spans.append(needle)
        # Use Tesseract's local character coordinates when the redacted span matches exactly.
        precise_boxes=[];needs_block=not target_spans
        for needle in sorted(set(target_spans),key=len,reverse=True):
            if len(needle)<2:
                needs_block=True;continue
            starts=[];at=0
            while (pos:=stream.find(needle,at))>=0:
                starts.append(pos);at=pos+1
            if not starts:
                needs_block=True;continue
            for pos in starts:
                used=[chars[k][1] for k in range(pos,pos+len(needle))]
                precise_boxes.append((max(0,min(x[0] for x in used)-4),max(0,min(x[1] for x in used)-4),min(image.width,max(x[2] for x in used)+4),min(image.height,max(x[3] for x in used)+4)))
        if needs_block:
            masks.append(fullbox);block+=1
        else:
            masks.extend(precise_boxes);precise+=len(precise_boxes)
    # Merge only adjacent same-line boxes; retain precise rows and block fallbacks.
    merged=[]
    for x0,y0,x1,y1 in sorted(masks,key=lambda b:(b[1],b[0])):
        hit=None
        for j,(a,b,c,d) in enumerate(merged):
            if abs(b-y0)<=8 and x0<=c+3 and x1>=a-3:
                hit=j;merged[j]=(min(a,x0),min(b,y0),max(c,x1),max(d,y1));break
        if hit is None:merged.append((x0,y0,x1,y1))
    all_masks.append(merged)
    page_report.append({'page':page_no,'flagged_blocks':flagged,'precise_boxes':precise,'block_fallbacks':block,'final_boxes':len(merged)})

if block_misses:
    print(json.dumps({'status':'blocked','unmapped_sensitive_blocks':len(block_misses),'pages':sorted(set(x[0] for x in block_misses))},ensure_ascii=False));raise SystemExit(2)

# Flattened, image-only PDF: black rectangles are burned into each page image.
images=[]
for i,boxes in enumerate(all_masks,1):
    src=f'tmp/pdfs/pdf-redaction-20/page-{i:02d}.jpg'
    im=Image.open(src).convert('RGB');draw=ImageDraw.Draw(im)
    for box in boxes: draw.rectangle(box,fill=(0,0,0))
    preview=f'tmp/pdfs/pdf-redaction-20/redacted-{i:02d}.jpg'
    im.save(preview,quality=95,subsampling=0)
    images.append(im)
out='output/pdf/2020渝0104民初4227号-前20页打码测试.pdf'
os.makedirs(os.path.dirname(out),exist_ok=True)
images[0].save(out,format='PDF',save_all=True,append_images=images[1:],resolution=200.0)
print(json.dumps({'status':'created','output':out,'pages':20,'total_boxes':sum(map(len,all_masks)),'per_page':page_report,'unmatched_or_unverified':0,'flattened_image_only':True},ensure_ascii=False))
