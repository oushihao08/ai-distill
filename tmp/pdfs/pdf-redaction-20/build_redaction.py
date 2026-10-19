import csv, json, re, unicodedata, os
from difflib import SequenceMatcher
from PIL import Image, ImageDraw

base='.storage/f7403b39-0b8f-4f98-8854-346ad207c875'
original=json.load(open(base+'/34ae3f47-faa0-4fb3-bf86-efddb7b64857.extracted.json'))
redacted=json.load(open(base+'/redacted_index-6b2013ef-8be5-4ae1-821b-38722c760ae1.json'))['materials'][0]['document']

def chars_with_boxes(rows):
    chars=[]
    for row in rows:
        raw=row.get('text','')
        if not raw.strip() or float(row.get('conf') or -1)<0: continue
        left,top=int(row['left']),int(row['top'])
        right,bottom=left+int(row['width']),top+int(row['height'])
        for c in unicodedata.normalize('NFKC',raw):
            if c.isspace() or unicodedata.category(c)[0] in ('P','Z','C','S'): continue
            if c.isalnum() or '\u3400'<=c<='\u9fff': chars.append((c,(left,top,right,bottom)))
    return chars

def normalize(s):
    out=[]
    for c in unicodedata.normalize('NFKC',s):
        if c.isspace() or unicodedata.category(c)[0] in ('P','Z','C','S'): continue
        if c.isalnum() or '\u3400'<=c<='\u9fff': out.append(c)
    return ''.join(out)

all_masks=[]; stats=[]; misses=[]; short=[]; ambiguous=[]
for i in range(20):
    tsv=f'tmp/pdfs/pdf-redaction-20/page-{i+1:02d}.tsv'
    with open(tsv,encoding='utf8') as f: rows=list(csv.DictReader(f,delimiter='\t'))
    chars=chars_with_boxes(rows); stream=''.join(c for c,_ in chars)
    oblocks={x['id']:x.get('text','') for x in original['pages'][i]['structure'] if 'id' in x}
    rblocks={x['id']:x.get('text','') for x in redacted['pages'][i]['blocks'] if 'id' in x}
    targets=[]
    for bid in set(oblocks)&set(rblocks):
        a,b=oblocks[bid],rblocks[bid]
        if a==b: continue
        sm=SequenceMatcher(a=a,b=b,autojunk=False)
        for tag,i1,i2,j1,j2 in sm.get_opcodes():
            if tag=='equal': continue
            new=b[j1:j2]
            if '*' not in new and '＊' not in new: continue
            needle=normalize(a[i1:i2])
            if needle: targets.append(needle)
    page_masks=[]; page_missed=[]
    for needle in sorted(set(targets),key=len,reverse=True):
        if len(needle)==1: short.append((i+1,len(needle))); continue
        starts=[]; at=0
        while True:
            pos=stream.find(needle,at)
            if pos<0: break
            starts.append(pos); at=pos+1
        if not starts:
            # Do not guess with fuzzy match; flag for manual review.
            page_missed.append(len(needle)); continue
        if len(starts)>1: ambiguous.append((i+1,len(needle),len(starts)))
        for pos in starts:
            boxes=[chars[j][1] for j in range(pos,pos+len(needle))]
            if boxes: page_masks.append((min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)))
    # coalesce nearby same-line masks and add 2px safety margin
    merged=[]
    for x0,y0,x1,y1 in sorted(page_masks,key=lambda b:(b[1],b[0])):
        box=(max(0,x0-3),max(0,y0-3),x1+3,y1+3)
        hit=None
        for j,(a,b,c,d) in enumerate(merged):
            if abs(b-box[1])<=12 and box[0]<=c+5 and box[2]>=a-5:
                hit=j; merged[j]=(min(a,box[0]),min(b,box[1]),max(c,box[2]),max(d,box[3])); break
        if hit is None: merged.append(box)
    stats.append({'page':i+1,'targets':len(set(targets)),'matched_masks':len(merged),'unmatched':len(page_missed),'unmatched_lengths':page_missed})
    misses.extend((i+1,n) for n in page_missed)
    all_masks.append(merged)

# Render first 20 pages as flattened images with coordinate-based opaque masks.
for i,boxes in enumerate(all_masks):
    p=f'tmp/pdfs/pdf-redaction-20/page-{i+1:02d}.jpg'
    im=Image.open(p).convert('RGB'); draw=ImageDraw.Draw(im)
    for x0,y0,x1,y1 in boxes:
        draw.rectangle((x0,y0,x1,y1),fill=(0,0,0))
    im.save(f'tmp/pdfs/pdf-redaction-20/redacted-{i+1:02d}.jpg',quality=95,subsampling=0)

print(json.dumps({'pages':20,'per_page':stats,'total_masks':sum(len(x) for x in all_masks),'unmatched_count':len(misses),'unmatched_pages':sorted(set(p for p,_ in misses)),'single_char_targets_skipped':len(short),'ambiguous_hits':len(ambiguous)},ensure_ascii=False))
