/**
 * 职责：按 GLM 像素坐标计划，把白色遮盖框和假名文字直接绘制进 PDF 页面内容流，输出与原件同尺寸的矢量 PDF。
 * 适用前提：扫描件 PDF（无文字层）；遮盖烘焙进内容，不依赖查看器的注释渲染。
 * 入口：swift scripts/diagnostics/redact-pdf-native.swift <原PDF> <mask-plan.private.json> <输出PDF>
 * 使用场景：独立打码验证；只读原件，不调用模型/OCR，不修改现有业务数据。
 */
import Foundation
import AppKit
import PDFKit
import CoreGraphics
import CoreText

struct Mask: Decodable {
    let page: Int
    let rect: [Double]
    let replacement: String
    let page_width: Double
    let page_height: Double
}
struct Plan: Decodable { let format: String; let masks: [Mask] }

let args = CommandLine.arguments
guard args.count == 4 else { throw NSError(domain: "usage: redact-pdf-native.swift input.pdf plan.json output.pdf", code: 0) }
let input = URL(fileURLWithPath: args[1]), planURL = URL(fileURLWithPath: args[2]), output = URL(fileURLWithPath: args[3])
let plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: planURL))
guard plan.format == "glm-pixel-mask-v1", let document = PDFDocument(url: input) else { throw NSError(domain: "Invalid PDF or plan", code: 1) }
let grouped = Dictionary(grouping: plan.masks, by: { $0.page })

func makeLine(_ text: String, fontSize: CGFloat) -> (CTLine, CGFloat) {
    let font = CTFontCreateWithName("PingFangSC-Regular" as CFString, fontSize, nil)
    let attr = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor.black])
    let line = CTLineCreateWithAttributedString(attr)
    let width = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    return (line, width)
}

var mediaBox = CGRect(x: 0, y: 0, width: 595, height: 842)
guard let ctx = CGContext(output as CFURL, mediaBox: &mediaBox, nil) else { throw NSError(domain: "Cannot create output PDF", code: 2) }
var applied = 0

for pageIndex in 0..<document.pageCount {
    try autoreleasepool {
        guard let page = document.page(at: pageIndex), let pageRef = page.pageRef else { throw NSError(domain: "Missing PDF page", code: 3) }
        let bounds = page.bounds(for: .mediaBox)
        var pageBox = CGRect(origin: bounds.origin, size: bounds.size)
        ctx.beginPage(mediaBox: &pageBox)
        ctx.saveGState()
        ctx.drawPDFPage(pageRef)
        ctx.restoreGState()

        let pageMasks = grouped[pageIndex + 1] ?? []
        guard let first = pageMasks.first else { return }
        let pixelWidth = max(1, first.page_width), pixelHeight = max(1, first.page_height)
        let sx = bounds.width / pixelWidth, sy = bounds.height / pixelHeight

        for mask in pageMasks where mask.rect.count == 4 {
            let x0 = mask.rect[0], y0 = mask.rect[1], x1 = mask.rect[2], y1 = mask.rect[3]
            // GLM 坐标系为左上原点、y 向下；PDF 页面空间为左下原点、y 向上
            let rect = CGRect(x: bounds.minX + x0 * sx,
                              y: bounds.minY + (pixelHeight - y1) * sy,
                              width: (x1 - x0) * sx,
                              height: (y1 - y0) * sy)
            ctx.setFillColor(gray: 1, alpha: 1)
            ctx.fill(rect)
            applied += 1

            if !mask.replacement.isEmpty {
                var fontSize = max(6, rect.height * 0.72)
                var (line, lineWidth) = makeLine(mask.replacement, fontSize: fontSize)
                if lineWidth > rect.width * 0.94 {
                    fontSize *= rect.width * 0.94 / lineWidth
                    (line, lineWidth) = makeLine(mask.replacement, fontSize: fontSize)
                }
                ctx.saveGState()
                ctx.textPosition = CGPoint(x: rect.midX - lineWidth / 2, y: rect.midY - fontSize * 0.36)
                CTLineDraw(line, ctx)
                ctx.restoreGState()
            }
        }
    }
}
ctx.closePDF()
print("output=\(output.path) pages=\(document.pageCount) masks=\(applied)")
