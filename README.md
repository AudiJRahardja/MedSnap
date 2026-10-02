# MedSnap

**Point your phone at a medicine box and get the active ingredients and dosages, even from blurry, tilted, sideways or glare-covered labels.**

MedSnap is a browser app (no install, no server) that reads medication labels with on-device OCR, corrects OCR mistakes against a dictionary of ~340 drug names (international + Indonesian spellings and common Indonesian brands), pairs each ingredient with its dosage, and looks it up on Wikipedia.

It started as a hackathon project; this version rebuilds the vision pipeline for accuracy and is measured with a reproducible benchmark.

## Features

- **Live camera scanner** with burst capture: grabs 6 frames and keeps the sharpest (variance of Laplacian), so the shake from tapping the button doesn't blur the shot
- **Camera control**: requests 1080p, continuous autofocus, zoom presets and flash where the phone supports them
- **Photo upload / drag-and-drop**, desktop webcam, and a QR code to hand off from desktop to phone
- **Results sheet**: ingredient cards with dosage, "read as …" notes when a typo was corrected, Wikipedia summaries (Indonesian, falling back to English), low-confidence words highlighted, copy/share
- **Scan history** stored on the device, light/dark mode, works offline after first load of the OCR model

## How the vision pipeline works

All image processing is hand-written in [`ocr-utils.js`](ocr-utils.js) (pure functions, shared by the app and the benchmark); [Tesseract.js](https://github.com/naptha/tesseract.js) (LSTM, `eng+ind`) does the character recognition.

1. **Channel selection**: picks luminance or a single R/G/B channel by Otsu between-class variance, so coloured print with the same brightness as its background stays readable
2. **Deskew**: estimates text tilt with a projection-profile search (−15° to 15°) and rotates it level; tilt otherwise splits drug names from their doses
3. **Normalise**: area-average/bilinear resize to a size Tesseract likes, contrast stretch with capped gain, unsharp mask after upscaling
4. **Multi-pass OCR with early exit**: contrast-stretched grayscale → zoom-in re-read of the text region if the print is small (word height measured from the first pass) → Bradley adaptive threshold (denoised, despeckled) for glare/shadows → inverted → 90° rotations for sideways text. It stops as soon as every dosage on the label is attached to a recognised ingredient
5. **Text correction**: fuzzy matching (Levenshtein with OCR-aware substitutions: `rn→m`, `0→o`, `l≈I`, closest-match-only to avoid Amoxicillin/Ampicillin mix-ups), dosage normalisation (`5OO rng` → `500 mg`), and line-aware ingredient↔dosage pairing. Results from all passes are merged
6. **Robustness**: per-pass watchdog restarts the OCR worker if Tesseract hangs; cancel is instant

## Accuracy

Measured with the synthetic benchmark in [`bench/`](bench). The labels are rendered with real fonts and degraded with blur, noise, glare, shadows, tilt, rotation, clutter and low light, then run through the exact pipeline the app uses.

| Test set | Labels fully read | Ingredients found | Correct dose |
|---|---|---|---|
| Hard set (64 labels, 96 ingredients), previous image pipeline (`v1`) | 55/64 | 83/96 | 72/96 |
| Hard set, current pipeline (`v2`) | **64/64** | **96/96** | **91/96** |
| Easy set (42 labels), `v2` | 42/42 | 42/42 | 41/42 |
| Same-luminance colour labels (4), `v2` | 4/4 | 4/4 | 4/4 |

`v1` is the single-pass preprocessing from the first rework (no channel selection, deskew, zoom-in or rotation). It shares the current text-correction code, so the gap isolates the image-pipeline gains. `v1` reads 0/8 sideways labels; `v2` reads 8/8. On the original 42-label set, the original hackathon code read 34/42.

The remaining dose misses are frames where glare erased the unit; the app shows those as e.g. "500 (unit unclear)" instead of guessing.

> Synthetic data isn't a substitute for real photos. Real-world accuracy still needs testing on actual medicine boxes.

## Running it

It's a static site, so serve the folder over HTTP:

```bash
python -m http.server 8000
# open http://localhost:8000
```

Phones need **HTTPS** to use the camera (e.g. deploy to GitHub Pages, or tunnel with `ngrok http 8000`). Photo upload works anywhere.

## Benchmark & tests

```bash
cd bench
npm install
npm run gen          # generate test images (needs Python + Pillow + numpy; FONT_DIR defaults to C:/Windows/Fonts)
npm run test:text    # drug matching + false-positive checks
npm run bench        # hard set: current pipeline (v2) vs original (v1)
DIR=imgs node benchmark.js v2    # easy set
DIR=color node benchmark.js v2   # colour set
npm run e2e          # browser tests (puppeteer + Chrome with a fake webcam); serve the app on :8765 first
```

## Disclaimer

MedSnap reads labels automatically and can make mistakes. Always check the package and ask a pharmacist or doctor before taking any medicine.
