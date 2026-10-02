document.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);

    const desktopView = $('desktop-view');
    const scannerView = $('scanner-view');
    const viewfinder = $('viewfinder');
    const video = $('camera-stream');
    const frozen = $('frozen-frame');
    const scanFrame = $('scan-frame');
    const statusChip = $('status-chip');
    const progress = $('progress');
    const progressBar = $('progress-bar');
    const captureBtn = $('capture-btn');
    const torchBtn = $('torch-btn');
    const zoomPresets = $('zoom-presets');
    const resultsSheet = $('results-sheet');
    const resultsBody = $('results-body');
    const historySheet = $('history-sheet');
    const historyBody = $('history-body');
    const backdrop = $('sheet-backdrop');
    const toastEl = $('toast');

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    const BURST_FRAMES = 6;
    const BURST_INTERVAL_MS = 90;
    const MAX_UPLOAD_SIDE = 3000;    // big gallery photos are scaled down to this before OCR
    const CROP_MARGIN = 0.08;        // extra capture around the on-screen frame, per side
    const HISTORY_KEY = 'medsnap.history.v1';
    const HISTORY_MAX = 20;

    let videoTrack = null;
    let workerPromise = null;
    let busy = false;
    let cancelRequested = false;
    let cameraReady = false;
    let workerReady = false;

    // ---------- STARTUP ----------

    if (isMobile) {
        showScanner();
    } else {
        document.body.classList.add('desktop');
        desktopView.classList.remove('hidden');
        generateQRCode();
    }
    getWorker(); // start downloading the OCR engine right away

    function showScanner() {
        document.body.classList.remove('desktop');
        desktopView.classList.add('hidden');
        scannerView.classList.remove('hidden');
        startCamera();
    }

    function generateQRCode() {
        new QRCode($('qrcode'), { text: window.location.href, width: 180, height: 180 });
        if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) $('qr-warning').classList.remove('hidden');
    }

    $('use-webcam-btn').addEventListener('click', showScanner);

    // ---------- CAMERA ----------

    async function startCamera() {
        setStatus('Starting camera…');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return showCameraError(window.isSecureContext
                ? "This browser can't use the camera. Upload a photo instead."
                : 'The camera only works over HTTPS. Open this page with https://, or upload a photo instead.');
        }
        try {
            // Without explicit resolution most phones hand back 640x480, which is far too
            // small for printed dosage text. Ask for 1080p and take whatever the phone gives.
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: "environment" },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                }
            });
            video.srcObject = stream;
            videoTrack = stream.getVideoTracks()[0];
            await video.play().catch(() => {});
            await setupTrackFeatures();
            cameraReady = true;
            captureBtn.disabled = false;
            updateReadyStatus();
        } catch (err) {
            console.error("Error accessing camera: ", err);
            showCameraError(err && err.name === 'NotAllowedError'
                ? 'Camera access was blocked. Allow it in your browser settings, or upload a photo instead.'
                : 'Could not start the camera. You can upload a photo instead.');
        }
    }

    function showCameraError(message) {
        $('camera-error-text').textContent = message;
        $('camera-error').classList.remove('hidden');
        statusChip.classList.add('hidden');
    }

    // Autofocus / zoom / torch are only settable after the stream starts, and only where supported.
    async function setupTrackFeatures() {
        if (!videoTrack || !videoTrack.getCapabilities) return;
        const caps = videoTrack.getCapabilities();
        console.log("Camera capabilities:", caps, videoTrack.getSettings());

        if (caps.focusMode && caps.focusMode.includes('continuous')) {
            try { await videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); }
            catch (e) { console.warn("Continuous focus not applied", e); }
        }

        // Phones can't focus closer than ~10cm, so people hold the box too close and get blur.
        // Zooming in from further away keeps the label sharp.
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
            const levels = [1, 2, 3, 4].filter(z => z >= caps.zoom.min && z <= caps.zoom.max);
            if (levels.length > 1) {
                const current = videoTrack.getSettings().zoom || levels[0];
                levels.forEach(z => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = `${z}×`;
                    b.setAttribute('aria-pressed', String(Math.abs(z - current) < 0.05));
                    b.addEventListener('click', async () => {
                        try {
                            await videoTrack.applyConstraints({ advanced: [{ zoom: z }] });
                            zoomPresets.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
                        } catch (e) { console.warn('Zoom failed', e); }
                    });
                    zoomPresets.appendChild(b);
                });
                zoomPresets.classList.remove('hidden');
            }
        }

        if (caps.torch) {
            torchBtn.disabled = false;
            torchBtn.addEventListener('click', async () => {
                const on = torchBtn.getAttribute('aria-pressed') !== 'true';
                try {
                    await videoTrack.applyConstraints({ advanced: [{ torch: on }] });
                    torchBtn.setAttribute('aria-pressed', String(on));
                } catch (e) { toast("Couldn't switch the flash."); }
            });
        }
    }

    // ---------- OCR ENGINE ----------

    let progressCallback = null;

    // One worker for the whole session. Re-creating it per photo re-downloads and
    // re-initialises the language data every time.
    function getWorker() {
        if (!workerPromise) {
            workerPromise = (async () => {
                // English + Indonesian: labels mix INN drug names with Indonesian instructions.
                const worker = await Tesseract.createWorker(['eng', 'ind'], 1, {
                    logger: m => {
                        if (m.status === 'recognizing text' && progressCallback) progressCallback(m.progress);
                    }
                });
                await worker.setParameters({
                    preserve_interword_spaces: '1',
                    user_defined_dpi: '300',
                });
                return worker;
            })();
            workerPromise.then(updateReadyStatus, err => {
                console.error("Failed to load OCR engine", err);
                workerPromise = null;
                setStatus('Text reader failed to load — check your connection');
            });
        }
        return workerPromise;
    }

    function updateReadyStatus() {
        if (workerPromise) workerPromise.then(() => { workerReady = true; refresh(); }, () => {});
        refresh();
        function refresh() {
            if (busy || !cameraReady) return;
            if (workerReady) setStatus('Ready — aim at the ingredient list', true);
            else setStatus('Loading text reader (first time only)…');
        }
    }

    // Tesseract occasionally hits an internal error on odd images and its promise never
    // settles. Each pass gets a deadline (a few times the slowest pass seen so far); on
    // timeout or cancel the worker is thrown away and a fresh one is started.
    const EMPTY_RESULT = { text: '', confidence: 0, lines: [], words: [] };
    let slowestPassMs = 15000;
    let abortCurrentPass = null;

    // tesseract.js rejects an internal promise when a worker is terminated mid-job. The worker
    // is already gone at that point, so this specific rejection is expected noise.
    window.addEventListener('unhandledrejection', e => {
        const msg = e.reason && e.reason.message;
        if (msg && msg.includes("reading 'postMessage'")) e.preventDefault();
    });

    function resetWorker(worker) {
        workerPromise = null;
        workerReady = false;
        worker.terminate().catch(() => {});
        getWorker();
    }

    // Tesseract wants an image, the pipeline works on grayscale arrays.
    async function recognizeGray(gray, width, height, psm) {
        const worker = await getWorker();
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(width, height);
        OcrUtils.grayToRgba(gray, img.data);
        ctx.putImageData(img, 0, 0);

        const started = Date.now();
        const job = (async () => {
            await worker.setParameters({ tessedit_pageseg_mode: psm });
            return (await worker.recognize(c)).data;
        })();
        job.catch(() => {}); // if we abandon this job below, its late rejection is expected
        let timer;
        const guard = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('ocr-timeout')), Math.min(90000, slowestPassMs * 4));
            abortCurrentPass = () => reject(new Error('cancelled'));
        });
        try {
            const data = await Promise.race([job, guard]);
            slowestPassMs = Math.max(slowestPassMs, Date.now() - started);
            return data;
        } catch (err) {
            resetWorker(worker);
            if (err.message === 'ocr-timeout') {
                console.warn(`OCR pass (psm ${psm}) timed out, skipping it`);
                return EMPTY_RESULT;
            }
            throw err;
        } finally {
            clearTimeout(timer);
            abortCurrentPass = null;
        }
    }

    function cancelScan() {
        cancelRequested = true;
        setStatus('Cancelling…');
        if (abortCurrentPass) abortCurrentPass();
    }

    // ---------- STATUS / PROGRESS ----------

    function setStatus(text, ready) {
        statusChip.textContent = text;
        statusChip.classList.toggle('ready', !!ready);
    }

    function setProgress(fraction) {
        progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    }

    // ---------- CAPTURE ----------

    // Where the on-screen frame sits inside the actual video pixels (the video is shown
    // with object-fit: cover, so part of it is cropped off-screen).
    function frameRectInVideo() {
        const vw = video.videoWidth, vh = video.videoHeight;
        const vr = video.getBoundingClientRect(), fr = scanFrame.getBoundingClientRect();
        const scale = Math.max(vr.width / vw, vr.height / vh);
        const offX = (vr.width - vw * scale) / 2, offY = (vr.height - vh * scale) / 2;
        // People line text up with the bracket edges, which clips the first/last letters.
        // Grab a margin around the frame; extra context doesn't hurt the OCR.
        const mx = fr.width * CROP_MARGIN, my = fr.height * CROP_MARGIN;
        const sx = Math.max(0, (fr.left - mx - vr.left - offX) / scale);
        const sy = Math.max(0, (fr.top - my - vr.top - offY) / scale);
        return {
            sx, sy,
            sw: Math.min(vw - sx, (fr.width + 2 * mx) / scale),
            sh: Math.min(vh - sy, (fr.height + 2 * my) / scale),
        };
    }

    function measureSharpness(source) {
        const probe = document.createElement('canvas');
        const s = Math.min(1, 480 / Math.max(source.width, source.height));
        probe.width = Math.round(source.width * s);
        probe.height = Math.round(source.height * s);
        const ctx = probe.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(source, 0, 0, probe.width, probe.height);
        const px = ctx.getImageData(0, 0, probe.width, probe.height);
        return OcrUtils.sharpness(OcrUtils.toGray(px.data, probe.width, probe.height), probe.width, probe.height);
    }

    // Grab several frames and keep the sharpest one. A single frame taken the instant the
    // button is tapped is very often blurred by the tap itself or by autofocus hunting.
    async function captureSharpestFrame() {
        const { sx, sy, sw, sh } = frameRectInVideo();
        let best = null;
        for (let i = 0; i < BURST_FRAMES; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, BURST_INTERVAL_MS));
            const frame = document.createElement('canvas');
            frame.width = Math.round(sw);
            frame.height = Math.round(sh);
            frame.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, frame.width, frame.height);
            const score = measureSharpness(frame);
            if (!best || score > best.score) best = { frame, score };
        }
        console.log("Sharpest frame score:", best.score.toFixed(1));
        return best;
    }

    function freezeViewfinder() {
        frozen.width = video.videoWidth;
        frozen.height = video.videoHeight;
        frozen.getContext('2d').drawImage(video, 0, 0);
        frozen.classList.remove('hidden');
    }

    function unfreezeViewfinder() {
        frozen.classList.add('hidden');
    }

    captureBtn.addEventListener('click', async () => {
        if (busy) { cancelScan(); return; }
        if (!video.videoWidth) return;
        if (navigator.vibrate) navigator.vibrate(20);
        await runScan(async () => {
            setStatus('Hold steady…');
            const { frame, score } = await captureSharpestFrame();
            freezeViewfinder();
            return { canvas: frame, sharpness: score, source: 'camera' };
        });
    });

    // ---------- PHOTO UPLOAD ----------

    async function loadImageFile(file) {
        let bitmap;
        try {
            bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (e) {
            // Older Safari: fall back to an <img>, which also respects EXIF rotation.
            bitmap = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('Could not read that image.'));
                img.src = URL.createObjectURL(file);
            });
        }
        const w = bitmap.width || bitmap.naturalWidth, h = bitmap.height || bitmap.naturalHeight;
        const s = Math.min(1, MAX_UPLOAD_SIDE / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * s);
        canvas.height = Math.round(h * s);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    async function handleFile(file) {
        if (!file) return;
        if (!file.type.startsWith('image/')) { toast('Please choose an image file.'); return; }
        await runScan(async () => {
            const canvas = await loadImageFile(file);
            if (!scannerView.classList.contains('hidden')) {
                frozen.width = canvas.width;
                frozen.height = canvas.height;
                frozen.getContext('2d').drawImage(canvas, 0, 0);
                frozen.classList.remove('hidden');
            }
            return { canvas, sharpness: measureSharpness(canvas), source: 'photo' };
        });
    }

    ['file-input', 'file-input-desktop'].forEach(id => {
        $(id).addEventListener('change', e => {
            handleFile(e.target.files[0]);
            e.target.value = '';
        });
    });

    const dropzone = $('dropzone');
    ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
    }));
    dropzone.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));

    // ---------- SCAN ----------

    // Desktop uploads have no viewfinder on screen, so progress goes in the results sheet.
    function showSheetProgress(text) {
        let el = $('sheet-progress');
        if (!el) {
            resultsBody.innerHTML = `
                <div class="card" id="sheet-progress">
                    <p id="sheet-progress-text" style="margin:0 0 10px;font-weight:600"></p>
                    <div class="progress" style="position:relative;border-radius:4px;background:var(--surface-2)"><div id="sheet-progress-bar" style="height:100%;width:0;background:var(--primary);border-radius:4px;transition:width .25s"></div></div>
                </div>`;
            openSheet(resultsSheet);
            el = $('sheet-progress');
        }
        $('sheet-progress-text').textContent = text;
    }

    async function runScan(getImage) {
        if (busy) return;
        busy = true;
        cancelRequested = false;
        const inScanner = !scannerView.classList.contains('hidden');
        captureBtn.classList.add('busy');
        captureBtn.setAttribute('aria-label', 'Cancel scan');
        viewfinder.classList.add('scanning');
        progress.classList.remove('hidden');
        setProgress(0);

        const status = (text, fraction) => {
            if (inScanner) {
                setStatus(text);
                if (fraction !== undefined) setProgress(fraction);
            } else {
                showSheetProgress(text);
                if (fraction !== undefined && $('sheet-progress-bar')) $('sheet-progress-bar').style.width = `${Math.round(fraction * 100)}%`;
            }
        };

        try {
            const shot = await getImage();
            if (!workerReady) status('Loading text reader…');
            await getWorker();

            const { canvas } = shot;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const src = { gray: OcrUtils.toBestGray(px.data, canvas.width, canvas.height), width: canvas.width, height: canvas.height };

            let stageLabel = '';
            progressCallback = p => status(`${stageLabel} ${Math.round(p * 100)}%`, p);
            const result = await OcrUtils.runPipeline(src, recognizeGray, {
                onStage: (label) => { stageLabel = `${label}…`; status(stageLabel, 0); },
                shouldStop: () => cancelRequested,
            });
            console.log('OCR stages:', result.stages, result);

            const scan = {
                id: Date.now(),
                time: Date.now(),
                source: shot.source,
                thumb: makeThumbnail(canvas),
                text: result.text,
                lines: result.lines,
                meds: result.meds,
                unknown: result.unknown,
                blurry: shot.sharpness < 150,
            };
            if (scan.meds.length > 0) saveToHistory(scan);
            renderResults(scan);
        } catch (err) {
            if (err && err.message === 'cancelled') {
                toast('Scan cancelled.');
                closeSheets();
            } else {
                console.error("Scan failed", err);
                closeSheets();
                toast("Scanning failed. Check your internet connection (the text reader downloads on first use) and try again.");
            }
            unfreezeViewfinder();
        } finally {
            progressCallback = null;
            busy = false;
            captureBtn.classList.remove('busy');
            captureBtn.setAttribute('aria-label', 'Scan label');
            viewfinder.classList.remove('scanning');
            progress.classList.add('hidden');
            updateReadyStatus();
        }
    }

    function makeThumbnail(canvas) {
        const t = document.createElement('canvas');
        const s = Math.min(1, 240 / Math.max(canvas.width, canvas.height));
        t.width = Math.round(canvas.width * s);
        t.height = Math.round(canvas.height * s);
        t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
        return t.toDataURL('image/jpeg', 0.7);
    }

    // ---------- RESULTS ----------

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;

    function medCard(m, i) {
        const tags = [];
        if (m.dosage) {
            tags.push(m.doseUnclear
                ? `<span class="tag fuzzy" title="The unit (mg, ml…) couldn't be read. Check the package.">${escapeHtml(m.dosage)}</span>`
                : `<span class="tag dose">${escapeHtml(m.dosage)}</span>`);
        }
        if (m.brand) tags.push(`<span class="tag">Brand</span>`);
        tags.push(m.exact
            ? `<span class="tag exact">Exact match</span>`
            : `<span class="tag fuzzy" title="The label text was slightly garbled; we matched it to the closest known name.">Read as “${escapeHtml(m.matched)}”</span>`);
        return `
            <article class="med-card">
                <div class="med-main">
                    <span class="med-icon ${m.brand ? 'brand' : ''}">${icon('pill')}</span>
                    <div class="med-text">
                        <div class="med-name">${escapeHtml(m.name)}</div>
                        <div class="med-meta">${tags.join('')}</div>
                    </div>
                    <button class="med-info-btn" type="button" data-info="${escapeHtml(m.name)}" data-target="info-${i}">About</button>
                </div>
                <div class="med-info hidden" id="info-${i}"></div>
            </article>`;
    }

    function rawTextHtml(scan) {
        if (scan.lines && scan.lines.length) {
            return scan.lines.map(l => {
                if (!l.words || !l.words.length) return escapeHtml(l.text);
                return l.words.map(w => w.confidence < 60
                    ? `<span class="low" title="Low confidence">${escapeHtml(w.text)}</span>`
                    : escapeHtml(w.text)).join(' ');
            }).join('<br>');
        }
        return escapeHtml(scan.text).replace(/\n/g, '<br>');
    }

    function summaryText(scan) {
        const meds = scan.meds.map(m => `• ${m.name}${m.dosage ? ' ' + m.dosage : ''}${m.brand ? ' (brand)' : ''}`);
        return `MedSnap scan — ${new Date(scan.time).toLocaleString()}\n${meds.join('\n') || 'No medication recognised'}`;
    }

    function renderResults(scan) {
        const generics = scan.meds.filter(m => !m.brand);
        const brands = scan.meds.filter(m => m.brand);
        const bestGuess = generics[0] ? generics[0].name
                        : brands[0] ? brands[0].name
                        : scan.unknown && scan.unknown[0] ? scan.unknown[0].name : '';

        let headline;
        if (scan.meds.length) {
            headline = `<strong>${generics.length || brands.length} medication${(generics.length || brands.length) > 1 ? 's' : ''} found</strong><br><span class="muted">${new Date(scan.time).toLocaleString()}</span>`;
        } else if (!scan.text) {
            headline = `<strong>No readable text</strong><br><span class="muted">Try again closer, steadier or with more light.</span>`;
        } else {
            headline = `<strong>No known medication name</strong><br><span class="muted">Check the text below or search manually.</span>`;
        }

        const notes = [];
        if (scan.blurry && !generics.length) {
            notes.push(`<div class="note warn">${icon('alert')}<span>The photo looked <strong>blurry</strong>. Hold the phone still about 15&nbsp;cm away${zoomPresets.classList.contains('hidden') ? '' : ' and use the zoom buttons'}, then try again.</span></div>`);
        }
        if (!scan.meds.length && scan.unknown && scan.unknown.length) {
            notes.push(`<div class="note warn">${icon('info')}<span>Possible ingredients not in our list: <strong>${scan.unknown.map(u => escapeHtml(`${u.name} ${u.dosage}`)).join(', ')}</strong>. Please verify.</span></div>`);
        }

        let i = 0;
        const sections = [];
        if (generics.length) sections.push(`<p class="section-label">Active ingredients</p>${generics.map(m => medCard(m, i++)).join('')}`);
        if (brands.length) sections.push(`<p class="section-label">Brand</p>${brands.map(m => medCard(m, i++)).join('')}`);

        resultsBody.innerHTML = `
            <div class="capture-preview">
                ${scan.thumb ? `<img src="${scan.thumb}" alt="Scanned label">` : ''}
                <p>${headline}</p>
            </div>
            ${notes.join('')}
            ${sections.join('')}

            <p class="section-label">${scan.meds.length ? 'Not right? Search by name' : 'Search by name'}</p>
            <form class="search-row" id="search-form">
                <input type="search" id="drug-input" value="${escapeHtml(bestGuess)}" placeholder="e.g. Paracetamol" aria-label="Medication name" autocomplete="off">
                <button class="btn btn-primary" type="submit" aria-label="Search">${icon('search')}</button>
            </form>
            <div id="search-result"></div>

            ${scan.text ? `
            <details class="raw">
                <summary>Scanned text</summary>
                <div class="raw-lines">${rawTextHtml(scan)}</div>
                <div class="raw-legend"><span class="low" style="color:var(--warn);text-decoration:underline wavy">Underlined</span> words were hard to read.</div>
            </details>` : ''}

            <div class="action-row">
                <button class="btn btn-secondary" type="button" id="copy-btn">${icon('copy')} Copy</button>
                ${navigator.share
                    ? `<button class="btn btn-secondary" type="button" id="share-btn">${icon('share')} Share</button>`
                    : `<button class="btn btn-secondary" type="button" data-close-sheet>${icon('camera')} Scan again</button>`}
            </div>
            ${navigator.share ? `<button class="btn btn-primary btn-block" type="button" data-close-sheet>${icon('camera')} Scan again</button>` : ''}

            <p class="disclaimer">MedSnap reads labels automatically and can make mistakes. Always check the package and ask a pharmacist or doctor before taking any medicine.</p>
        `;

        resultsBody.querySelectorAll('[data-info]').forEach(btn => btn.addEventListener('click', () => toggleInfo(btn)));
        resultsBody.querySelectorAll('[data-close-sheet]').forEach(b => b.addEventListener('click', closeSheets));
        $('search-form').addEventListener('submit', e => {
            e.preventDefault();
            const name = $('drug-input').value.trim();
            if (name) showInfo(name, $('search-result'));
        });
        $('copy-btn').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(summaryText(scan));
                toast('Copied to clipboard.');
            } catch (e) { toast("Couldn't copy."); }
        });
        if ($('share-btn')) {
            $('share-btn').addEventListener('click', () => {
                navigator.share({ title: 'MedSnap scan', text: summaryText(scan) }).catch(() => {});
            });
        }

        openSheet(resultsSheet);
        resultsBody.scrollTop = 0;
    }

    async function toggleInfo(btn) {
        const box = $(btn.dataset.target);
        if (!box.classList.contains('hidden')) {
            box.classList.add('hidden');
            btn.textContent = 'About';
            return;
        }
        box.classList.remove('hidden');
        btn.textContent = 'Hide';
        if (!box.dataset.loaded) {
            box.dataset.loaded = '1';
            await showInfo(btn.dataset.info, box);
        }
    }

    // ---------- DRUG INFO (Wikipedia) ----------

    const wikiCache = new Map();

    async function wikiSummary(name) {
        if (wikiCache.has(name)) return wikiCache.get(name);
        // Indonesian Wikipedia first (the app's main audience), English as a fallback.
        for (const lang of ['id', 'en']) {
            const search = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&srlimit=1&format=json&origin=*`).then(r => r.json());
            const hit = search.query && search.query.search && search.query.search[0];
            if (!hit) continue;
            const summary = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`).then(r => r.json());
            if (summary && summary.extract) {
                wikiCache.set(name, summary);
                return summary;
            }
        }
        wikiCache.set(name, null);
        return null;
    }

    async function showInfo(name, container) {
        container.innerHTML = `<p class="muted">Looking up ${escapeHtml(name)}…</p>`;
        try {
            const s = await wikiSummary(name);
            if (!s) {
                container.innerHTML = `<div class="note warn">${icon('info')}<span>No article found for “${escapeHtml(name)}”. Try the main ingredient instead (e.g. Paracetamol).</span></div>`;
                return;
            }
            const thumb = s.thumbnail && s.thumbnail.source;
            const link = s.content_urls && s.content_urls.mobile ? s.content_urls.mobile.page : s.content_urls.desktop.page;
            container.innerHTML = `
                <div class="wiki">
                    ${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : ''}
                    <div>
                        <p><strong>${escapeHtml(s.title)}</strong>${s.description ? ` — <span class="muted">${escapeHtml(s.description)}</span>` : ''}</p>
                        <p>${escapeHtml(s.extract)}</p>
                        <a href="${escapeHtml(link)}" target="_blank" rel="noopener">Read more on Wikipedia →</a>
                    </div>
                </div>`;
        } catch (error) {
            console.error("Wikipedia lookup failed:", error);
            container.innerHTML = `<div class="note bad">${icon('alert')}<span>Couldn't reach Wikipedia. Check your internet connection.</span></div>`;
        }
    }

    // ---------- HISTORY ----------

    function loadHistory() {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
        catch (e) { return []; }
    }

    function saveToHistory(scan) {
        try {
            const list = [scan, ...loadHistory()].slice(0, HISTORY_MAX);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
        } catch (e) {
            console.warn('Could not save history', e);
        }
    }

    function renderHistory() {
        const list = loadHistory();
        if (!list.length) {
            historyBody.innerHTML = `<div class="empty">${icon('history')}<p>No scans yet. Medications you scan will show up here.</p></div>`;
            return;
        }
        historyBody.innerHTML = list.map((s, idx) => `
            <button class="history-item" type="button" data-idx="${idx}">
                ${s.thumb ? `<img src="${s.thumb}" alt="">` : ''}
                <span>
                    <strong>${escapeHtml([...s.meds].sort((a, b) => a.brand - b.brand).map(m => m.name).join(', '))}</strong>
                    <small>${escapeHtml(s.meds.filter(m => m.dosage).map(m => m.dosage).join(' · '))}${s.meds.some(m => m.dosage) ? ' · ' : ''}${new Date(s.time).toLocaleString()}</small>
                </span>
            </button>`).join('') + `<button class="btn btn-ghost" type="button" id="clear-history">Clear history</button>`;
        historyBody.querySelectorAll('.history-item').forEach(b => b.addEventListener('click', () => {
            const scan = list[+b.dataset.idx];
            closeSheets();
            renderResults(scan);
        }));
        $('clear-history').addEventListener('click', () => {
            if (!confirm('Delete all saved scans from this device?')) return;
            try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
            renderHistory();
        });
    }

    $('history-btn').addEventListener('click', () => {
        renderHistory();
        openSheet(historySheet);
    });

    // ---------- SHEETS & TOAST ----------

    function openSheet(sheet) {
        [resultsSheet, historySheet].forEach(s => { if (s !== sheet) s.classList.add('hidden'); });
        sheet.classList.remove('hidden');
        backdrop.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeSheets() {
        resultsSheet.classList.add('hidden');
        historySheet.classList.add('hidden');
        backdrop.classList.add('hidden');
        document.body.style.overflow = '';
        if (!busy) unfreezeViewfinder();
    }

    backdrop.addEventListener('click', () => { if (!busy) closeSheets(); });
    document.querySelectorAll('.sheet-header [data-close-sheet]').forEach(b => b.addEventListener('click', () => {
        if (busy) cancelScan();
        closeSheets();
    }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !busy) closeSheets(); });

    let toastTimer = null;
    function toast(message) {
        toastEl.textContent = message;
        toastEl.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
    }
});
