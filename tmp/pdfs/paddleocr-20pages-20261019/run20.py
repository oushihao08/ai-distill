import os, time, json
from pathlib import Path
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
from paddleocr import PaddleOCR
out = Path('tmp/pdfs/paddleocr-20pages-20261019')
start = time.perf_counter()
ocr = PaddleOCR(lang='ch', ocr_version='PP-OCRv5', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, return_word_box=True, device='cpu', cpu_threads=4, enable_mkldnn=False)
ready = time.perf_counter()
print(json.dumps({'event':'ready','seconds':round(ready-start,3),'device':'cpu','cpu_threads':4,'model':'PP-OCRv5'}), flush=True)
for page in range(1, 21):
    t = time.perf_counter()
    results = ocr.predict(f'tmp/pdfs/pdf-redaction-20/page-{page:02d}.jpg')
    for result in results:
        result.save_to_json(str(out / f'page-{page:02d}.json'))
    elapsed = time.perf_counter() - t
    print(json.dumps({'event':'page_done','page':page,'seconds':round(elapsed,3)}), flush=True)
print(json.dumps({'event':'completed','total_seconds':round(time.perf_counter()-start,3),'ocr_seconds':round(time.perf_counter()-ready,3)}), flush=True)
