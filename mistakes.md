# Mistakes

Real mistakes made on this project, why they happened, and what fixed them.
Not a general lessons/style guide — only things that actually went wrong.

## Desktop document detection: text density is not "this is paper" (2026-09-22)

**What went wrong:** the desktop's document classifier (`desktop/documents.js`)
only measures how much of a photo's area is covered by OCR-detected text
lines (`MIN_COVERAGE`, calibrated against the phone's real classification
outcomes). It has no equivalent of the phone's first gate. A photo of a
computer screen full of dense text (a Windows settings page, a spreadsheet,
a webpage) can easily clear the same text-coverage threshold as a real photo
of a printed document, and gets misclassified as "Document: Yes".

**Why it happened:** the phone (`PhotoClassifier.kt`) never runs OCR at all
unless ML Kit's image labeler first tags the photo `"paper"`
(`isPaperPhoto()`, `PhotoClassifier.kt:120`) — that's the actual signal for
"this is a physical document," and OCR only measures how much text is on it
once that's established. The desktop has no image-labeling model, so
`documents.js`'s comment explicitly says text coverage "replaces the phone's
paper gate" — but a coverage percentage is a proxy for "how much text," not
for "is this paper," and the two came apart on a plain screen photo. The
2026-09-22 calibration set (18 documents, 60 non-documents: watermarks,
signs, shirts, a notebook page) didn't include screen photos, so the gap
wasn't caught before it shipped.

**Fix:** none yet — this needs a real substitute for the phone's paper label,
not a better coverage threshold. A pure text-density heuristic will keep
missing this category no matter how it's tuned, because "lots of text" and
"is paper" are genuinely different questions. Options: bundle a small
image classifier (desktop already has `onnxruntime-node` for the OCR and
face models, so no new dependency, just a new small model file) that
detects paper/document-like material before OCR runs; or approximate it
with a cheaper signal (e.g. screen photos tend to have very regular
line spacing and a display's aspect-ratio-shaped bright rectangle, unlike a
page of paper on a table) — needs testing against real screen-photo cases,
same way the OCR threshold was.

**Lesson:** when replacing a model-based gate with a proxy metric, calibrate
against the failure category the original gate specifically existed to
reject, not just against the positive cases the proxy is good at.
