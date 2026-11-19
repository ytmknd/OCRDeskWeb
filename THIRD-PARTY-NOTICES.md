# Third-party notices

OCRDesk Web is licensed under the [MIT License](LICENSE), except for the files noted below. It uses the following third-party components. OCRDesk Web is not affiliated with, endorsed by, or sponsored by Baidu, PaddlePaddle, PaddleOCR, RapidOCR, Microsoft, or Mozilla.

## Included in this repository

### PP-OCRv6 Small models (`models/`)

| File | Upstream model | SHA-256 |
| --- | --- | --- |
| `PP-OCRv6_det_small.onnx` | [PaddlePaddle/PP-OCRv6_small_det](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det) | `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f` |
| `PP-OCRv6_rec_small.onnx` | [PaddlePaddle/PP-OCRv6_small_rec](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec) | `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884` |
| `PP-OCRv6_rec_small.keys.txt` | Character table, extracted unchanged from the `character` metadata of `PP-OCRv6_rec_small.onnx` | — |

- Copyright: Baidu and/or the applicable PaddleOCR rights holders.
- License: Apache License, Version 2.0 ([LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)).
- Source of the ONNX files: [RapidOCR](https://github.com/RapidAI/RapidOCR) v3.9.2 model distribution ([ModelScope](https://www.modelscope.cn/models/RapidAI/RapidOCR)).
- Modification notice (from RapidOCR): converted from an official PaddleOCR model to the ONNX inference format and packaged for use with RapidOCR. The upstream model weights are copyright Baidu and/or the applicable PaddleOCR rights holders and are licensed under the Apache License, Version 2.0.
- OCRDesk Web redistributes the ONNX files unchanged. The character table was extracted from the model metadata into a text file because onnxruntime-web cannot read custom model metadata.

### Code ported from RapidOCR / PaddleOCR (`src/ocr/detector.js`, `src/ocr/recognizer.js`, `src/ocr/engine.js`)

Portions of these files are JavaScript translations of the text detection pre/post-processing (DB post-processing), text recognition pre/post-processing (CTC decoding), and OCR pipeline of RapidOCR, which derive from PaddleOCR.

- Copyright: RapidOCR Authors; PaddlePaddle Authors.
- License: Apache License, Version 2.0 ([LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)).
- Changes: translated from Python to JavaScript by ytmknd (2026), with OpenCV operations reimplemented. Each file carries a notice stating this.

## Loaded at run time from jsDelivr (not included in this repository)

### ONNX Runtime Web 1.31.1

- <https://github.com/microsoft/onnxruntime> — Copyright (c) Microsoft Corporation.
- License: MIT License.

### PDF.js (pdfjs-dist) 6.5.438

- <https://github.com/mozilla/pdf.js> — Copyright Mozilla Foundation and contributors.
- License: Apache License, Version 2.0 ([LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)).
