# Experiment: apply PP-OCRv5 word boxes to the first three source pages.
# Explicit per-page review additions are recorded separately from OCR-selected boxes.
import json,re
from pathlib import Path
from PIL import Image,ImageDraw
base=Path('tmp/pdfs/paddleocr-3pages'); images=[];report=[]
for n in range(1,4):
 x=json.load(open(base/f'page-{n:02d}.json')); selected={}
 def mark(i,a,b):
  words=x['text_word'][i]; boxes=x['text_word_boxes'][i]; offset=0
  for k,w in enumerate(words):
   if offset<b and offset+len(w)>a:selected[(i,k)]=boxes[k]
   offset+=len(w)
 def find(i,pattern):
  s=''.join(x['text_word'][i])
  for m in re.finditer(pattern,s):mark(i,*m.span())
 def after(i,key):
  s=''.join(x['text_word'][i]);p=s.find(key)
  if p>=0:mark(i,p+len(key),len(s))
 for i in range(len(x['rec_texts'])):find(i,r'林源|徐歆|林原')
 if n==1:
  for i in [4,10]:find(i,r'\d{4}年\d{1,2}月\d{1,2}日')
  for i in [5,9,11,13,18]:find(i,r'\d{11,18}')
  for i in [5,11]:
   s=''.join(x['text_word'][i]);a=s.find('地址：')+3;b=s.find('，联系');mark(i,a,b if b>=0 else len(s))
  find(13,r'栋\d+-\d+')
  # Handwritten third party identification and contact lines.
  for i in [7,12,14,16]:mark(i,0,len(''.join(x['text_word'][i])))
  mark(17,0,len(''.join(x['text_word'][17])))
  s=''.join(x['text_word'][25]);mark(25,len(s)-2,len(s))
  after(31,'坐落于');find(33,r'^央广场')
 elif n==2:
  after(32,'具状人：')
 elif n==3:
  mark(11,0,len(''.join(x['text_word'][11])))
  mark(22,0,len(''.join(x['text_word'][22])))
 # Merge touching tokens on the same OCR line only, never across paragraphs.
 merged=[]
 for line in sorted({k[0] for k in selected}):
  row=sorted([b for k,b in selected.items() if k[0]==line])
  for b in row:
   if merged and merged[-1][0]==line and b[0]<=merged[-1][3]+40:
    q=merged[-1];merged[-1]=(line,min(q[1],b[0]),min(q[2],b[1]),max(q[3],b[2]),max(q[4],b[3]))
   else:merged.append((line,*b))
 manual=[]
 if n==1:
  # Low-confidence handwritten signature box, reviewed against original image.
  manual=[(1345,880,1490,1008),(960,1280,1115,1400)]
 if n==3:
  # OCR missed the payment URL and page barcode: these are reviewed image regions.
  manual=[(215,1620,1470,1695),(1020,2135,1400,2275)]
 im=Image.open(f'tmp/pdfs/pdf-redaction-20/page-{n:02d}.jpg').convert('RGB');d=ImageDraw.Draw(im)
 for _,a,b,c,e in merged:d.rectangle((a-22,b-7,c+22,e+7),fill='black')
 for b in manual:d.rectangle(b,fill='black')
 im.save(base/f'redacted-{n:02d}.png');images.append(im)
 report.append({'page':n,'ocr_lines':len(x['rec_texts']),'ocr_masks':len(merged),'manual_boxes':manual})
out=Path('output/pdf/PaddleOCR-前3页精确打码试验.pdf')
images[0].save(out,save_all=True,append_images=images[1:],resolution=200)
canvas=Image.new('RGB',(1500,740),'#eeeeee')
for i,im in enumerate(images):
 im.thumbnail((480,690));canvas.paste(im,(i*500+10,25));ImageDraw.Draw(canvas).text((i*500+15,715),f'Page {i+1}',fill='black')
canvas.save(base/'preview.jpg',quality=94)
(base/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report))
