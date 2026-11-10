#!/usr/bin/env python3
"""Batch DOCX -> image-only PDF; --workflow first uses the shared material DOCX API. Writes PDFs and a result manifest, never uploads files."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import urllib.parse
import uuid
import re
from zipfile import ZipFile

import pypdfium2 as pdfium


def command(*args, env=None, timeout=600):
    return subprocess.run(args, env=env, check=True, capture_output=True, text=True, timeout=timeout).stdout


def office_environment(work):
    env = os.environ.copy()
    if sys.platform == "darwin":
        # Do not inherit a caller's fontconfig: an incomplete config silently produces unreadable Han glyphs.
        assets = Path("/System/Library/AssetsV2")
        directories = [Path("/System/Library/Fonts"), Path("/Library/Fonts")]
        if assets.exists():
            directories += [p for p in assets.iterdir() if p.name.startswith("com_apple_MobileAsset_Font")]
        from xml.sax.saxutils import escape
        config = work / "fonts.conf"
        config.write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>'
                          + "".join(f"<dir>{escape(str(p))}</dir>" for p in directories)
                          + f"<cachedir>{escape(str(work / 'font-cache'))}</cachedir></fontconfig>")
        env["FONTCONFIG_FILE"] = str(config)
    return env


def docx_has_chinese(source):
    with ZipFile(source) as document:
        return bool(re.search(r"[\u4e00-\u9fff]", document.read("word/document.xml").decode("utf-8")))


def verify_chinese_fonts(source, font_report):
    # Check the intermediate vector PDF before rasterizing; after rasterization font failures cannot be diagnosed.
    if not docx_has_chinese(source):
        return
    cjk = re.compile(r"(?:PingFang|Songti|Hira|Heiti|Noto(?:Sans|Serif)CJK|SourceHan|ArialUnicode|WenQuanYi|MicrosoftYaHei|SimSun)", re.I)
    fonts = [line.split() for line in font_report.splitlines()[2:] if line.strip()]
    if not any(cjk.search(row[0]) and len(row) >= 5 and row[-5] == "yes" for row in fonts):
        raise RuntimeError("Chinese text has no embedded CJK font in the converted PDF; refusing to publish")


def convert(source, destination, dpi, soffice):
    with tempfile.TemporaryDirectory(prefix="docx-image-pdf-") as temp:
        work = Path(temp)
        vector = work / "vector"
        vector.mkdir()
        env = office_environment(work)
        command(soffice, f"-env:UserInstallation={(work / 'profile').as_uri()}",
                "--headless", "--convert-to", "pdf", "--outdir", str(vector), str(source), env=env)
        intermediate = vector / (source.stem + ".pdf")
        if not intermediate.is_file():
            raise RuntimeError("LibreOffice did not produce a PDF")
        fonts = command("pdffonts", str(intermediate))
        if "NotoSansLisu" in fonts or "LastResort" in fonts:
            raise RuntimeError("Chinese font fallback failed; refusing to publish")
        verify_chinese_fonts(source, fonts)
        # Rasterize only after font validation. Build in a temporary file and publish after every page is merged.
        document = pdfium.PdfDocument(str(intermediate))
        pages = []
        for index in range(len(document)):
            page = document[index]
            image = page.render(scale=dpi / 72).to_pil().convert("RGB")
            path = work / f"{index:05d}.pdf"
            image.save(path, "PDF", resolution=dpi, quality=90)
            image.close()
            page.close()
            pages.append(str(path))
        document.close()
        if not pages:
            raise RuntimeError("Empty PDF")
        temporary_output = destination.with_suffix(".partial.pdf")
        try:
            command("pdfunite", *pages, str(temporary_output), timeout=1800)
            result = pdfium.PdfDocument(str(temporary_output))
            count = len(result)
            result.close()
            if count != len(pages):
                raise RuntimeError("Page count changed during image conversion")
            if command("pdftotext", str(temporary_output), "-").strip():
                raise RuntimeError("Output contains extractable text")
            temporary_output.replace(destination)
            return count
        finally:
            temporary_output.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=160)
    parser.add_argument("--soffice", default=shutil.which("soffice"))
    parser.add_argument("--workflow", action="append", default=[], help="Generate the shared material DOCX through the local API before conversion; repeat for batches")
    parser.add_argument("--include-images", action="store_true", help="Download the workflow's image DOCX instead of its plain archived DOCX")
    parser.add_argument("--preview-preparation-id", help="Use this matching preparation for one image workflow without changing its frozen snapshot")
    parser.add_argument("--api-url", default="http://127.0.0.1:3700")
    parser.add_argument("--asset-root", type=Path, default=Path("assets/out"))
    parser.add_argument("files", nargs="*", type=Path)
    args = parser.parse_args()
    if not args.files and not args.workflow:
        parser.error("provide DOCX files or --workflow")
    if not args.soffice or not 72 <= args.dpi <= 300:
        parser.error("soffice is required and dpi must be 72..300")
    if args.preview_preparation_id and (not args.include_images or len(args.workflow) != 1):
        parser.error("--preview-preparation-id requires --include-images and exactly one --workflow")
    if args.include_images and not args.workflow:
        parser.error("--include-images requires --workflow")
    if args.preview_preparation_id:
        try:
            args.preview_preparation_id = str(uuid.UUID(args.preview_preparation_id))
        except ValueError:
            parser.error("--preview-preparation-id must be a UUID")
    downloaded = tempfile.TemporaryDirectory(prefix="material-image-docx-") if args.include_images else None
    results = []
    for workflow in args.workflow:
        try:
            workflow = str(uuid.UUID(workflow))
        except ValueError:
            parser.error("--workflow must be a UUID")
        try:
            if args.include_images:
                query = "?" + urllib.parse.urlencode({"preview_preparation_id": args.preview_preparation_id}) if args.preview_preparation_id else ""
                url = args.api_url.rstrip("/") + f"/api/workflows/{workflow}/material-image-docx" + query
                with urllib.request.urlopen(url, timeout=180) as response:
                    content = response.read()
                if not content.startswith(b"PK\x03\x04"):
                    raise RuntimeError("Image DOCX API did not return a valid DOCX")
                source = Path(downloaded.name) / f"{workflow}.docx"
                source.write_bytes(content)
                args.files.append(source)
                continue
            url = args.api_url.rstrip("/") + f"/api/workflows/{workflow}/material-docx"
            with urllib.request.urlopen(urllib.request.Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST"), timeout=180) as response:
                exported = json.load(response)
            archive = exported.get("archive_path")
            artifacts = exported.get("artifacts")
            if not isinstance(archive, str) or not isinstance(artifacts, list) or not artifacts:
                raise RuntimeError("Material DOCX API response has no export paths")
            root = args.asset_root.resolve()
            for item in artifacts:
                filename = item.get("filename")
                if not isinstance(filename, str) or Path(filename).name != filename or not filename.endswith(".docx"):
                    raise RuntimeError("Invalid DOCX filename returned by API")
                source = (root / archive / "成果" / filename).resolve()
                if not source.is_relative_to(root):
                    raise RuntimeError("DOCX export path escapes asset root")
                args.files.append(source)
        except Exception as exc:
            results.append({"workflow": workflow, "status": "failed", "error": str(exc)})
    args.output.mkdir(parents=True, exist_ok=True)
    for source in args.files:
        if source.suffix.lower() != ".docx" or not source.is_file():
            results.append({"source": str(source), "status": "failed", "error": "Input is not an existing DOCX"})
            continue
        content_hash = hashlib.sha256()
        with source.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                content_hash.update(chunk)
        identity = hashlib.sha256(b"cjk-font-guard-v2\0" + str(source.resolve()).encode()).hexdigest()[:8] + content_hash.hexdigest()[:8]
        target = args.output / (source.stem + "-" + identity + ".pdf")
        if target.exists():
            if command("pdftotext", str(target), "-").strip():
                results.append({"source": str(source.resolve()), "status": "failed", "error": "Existing PDF contains text"})
            else:
                existing = pdfium.PdfDocument(str(target))
                results.append({"source": str(source.resolve()), "output": str(target.resolve()), "pages": len(existing), "status": "reused"})
                existing.close()
            continue
        try:
            count = convert(source.resolve(), target, args.dpi, args.soffice)
            results.append({"source": str(source.resolve()), "output": str(target.resolve()), "pages": count, "status": "ok"})
        except Exception as exc:
            results.append({"source": str(source.resolve()), "status": "failed", "error": str(exc)})
    manifest = args.output / "results.json"
    manifest.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(results, ensure_ascii=False, indent=2))
    if downloaded:
        downloaded.cleanup()
    return 1 if any(item["status"] == "failed" for item in results) else 0


if __name__ == "__main__":
    sys.exit(main())
