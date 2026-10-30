# Self-hosted attendance face models

This directory is the pinned runtime for `assets/attendance-face.js`. Nothing is
fetched from a model CDN while employees use attendance. The application compares
the live camera with **one selected employee's enrolled template**; it does not
search a face gallery or predict demographic/emotional attributes.

## Components and license provenance

| Component | Version/source | Distribution terms |
| --- | --- | --- |
| FaceAPI browser bundle | `@vladmandic/face-api` 1.7.15 | MIT, `face-api.LICENSE.txt` |
| Tiny face detector and tiny 68-point landmarks | Weights distributed in the FaceAPI package; original face-api.js weights | Original MIT license, `original-face-api.LICENSE.txt` |
| 128-dimensional face recognition | Quantized conversion of Davis King's dlib ResNet model | Original model author explicitly releases model files into the public domain; `dlib-models.LICENSE.txt`; conversion distributed with FaceAPI |
| TensorFlow.js runtime, including WASM | 4.22.0 | Apache-2.0, `tensorflow.LICENSE.txt`; bundled notices retained in the JavaScript |

Authoritative sources reviewed:

- [FaceAPI MIT license at the archived upstream commit](https://github.com/vladmandic/face-api/blob/189226d63aabb48cb40776fd1c453ebc0fa722f1/LICENSE)
- [Original face-api.js MIT license](https://github.com/justadudewhohacks/face-api.js/blob/master/LICENSE)
- [Original model descriptions and recognition-weight attribution](https://github.com/justadudewhohacks/face-api.js#available-models)
- [Davis King's explicit model-file public-domain release](https://github.com/davisking/dlib-models#readme)
- [TensorFlow.js 4.22.0 license](https://github.com/tensorflow/tfjs/blob/tfjs-v4.22.0/LICENSE)

The detector and landmark binaries are distributed in the MIT-licensed FaceAPI
projects without a separate restrictive license override. The recognition
weights' original author provides an explicit model-file grant independently of
the library's code license. InsightFace weights and Human's FaceRes models are
not included. License/provenance statements concern these distributed artifacts,
not a guarantee of rights in every historical training image.

## Reproduction and integrity

Run `node scripts/vendor-attendance-face.mjs` explicitly to fetch the fixed npm
releases. The script validates npm's SHA-512 tarball integrity before extracting
only the required runtime/model files, obtains license notices, then records
every file's SHA-256, size, and original URL in `manifest.json`. It validates all
downloads before writing the directory. `tests/attendance-face-browser.mjs`
checks those hashes and initializes the actual networks in Chrome.

The original upstream repository was archived in February 2025. Updating models
requires deliberately changing the vendor pins and the template model ID;
existing templates from another model ID are rejected and must be reenrolled.

## Runtime and test boundaries

- WASM is preferred in a dedicated Worker, with CPU fallback. Every selected backend runs all
  three networks on synthetic pixels before becoming ready. The three WASM
  variants are self-hosted; multi-threading is disabled to work without special
  cross-origin-isolation headers. Sites with CSP need `wasm-unsafe-eval` for WASM.
- The UI captures at most 640 by 480 pixels, transfers one frame at a time to a
  same-origin Worker, and applies a 15-second inference watchdog. Cancellation or
  timeout terminates the Worker rather than leaving a running kernel behind.
  OffscreenCanvas and Worker support are required in production browsers. There
  is no model execution fallback on the UI thread. CSP also needs same-origin
  worker permission. Models stay cached in the worker after a successful check;
  a failed or cancelled UI action disposes them. Renderer OOM remains outside
  this recovery guarantee and requires testing on the deployment tablet.
- Processing happens only during the explicit enrollment/attendance action. The
  camera provider must stop its MediaStream when leaving/canceling the UI.
- Enrollment takes three distinct frontal frames automatically. Verification
  takes two distinct frontal frames. There is no head-turn/blink/consent sequence.
  Frame quality and a single visible face are required. Euclidean matching uses
  a conservative 0.48 threshold, both the template mean and two enrolled views;
  both verification frames must pass. This threshold is an operational starting
  point, not a measured false-accept rate or security certification.
- No presentation-attack/liveness model is included. Printed faces or screen
  replay can defeat ordinary face similarity. The UI must not describe this as
  spoof-proof identity authentication.
- Temporary canvas pixels and verification descriptors are discarded. Only the
  explicitly enrolled descriptor template is returned for the calling app to
  store. This module has no database/storage/upload function.
- Automated tests use synthetic pixels and mocked descriptors only. They confirm
  real model initialization, backend fallback, input quality rejection and the
  matching contract; they do not measure human matching accuracy or claim tested
  SM-T515 speed. Performance and acceptance on the actual tablet require a live,
  authorized on-device trial with its camera and lighting.
