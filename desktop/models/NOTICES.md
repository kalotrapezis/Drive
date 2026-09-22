# Bundled models

## mobilefacenet.onnx — face embeddings (Apache License 2.0)

Converted on 2026-09-22 from the phone app's `mobilefacenet.tflite`
(SHA-256 `be4bc7cfc53f7bc336d0f28b1ab92535f618c913a422b683210750f6b5354854`,
from `hugocornellier/face_detection_tflite`, Apache 2.0) with
`tf2onnx 1.16.1 --tflite --opset 13`. On random inputs the ONNX and TFLite
outputs agree to cosine 0.9999999, so desktop and phone embeddings are
interchangeable. SHA-256 of this file:
`70a77b4ab2fac2a0749bb0765d3ae838ae3e0312101cb786ae8bf1afd051ec19`.

## face_detection_yunet_2023mar.onnx — face detection (MIT)

YuNet from `opencv/opencv_zoo`, `models/face_detection_yunet/`, retrieved
2026-09-22. MIT License, Copyright (c) 2020 Shiqi Yu. SHA-256
`8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`.
Used instead of ML Kit (Android only); only its eye landmarks feed the
embedding, aligned exactly as the phone does.

## text_detection_ppocrv4.onnx — text detection (Apache License 2.0)

PaddleOCR PP-OCRv4 detection model (`ch_PP-OCRv4_det_infer.onnx`) as published
by RapidOCR (`huggingface.co/SWHL/RapidOCR`, Apache 2.0), retrieved 2026-09-22.
SHA-256 `d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9`.
Only the text-line probability map is used (no recognition).

## scene_efficientnet_lite0.onnx, scene_labels.txt — scene labels (Apache License 2.0)

Converted on 2026-09-22 from the phone app's MediaPipe `efficientnet_lite0.tflite`
(SHA-256 `bc2ffe19c1118de0c0c2a9088992da5589722656e0fba81421385300a4a34b16`)
with `tf2onnx 1.16.1 --tflite --opset 13 --dequantize`; labels are the model's
embedded `labels_without_background.txt`. With the phone's rule (top 5, score ≥
0.15) the label sets matched TFLite on 14 of 15 test photos (the other differed
at 0.16 vs 0.15). SHA-256
`10f602179d3d3b76d7205c8e2d492b1afda372866ba5667ecaf6d8ecb81b65d6`.
