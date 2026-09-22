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
