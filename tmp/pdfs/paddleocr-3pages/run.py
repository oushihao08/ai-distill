import os,time,json
from pathlib import Path
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK']='True'
from paddleocr import PaddleOCR
out=Path('tmp/pdfs/paddleocr-3pages')
t=time.perf_counter()
ocr=PaddleOCR(lang='ch',ocr_version='PP-OCRv5',use_doc_orientation_classify=False,use_doc_unwarping=False,use_textline_orientation=False,return_word_box=True,device='cpu',cpu_threads=4,enable_mkldnn=False)
print(json.dumps({'event':'ready','seconds':round(time.perf_counter()-t,2)}),flush=True)
for n in range(1,4):
 start=time.perf_counter()
 results=ocr.predict(f'tmp/pdfs/pdf-redaction-20/page-{n:02d}.jpg')
 for result in results:
  result.save_to_json(str(out/f'page-{n:02d}.json'))
 print(json.dumps({'event':'page_done','page':n,'seconds':round(time.perf_counter()-start,2)}),flush=True)
print(json.dumps({'event':'completed','seconds':round(time.perf_counter()-t,2)}),flush=True)
