# 职责：按 GLM 像素坐标遮盖计划，直接修改扫描 PDF 中嵌入图像的像素（涂白，真删除）并用 china-s 字体回填假名。
# 背景：apply_redactions(PDF_REDACT_IMAGE_PIXELS) 对部分扫描图不生效，因此改为 Pixmap.set_rect 直接改像素后 replace_image。
# 输入：<原PDF> <mask-plan.private.json> <输出PDF>；遮盖计划格式 glm-pixel-mask-v1（GLM 左上原点像素坐标）。
# 边界：只读原件、纯本地图像处理与文字回填，不调用模型/OCR，不修改现有业务数据。
import json
import sys

import pymupdf


def main() -> int:
    input_pdf, plan_path, output_pdf = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(plan_path, "r", encoding="utf-8") as f:
        plan = json.load(f)
    assert plan.get("format") == "glm-pixel-mask-v1", "unexpected plan format"

    masks_by_page: dict[int, list[dict]] = {}
    for mask in plan["masks"]:
        masks_by_page.setdefault(int(mask["page"]), []).append(mask)

    doc = pymupdf.open(input_pdf)
    painted = 0
    replaced = 0
    text_written = 0

    for page_index in range(doc.page_count):
        page = doc[page_index]
        page_masks = masks_by_page.get(page_index + 1, [])
        if not page_masks:
            continue

        # 收集页面上每个图像的显示位置，把遮盖矩形换算到图像像素坐标
        placements: dict[int, list] = {}
        for img in page.get_images(full=True):
            xref = int(img[0])
            rects = page.get_image_rects(xref)
            if rects:
                placements[xref] = rects

        pix_by_xref: dict[int, pymupdf.Pixmap] = {}
        text_jobs: list[tuple] = []
        for mask in page_masks:
            x0, y0, x1, y1 = mask["rect"]
            rect = pymupdf.Rect(x0 / mask["page_width"] * page.rect.width,
                                y0 / mask["page_height"] * page.rect.height,
                                x1 / mask["page_width"] * page.rect.width,
                                y1 / mask["page_height"] * page.rect.height)
            if rect.is_empty:
                continue
            # 找到覆盖该矩形的图像
            target = None
            for xref, rects in placements.items():
                for bbox in rects:
                    if bbox.intersects(rect):
                        target = (xref, bbox)
                        break
                if target:
                    break
            if not target:
                print(f"WARN page={page_index + 1} no image covers rect {rect}", file=sys.stderr)
                continue
            xref, bbox = target
            if xref not in pix_by_xref:
                pix = pymupdf.Pixmap(doc, xref)
                if pix.alpha:
                    pix = pymupdf.Pixmap(pix, 0)
                pix_by_xref[xref] = pix
            pix = pix_by_xref[xref]
            kx = pix.width / bbox.width
            ky = pix.height / bbox.height
            irect = pymupdf.IRect(int(rect.x0 * kx) - 4, int(rect.y0 * ky) - 4,
                                  int(rect.x1 * kx) + 4, int(rect.y1 * ky) + 4)
            irect = irect & pix.irect
            if not irect.is_empty:
                pix.set_rect(irect, (255, 255, 255))
                painted += 1
            text_jobs.append((rect, mask.get("replacement") or "", float(mask.get("text_height") or (y1 - y0)), float(mask["page_height"])))

        # 涂白后的图像压回 JPEG 并替换原图（原像素被销毁）
        for xref, pix in pix_by_xref.items():
            if pix.colorspace is None:
                continue
            out = pix if pix.colorspace.n == 3 else pymupdf.Pixmap(pymupdf.csRGB, pix)
            data = out.tobytes("jpg", jpg_quality=88)
            page.replace_image(xref, stream=data)
            replaced += 1

        # 回填假名：真 PDF 文字，居中，超宽自动缩号；字号按原始行高（text_height）而非扩展后的框高
        for rect, replacement, text_height, mask_page_h in text_jobs:
            if not replacement:
                continue
            font_h = text_height / mask_page_h * page.rect.height
            fontsize = max(4.0, font_h * 0.72)
            unit = pymupdf.get_text_length(replacement, fontname="china-s", fontsize=1)
            if unit * fontsize > rect.width * 0.94:
                fontsize = max(3.0, rect.width * 0.94 / unit)
            width = unit * fontsize
            baseline = rect.y0 + rect.height / 2 + fontsize * 0.35
            page.insert_text(pymupdf.Point(rect.x0 + (rect.width - width) / 2, baseline),
                             replacement, fontname="china-s", fontsize=fontsize, color=(0, 0, 0))
            text_written += 1

    doc.save(output_pdf, garbage=4, deflate=True)
    print(f"output={output_pdf} pages={doc.page_count} painted={painted} images_replaced={replaced} texts={text_written}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
