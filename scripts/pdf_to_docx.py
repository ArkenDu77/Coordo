#!/usr/bin/env python3
"""High-fidelity PDF -> DOCX bridge used by the Node app.

Text-based PDFs are converted locally with pdf2docx so the original page layout,
columns, tables, images and character formatting are preserved as well as the
format allows. Scanned PDFs are handled separately by the app OCR pipeline.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: pdf_to_docx.py input.pdf output.docx", file=sys.stderr)
        return 2

    source = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2]).resolve()
    if not source.is_file():
        print(f"input file not found: {source}", file=sys.stderr)
        return 2

    try:
        from pdf2docx import Converter
    except Exception as exc:  # pragma: no cover - deployment diagnostic
        print(
            "pdf2docx is not installed in the runtime. "
            "Install the Python requirements before starting the app. "
            f"({exc})",
            file=sys.stderr,
        )
        return 3

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp.docx")
    if temporary.exists():
        temporary.unlink()

    converter = None
    try:
        converter = Converter(str(source))
        converter.convert(str(temporary), start=0, end=None)
        converter.close()
        converter = None

        if not temporary.exists() or temporary.stat().st_size < 1500:
            raise RuntimeError("converter produced an empty or invalid DOCX")

        os.replace(temporary, target)
        return 0
    except Exception as exc:
        print(f"PDF conversion failed: {exc}", file=sys.stderr)
        try:
            if converter is not None:
                converter.close()
        except Exception:
            pass
        try:
            if temporary.exists():
                temporary.unlink()
        except Exception:
            pass
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
