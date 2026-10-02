// Pure helpers for MedSnap's OCR pipeline: image preprocessing, frame sharpness,
// and post-OCR text cleanup / drug-name matching. No DOM access here, so this file
// also runs under Node for testing (see module.exports at the bottom).
(function (global) {

    // ---------- IMAGE PROCESSING ----------
    // All functions work on a grayscale Uint8ClampedArray plus width/height.

    function toGray(rgba, width, height) {
        const gray = new Uint8ClampedArray(width * height);
        for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
            gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        }
        return gray;
    }

    // Otsu's between-class variance: how cleanly the pixels split into "ink" and "paper".
    function bimodality(hist, total) {
        let sumAll = 0;
        for (let v = 0; v < 256; v++) sumAll += v * hist[v];
        let wB = 0, sumB = 0, best = 0;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            const wF = total - wB;
            if (wF === 0) break;
            sumB += t * hist[t];
            const mB = sumB / wB, mF = (sumAll - sumB) / wF;
            const between = wB * wF * (mB - mF) * (mB - mF);
            if (between > best) best = between;
        }
        return best / (total * total);
    }

    // Like toGray, but on coloured packaging picks whichever of luminance / R / G / B gives the
    // strongest text-vs-background separation. White print on blue, red print on yellow etc.
    // can be nearly invisible in plain luminance but crisp in a single channel.
    function toBestGray(rgba, width, height) {
        const weights = [[0.299, 0.587, 0.114], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const hists = weights.map(() => new Uint32Array(256));
        const step = Math.max(1, Math.floor(width * height / 200000));
        let n = 0;
        for (let p = 0; p < width * height; p += step, n++) {
            const i = p * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
            weights.forEach(([wr, wg, wb], k) => hists[k][Math.round(wr * r + wg * g + wb * b)]++);
        }
        const scores = hists.map(h => bimodality(h, n));
        let best = 0;
        // A single channel has to be clearly better than luminance to be worth switching to.
        for (let k = 1; k < 4; k++) if (scores[k] > scores[best] * 1.25) best = k;
        if (best === 0) return toGray(rgba, width, height);
        const gray = new Uint8ClampedArray(width * height);
        for (let i = best - 1, p = 0; p < gray.length; i += 4, p++) gray[p] = rgba[i];
        return gray;
    }

    function grayToRgba(gray, rgba) {
        for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
            rgba[i] = rgba[i + 1] = rgba[i + 2] = gray[p];
            rgba[i + 3] = 255;
        }
        return rgba;
    }

    // Variance of the Laplacian: higher = sharper. Used to pick the least blurry frame of a burst.
    function sharpness(gray, width, height) {
        let sum = 0, sumSq = 0, n = 0;
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                const lap = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
                sum += lap;
                sumSq += lap * lap;
                n++;
            }
        }
        if (n === 0) return 0;
        const mean = sum / n;
        return sumSq / n - mean * mean;
    }

    // Stretch the histogram so the darkest 0.2% maps to black and brightest 0.2% to white.
    // Fixes washed-out / dim photos without destroying detail like a hard threshold would.
    // Gain is capped: on a near-uniform frame with only a little text, an uncapped stretch
    // blows sensor noise up to full contrast and buries the letters.
    function stretchContrast(gray) {
        const hist = new Uint32Array(256);
        for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
        const cut = gray.length * 0.002;
        let lo = 0, hi = 255, acc = 0;
        while (lo < 255 && (acc += hist[lo]) < cut) lo++;
        acc = 0;
        while (hi > 0 && (acc += hist[hi]) < cut) hi--;
        const out = new Uint8ClampedArray(gray.length);
        if (hi - lo < 10) { out.set(gray); return out; }
        const scale = Math.min(2.5, 255 / (hi - lo));
        const mid = (lo + hi) / 2;
        for (let i = 0; i < gray.length; i++) out[i] = 128 + (gray[i] - mid) * scale;
        return out;
    }

    // Light unsharp mask (3x3 box blur based) to crisp up letter edges after upscaling.
    function sharpen(gray, width, height, amount) {
        const out = new Uint8ClampedArray(gray.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (x === 0 || y === 0 || x === width - 1 || y === height - 1) { out[i] = gray[i]; continue; }
                const blur = (
                    gray[i - width - 1] + gray[i - width] + gray[i - width + 1] +
                    gray[i - 1] + gray[i] + gray[i + 1] +
                    gray[i + width - 1] + gray[i + width] + gray[i + width + 1]
                ) / 9;
                out[i] = gray[i] + amount * (gray[i] - blur);
            }
        }
        return out;
    }

    const MIN_INK_CONTRAST = 18;

    function boxBlur3(gray, width, height) {
        const out = new Uint8ClampedArray(gray.length);
        for (let y = 0; y < height; y++) {
            const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1);
            for (let x = 0; x < width; x++) {
                const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1);
                let sum = 0;
                for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) sum += gray[yy * width + xx];
                out[y * width + x] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1));
            }
        }
        return out;
    }

    // Bradley adaptive threshold: each pixel is compared to the mean of its neighbourhood,
    // so glare, shadows and coloured packaging don't wipe out whole regions like a global
    // threshold does. Output is always dark text on a white background.
    function adaptiveThreshold(gray, width, height) {
        // Smooth sensor noise first, otherwise dim, grainy photos turn into a field of specks
        // (which also makes Tesseract hang trying to box them all).
        gray = boxBlur3(gray, width, height);
        const integral = new Float64Array((width + 1) * (height + 1));
        for (let y = 0; y < height; y++) {
            let rowSum = 0;
            for (let x = 0; x < width; x++) {
                rowSum += gray[y * width + x];
                integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + rowSum;
            }
        }
        const half = Math.max(8, Math.floor(Math.max(width, height) / 32));
        const t = 0.15;
        const out = new Uint8ClampedArray(gray.length);
        let darkCount = 0;
        for (let y = 0; y < height; y++) {
            const y0 = Math.max(0, y - half), y1 = Math.min(height - 1, y + half);
            for (let x = 0; x < width; x++) {
                const x0 = Math.max(0, x - half), x1 = Math.min(width - 1, x + half);
                const count = (x1 - x0 + 1) * (y1 - y0 + 1);
                const sum = integral[(y1 + 1) * (width + 1) + x1 + 1] - integral[y0 * (width + 1) + x1 + 1]
                          - integral[(y1 + 1) * (width + 1) + x0] + integral[y0 * (width + 1) + x0];
                const i = y * width + x;
                // Must be darker than the neighbourhood by a relative AND an absolute margin, so
                // flat background areas (where only noise varies) stay white.
                const mean = sum / count;
                const dark = gray[i] < mean * (1 - t) && mean - gray[i] > MIN_INK_CONTRAST;
                out[i] = dark ? 0 : 255;
                if (dark) darkCount++;
            }
        }
        // Despeckle: an isolated dark pixel (fewer than 2 dark neighbours) is noise, not ink.
        const isolated = [];
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                if (out[i] !== 0) continue;
                let n = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && out[i + dy * width + dx] === 0) n++;
                if (n < 2) isolated.push(i);
            }
        }
        isolated.forEach(i => { out[i] = 255; });
        darkCount -= isolated.length;

        // If most of the image came out dark, the label is light text on a dark background: flip it.
        if (darkCount > out.length / 2) {
            for (let i = 0; i < out.length; i++) out[i] = 255 - out[i];
        }
        return out;
    }

    function invert(gray) {
        const out = new Uint8ClampedArray(gray.length);
        for (let i = 0; i < gray.length; i++) out[i] = 255 - gray[i];
        return out;
    }

    // Resize a grayscale image: area-averaging when shrinking (no aliasing on big gallery
    // photos), bilinear when enlarging.
    function resizeGray(gray, width, height, newW, newH) {
        newW = Math.max(1, Math.round(newW));
        newH = Math.max(1, Math.round(newH));
        const out = new Uint8ClampedArray(newW * newH);
        const sx = width / newW, sy = height / newH;
        if (sx >= 1 && sy >= 1) {
            for (let y = 0; y < newH; y++) {
                const y0 = Math.floor(y * sy), y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
                for (let x = 0; x < newW; x++) {
                    const x0 = Math.floor(x * sx), x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
                    let sum = 0;
                    for (let yy = y0; yy < y1; yy++) {
                        const row = yy * width;
                        for (let xx = x0; xx < x1; xx++) sum += gray[row + xx];
                    }
                    out[y * newW + x] = sum / ((y1 - y0) * (x1 - x0));
                }
            }
            return out;
        }
        for (let y = 0; y < newH; y++) {
            const fy = Math.max(0, (y + 0.5) * sy - 0.5);
            const y0 = Math.min(height - 1, Math.floor(fy)), y1 = Math.min(height - 1, y0 + 1), dy = fy - y0;
            for (let x = 0; x < newW; x++) {
                const fx = Math.max(0, (x + 0.5) * sx - 0.5);
                const x0 = Math.min(width - 1, Math.floor(fx)), x1 = Math.min(width - 1, x0 + 1), dx = fx - x0;
                const top = gray[y0 * width + x0] * (1 - dx) + gray[y0 * width + x1] * dx;
                const bottom = gray[y1 * width + x0] * (1 - dx) + gray[y1 * width + x1] * dx;
                out[y * newW + x] = top * (1 - dy) + bottom * dy;
            }
        }
        return out;
    }

    function cropGray(gray, width, height, x, y, w, h) {
        x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
        w = Math.min(width - x, Math.ceil(w)); h = Math.min(height - y, Math.ceil(h));
        const out = new Uint8ClampedArray(w * h);
        for (let row = 0; row < h; row++) {
            out.set(gray.subarray((y + row) * width + x, (y + row) * width + x + w), row * w);
        }
        return { gray: out, width: w, height: h };
    }

    // Rotate 90 degrees: dir = 1 clockwise, -1 counter-clockwise.
    function rotateGray(gray, width, height, dir) {
        const out = new Uint8ClampedArray(gray.length);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const nx = dir > 0 ? height - 1 - y : y;
                const ny = dir > 0 ? x : width - 1 - x;
                out[ny * height + nx] = gray[y * width + x];
            }
        }
        return { gray: out, width: height, height: width };
    }

    // Rotate by an arbitrary angle (degrees, positive = counter-clockwise as seen on screen),
    // growing the canvas so no corner gets cut off. New area is filled with `fill`.
    function rotateArbitrary(gray, width, height, degrees, fill) {
        const a = degrees * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
        const newW = Math.round(Math.abs(width * cos) + Math.abs(height * sin));
        const newH = Math.round(Math.abs(width * sin) + Math.abs(height * cos));
        const out = new Uint8ClampedArray(newW * newH);
        const cx = width / 2, cy = height / 2, ncx = newW / 2, ncy = newH / 2;
        for (let y = 0; y < newH; y++) {
            for (let x = 0; x < newW; x++) {
                // inverse-map each output pixel back into the source
                const dx = x - ncx, dy = y - ncy;
                const sx = dx * cos - dy * sin + cx, sy = dx * sin + dy * cos + cy;
                const x0 = Math.floor(sx), y0 = Math.floor(sy);
                if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) { out[y * newW + x] = fill; continue; }
                const fx = sx - x0, fy = sy - y0, i = y0 * width + x0;
                out[y * newW + x] = (gray[i] * (1 - fx) + gray[i + 1] * fx) * (1 - fy)
                                  + (gray[i + width] * (1 - fx) + gray[i + width + 1] * fx) * fy;
            }
        }
        return { gray: out, width: newW, height: newH };
    }

    // Estimate how many degrees the text lines are tilted, using a projection profile: when the
    // image is rotated so lines are level, the row-by-row ink counts become sharply peaked.
    function estimateSkew(gray, width, height) {
        const s = Math.min(1, 600 / Math.max(width, height));
        const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
        const small = s < 1 ? resizeGray(gray, width, height, w, h) : gray;
        const bin = adaptiveThreshold(small, w, h);
        const xs = [], ys = [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bin[y * w + x] === 0) { xs.push(x - w / 2); ys.push(y - h / 2); }
        if (xs.length < 200 || xs.length > w * h * 0.4) return 0;

        const diag = Math.ceil(Math.hypot(w, h));
        const rows = new Float64Array(2 * diag + 1);
        const profileScore = (deg) => {
            const a = deg * Math.PI / 180, sin = Math.sin(a), cos = Math.cos(a);
            rows.fill(0);
            for (let i = 0; i < xs.length; i++) rows[Math.round(ys[i] * cos - xs[i] * sin) + diag]++;
            let sq = 0;
            for (let i = 0; i < rows.length; i++) sq += rows[i] * rows[i];
            return sq;
        };
        let best = 0, bestScore = profileScore(0);
        const zeroScore = bestScore;
        for (let deg = -15; deg <= 15; deg += 0.5) {
            const sc = profileScore(deg);
            if (sc > bestScore) { bestScore = sc; best = deg; }
        }
        for (let deg = best - 0.4; deg <= best + 0.4; deg += 0.1) {
            const sc = profileScore(deg);
            if (sc > bestScore) { bestScore = sc; best = deg; }
        }
        // Small or unconvincing tilts aren't worth resampling the image for.
        if (Math.abs(best) < 1 || bestScore < zeroScore * 1.15) return 0;
        return Math.round(best * 10) / 10;
    }

    function median(gray) {
        const hist = new Uint32Array(256);
        for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
        let acc = 0;
        for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= gray.length / 2) return v;
        return 255;
    }

    // Level out tilted text. Returns the input unchanged when it's already straight.
    function deskew(src) {
        const angle = estimateSkew(src.gray, src.width, src.height);
        if (angle === 0) return { ...src, angle: 0 };
        return { ...rotateArbitrary(src.gray, src.width, src.height, angle, median(src.gray)), angle };
    }

    // Scale so the long side is ~targetLong (never more than maxScale), then even out contrast.
    function prepare(src, targetLong, maxScale) {
        const scale = Math.min(maxScale, targetLong / Math.max(src.width, src.height));
        const width = Math.round(src.width * scale), height = Math.round(src.height * scale);
        const resized = scale === 1 ? src.gray : resizeGray(src.gray, src.width, src.height, width, height);
        const stretched = stretchContrast(resized);
        // Only sharpen when we upscaled (upscaling softens edges); otherwise it just amplifies noise.
        const gray = scale > 1.5 ? sharpen(stretched, width, height, 0.6) : stretched;
        return { gray, width, height, scale };
    }

    // ---------- TEXT POST-PROCESSING ----------

    // Generic names (English INN + Indonesian spelling) and common Indonesian brands.
    // Each group: first entry is the display name, the rest are spellings that map to it.
    const DRUG_GROUPS = [
        ['Paracetamol', 'parasetamol', 'acetaminophen', 'asetaminofen'],
        ['Ibuprofen'],
        ['Amoxicillin', 'amoksisilin', 'amoxycillin'],
        ['Mefenamic acid', 'asam mefenamat', 'mefenamat'],
        ['Acetylsalicylic acid', 'asam asetilsalisilat', 'aspirin', 'asetosal'],
        ['Caffeine', 'kafein', 'coffeine', 'cofein'],
        ['Diclofenac', 'diklofenak', 'natrium diklofenak', 'kalium diklofenak', 'diclofenac sodium', 'diclofenac potassium'],
        ['Meloxicam', 'meloksikam'],
        ['Piroxicam', 'piroksikam'],
        ['Ketoprofen'],
        ['Naproxen', 'naproksen'],
        ['Tramadol'],
        ['Codeine', 'kodein'],
        ['Metamizole', 'metampiron', 'antalgin', 'dipyrone'],
        ['Ambroxol', 'ambroksol'],
        ['Bromhexine', 'bromheksin'],
        ['Guaifenesin', 'gliseril guaiakolat', 'glyceryl guaiacolate'],
        ['Dextromethorphan', 'dekstrometorfan', 'dextromethorphan hbr'],
        ['Phenylephrine', 'fenilefrin', 'phenylephrine hcl'],
        ['Pseudoephedrine', 'pseudoefedrin'],
        ['Chlorpheniramine maleate', 'klorfeniramin maleat', 'chlorphenamine', 'chlorpheniramine', 'klorfeniramin'],
        ['Diphenhydramine', 'difenhidramin'],
        ['Cetirizine', 'setirizin', 'cetirizin'],
        ['Loratadine', 'loratadin'],
        ['Dimenhydrinate', 'dimenhidrinat'],
        ['Dexamethasone', 'deksametason'],
        ['Prednisone', 'prednison'],
        ['Methylprednisolone', 'metilprednisolon'],
        ['Hydrocortisone', 'hidrokortison'],
        ['Omeprazole', 'omeprazol'],
        ['Lansoprazole', 'lansoprazol'],
        ['Ranitidine', 'ranitidin'],
        ['Famotidine', 'famotidin'],
        ['Antacid', 'antasida'],
        ['Aluminium hydroxide', 'aluminium hidroksida', 'aluminum hydroxide'],
        ['Magnesium hydroxide', 'magnesium hidroksida'],
        ['Simethicone', 'simetikon', 'dimethicone', 'dimetikon'],
        ['Sucralfate', 'sukralfat'],
        ['Domperidone', 'domperidon'],
        ['Metoclopramide', 'metoklopramid'],
        ['Ondansetron'],
        ['Loperamide', 'loperamid'],
        ['Attapulgite', 'attapulgit', 'atapulgit'],
        ['Bisacodyl', 'bisakodil'],
        ['Lactulose', 'laktulosa'],
        ['Ciprofloxacin', 'siprofloksasin'],
        ['Levofloxacin', 'levofloksasin'],
        ['Azithromycin', 'azitromisin'],
        ['Erythromycin', 'eritromisin'],
        ['Clarithromycin', 'klaritromisin'],
        ['Clindamycin', 'klindamisin'],
        ['Cefadroxil', 'sefadroksil'],
        ['Cefixime', 'sefiksim'],
        ['Cephalexin', 'sefaleksin', 'cefalexin'],
        ['Ampicillin', 'ampisilin'],
        ['Cotrimoxazole', 'kotrimoksazol', 'co-trimoxazole', 'sulfamethoxazole', 'sulfametoksazol', 'trimethoprim', 'trimetoprim'],
        ['Metronidazole', 'metronidazol'],
        ['Tetracycline', 'tetrasiklin'],
        ['Doxycycline', 'doksisiklin'],
        ['Chloramphenicol', 'kloramfenikol'],
        ['Acyclovir', 'asiklovir', 'aciclovir'],
        ['Fluconazole', 'flukonazol'],
        ['Ketoconazole', 'ketokonazol'],
        ['Miconazole', 'mikonazol'],
        ['Nystatin', 'nistatin'],
        ['Albendazole', 'albendazol'],
        ['Mebendazole', 'mebendazol'],
        ['Pyrantel pamoate', 'pirantel pamoat', 'pyrantel', 'pirantel'],
        ['Metformin'],
        ['Glibenclamide', 'glibenklamid'],
        ['Glimepiride', 'glimepirid'],
        ['Amlodipine', 'amlodipin'],
        ['Nifedipine', 'nifedipin'],
        ['Captopril', 'kaptopril'],
        ['Lisinopril'],
        ['Ramipril'],
        ['Valsartan'],
        ['Candesartan', 'kandesartan'],
        ['Losartan'],
        ['Irbesartan'],
        ['Bisoprolol'],
        ['Propranolol'],
        ['Furosemide', 'furosemid'],
        ['Hydrochlorothiazide', 'hidroklorotiazid'],
        ['Spironolactone', 'spironolakton'],
        ['Simvastatin'],
        ['Atorvastatin'],
        ['Rosuvastatin'],
        ['Clopidogrel', 'klopidogrel'],
        ['Warfarin'],
        ['Allopurinol', 'alopurinol'],
        ['Colchicine', 'kolkisin'],
        ['Salbutamol', 'albuterol'],
        ['Theophylline', 'teofilin'],
        ['Montelukast'],
        ['Ascorbic acid', 'asam askorbat'],
        ['Folic acid', 'asam folat'],
        ['Cyanocobalamin', 'sianokobalamin'],
        ['Pyridoxine', 'piridoksin', 'pyridoxine hcl'],
        ['Thiamine', 'tiamin', 'thiamine mononitrate'],
        ['Ferrous sulfate', 'ferro sulfat', 'ferrous fumarate', 'ferro fumarat'],
        ['Calcium carbonate', 'kalsium karbonat'],
        ['Zinc', 'zinc sulfate', 'zink'],
        ['Oralit', 'oral rehydration salts'],
        ['Povidone iodine', 'povidon iodin'],
        ['Esomeprazole', 'esomeprazol'],
        ['Pantoprazole', 'pantoprazol'],
        ['Cimetidine', 'simetidin'],
        ['Rebamipide', 'rebamipid'],
        ['Hyoscine butylbromide', 'hiosin butilbromida', 'butylscopolamine', 'hyoscine'],
        ['Mebeverine', 'mebeverin'],
        ['Bismuth subsalicylate', 'bismut subsalisilat'],
        ['Kaolin', 'kaolin pectin'],
        ['Activated charcoal', 'karbon aktif', 'carbo adsorbens'],
        ['Etoricoxib', 'etorikoksib'],
        ['Celecoxib', 'selekoksib'],
        ['Ketorolac', 'ketorolak'],
        ['Eperisone', 'eperison'],
        ['Glucosamine', 'glukosamin'],
        ['Gabapentin'],
        ['Pregabalin'],
        ['Diazepam'],
        ['Alprazolam'],
        ['Clonazepam', 'klonazepam'],
        ['Amitriptyline', 'amitriptilin'],
        ['Fluoxetine', 'fluoksetin'],
        ['Sertraline', 'sertralin'],
        ['Haloperidol'],
        ['Risperidone', 'risperidon'],
        ['Levothyroxine', 'levotiroksin'],
        ['Thiamazole', 'tiamazol', 'methimazole'],
        ['Propylthiouracil', 'propiltiourasil'],
        ['Isoniazid'],
        ['Rifampicin', 'rifampisin', 'rifampin'],
        ['Pyrazinamide', 'pirazinamid'],
        ['Ethambutol', 'etambutol'],
        ['Oseltamivir'],
        ['Valacyclovir', 'valasiklovir', 'valaciclovir'],
        ['Ivermectin', 'ivermektin'],
        ['Praziquantel', 'prazikuantel'],
        ['Chloroquine', 'klorokuin'],
        ['Hydroxychloroquine', 'hidroksiklorokuin'],
        ['Primaquine', 'primakuin'],
        ['Artemether', 'artemeter'],
        ['Lumefantrine', 'lumefantrin'],
        ['Dihydroartemisinin', 'dihidroartemisinin'],
        ['Piperaquine', 'piperakuin'],
        ['Cefuroxime', 'sefuroksim'],
        ['Ceftriaxone', 'seftriakson'],
        ['Cefotaxime', 'sefotaksim'],
        ['Gentamicin', 'gentamisin'],
        ['Neomycin', 'neomisin'],
        ['Bacitracin', 'basitrasin'],
        ['Polymyxin B', 'polimiksin', 'polymyxin'],
        ['Mupirocin', 'mupirosin'],
        ['Fusidic acid', 'asam fusidat'],
        ['Clotrimazole', 'klotrimazol'],
        ['Terbinafine', 'terbinafin'],
        ['Griseofulvin'],
        ['Permethrin', 'permetrin'],
        ['Betahistine', 'betahistin'],
        ['Flunarizine', 'flunarizin'],
        ['Cinnarizine', 'sinarizin'],
        ['Piracetam'],
        ['Citicoline', 'sitikolin'],
        ['Mecobalamin', 'mekobalamin', 'methylcobalamin', 'metilkobalamin'],
        ['Prednisolone', 'prednisolon'],
        ['Betamethasone', 'betametason'],
        ['Triamcinolone', 'triamsinolon'],
        ['Fexofenadine', 'feksofenadin'],
        ['Desloratadine', 'desloratadin'],
        ['Levocetirizine', 'levosetirizin'],
        ['Promethazine', 'prometazin'],
        ['Ketotifen'],
        ['Terbutaline', 'terbutalin'],
        ['Budesonide', 'budesonid'],
        ['Fluticasone', 'flutikason'],
        ['Ipratropium', 'ipratropium bromide'],
        ['Acetylcysteine', 'asetilsistein'],
        ['Carbocisteine', 'karbosistein', 'carbocysteine'],
        ['Erdosteine', 'erdostein'],
        ['Noscapine', 'noskapin'],
        ['Oxymetazoline', 'oksimetazolin'],
        ['Xylometazoline', 'xilometazolin'],
        ['Sildenafil'],
        ['Tamsulosin'],
        ['Finasteride', 'finasterid'],
        ['Methyldopa', 'metildopa'],
        ['Isosorbide dinitrate', 'isosorbid dinitrat'],
        ['Digoxin', 'digoksin'],
        ['Atenolol'],
        ['Carvedilol', 'karvedilol'],
        ['Diltiazem'],
        ['Verapamil'],
        ['Telmisartan'],
        ['Olmesartan'],
        ['Enalapril'],
        ['Perindopril'],
        ['Gemfibrozil'],
        ['Fenofibrate', 'fenofibrat'],
        ['Cilostazol', 'silostazol'],
        ['Sitagliptin'],
        ['Vildagliptin'],
        ['Pioglitazone', 'pioglitazon'],
        ['Acarbose', 'akarbosa'],
        ['Gliclazide', 'gliklazid'],
        ['Sumatriptan'],
        ['Ethinylestradiol', 'etinilestradiol'],
        ['Levonorgestrel'],
        ['Medroxyprogesterone', 'medroksiprogesteron'],
        ['Norethisterone', 'noretisteron'],
        ['Potassium chloride', 'kalium klorida'],
        ['Sodium bicarbonate', 'natrium bikarbonat'],
        ['Calcium lactate', 'kalsium laktat'],
        ['Magnesium sulfate', 'magnesium sulfat'],
        ['Cholecalciferol', 'kolekalsiferol'],
        ['Tocopherol', 'tokoferol'],
        ['Retinol', 'retinil palmitat', 'retinyl palmitate'],
        ['Riboflavin'],
        ['Nicotinamide', 'nikotinamid', 'niacinamide'],
        ['Calamine', 'kalamin'],
        ['Menthol', 'mentol'],
        ['Methyl salicylate', 'metil salisilat'],
        ['Camphor', 'kamfer'],
        ['Hydrotalcite', 'hidrotalsit'],
    ];

    // Common Indonesian brands. Matched like generics, but they never "claim" a dosage
    // ahead of the active ingredient listed under them.
    const BRAND_GROUPS = [
        ['Panadol'], ['Bodrex'], ['Paramex'], ['Sanmol'], ['Mixagrip'], ['Promag'],
        ['Decolgen'], ['Neozep'], ['Oskadon'], ['Procold'], ['Ultraflu'], ['Inza'],
        ['Tempra'], ['Proris'], ['Biogesic'], ['Mylanta'], ['Polysilane'], ['Lapifed'],
        ['Actifed'], ['Komix'], ['Konidin'], ['Betadine'], ['Diapet'], ['Entrostop'],
        ['Cataflam'], ['Ponstan'], ['Amoxsan'], ['Intunal'], ['Bisolvon'], ['Hufagesic'],
        ['Sumagesic'], ['Dulcolax'], ['Imodium'], ['Antimo'], ['Sangobion'], ['Enervon'],
        ['Neurobion'], ['Redoxon'], ['Fatigon'], ['Stimuno'], ['Imboost'], ['Insto'],
        ['Rhinos'], ['Flutamol'], ['Dumin'], ['Farsifen'], ['Fasidol'], ['Pamol'],
        ['OBH Combi'], ['Vicks Formula 44'], ['Siladex'], ['Hufagrip'], ['Tremenza'], ['Rhinofed'],
        ['Alpara'], ['Grantusif'], ['Laserin'], ['Antangin'], ['Tolak Angin'], ['Kalpanax'],
        ['Daktarin'], ['Canesten'], ['Kenalog'], ['Bioplacenton'], ['Cendo'], ['Rohto'],
        ['Visine'], ['Counterpain'], ['Salonpas'], ['Microlax'], ['New Diatabs'], ['Lodia'],
        ['Ventolin'], ['Seretide'], ['Symbicort'], ['Lasix'], ['Norvask'], ['Tensivask'],
        ['Glucophage'], ['Amaryl'], ['Lipitor'], ['Zyloric'], ['Voltaren'], ['Mefinal'],
        ['Ketesse'], ['Arcoxia'], ['Celebrex'], ['Medrol'], ['Lameson'], ['Incidal'],
        ['Ryzen'], ['Zyrtec'], ['Claritin'], ['Clarinase'], ['Telfast'], ['Nexium'],
        ['Losec'], ['Inpepsa'], ['Ulsafat'], ['Vometa'], ['Motilium'], ['Primperan'],
        ['Buscopan'], ['Spasminal'], ['Feminax'], ['Cerebrovit'], ['Sakatonik'], ['Becomzet'],
        ['Xonce'], ['Vitacimin'], ['Hemaviton'], ['Caviplex'], ['Bodrexin'], ['Termorex'],
        ['Neo Rheumacyl'], ['Remasil'], ['Ambeven'], ['Ardium'],
    ];

    const DRUG_INDEX = [];
    [[DRUG_GROUPS, false], [BRAND_GROUPS, true]].forEach(([groups, brand]) => groups.forEach(group => {
        group.forEach(spelling => {
            const key = spelling.toLowerCase().replace(/[^a-z ]/g, '');
            DRUG_INDEX.push({ key, compact: key.replace(/ /g, ''), display: group[0], brand });
        });
    }));

    // "l", "i" (and "I" once lowercased) are the most common OCR swap; don't count it as a typo.
    function sameGlyph(x, y) {
        return x === y || ((x === 'i' || x === 'l') && (y === 'i' || y === 'l'));
    }

    function levenshtein(a, b, maxDist) {
        if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
        let prev = new Array(b.length + 1);
        let curr = new Array(b.length + 1);
        for (let j = 0; j <= b.length; j++) prev[j] = j;
        for (let i = 1; i <= a.length; i++) {
            curr[0] = i;
            let rowMin = curr[0];
            for (let j = 1; j <= b.length; j++) {
                const cost = sameGlyph(a[i - 1], b[j - 1]) ? 0 : 1;
                curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
                if (curr[j] < rowMin) rowMin = curr[j];
            }
            if (rowMin > maxDist) return maxDist + 1;
            [prev, curr] = [curr, prev];
        }
        return prev[b.length];
    }

    // How many typos we tolerate for a name of a given length.
    function allowedEdits(len) {
        if (len <= 4) return 0;
        if (len <= 7) return 1;
        if (len <= 11) return 2;
        return 3;
    }

    // Undo the classic OCR letter/digit swaps inside a word that is mostly letters.
    function normalizeWord(word) {
        let w = word.toLowerCase();
        const letters = (w.match(/[a-z]/g) || []).length;
        if (letters >= 3 && letters >= w.replace(/[^a-z0-9|]/g, '').length * 0.6) {
            w = w.replace(/0/g, 'o').replace(/[1|]/g, 'l').replace(/5/g, 's').replace(/8/g, 'b').replace(/6/g, 'g');
        }
        return w.replace(/[^a-z]/g, '');
    }

    // Find known drug names in OCR text, tolerating OCR typos (e.g. "Paracetarnol", "Am0xicilin").
    // Returns [{ name, matched, line, distance }] ordered by first appearance.
    function findDrugNames(text) {
        const found = new Map();
        const lines = text.split('\n');
        lines.forEach((line, lineIdx) => {
            const words = line.split(/[\s,;:()\/]+/).map(normalizeWord).filter(w => w.length > 0);
            for (let i = 0; i < words.length; i++) {
                // Try 1-3 word windows, both spaced ("asam mefenamat") and joined, since OCR
                // sometimes splits a word in two ("para cetamol").
                for (let n = 1; n <= 3 && i + n <= words.length; n++) {
                    const slice = words.slice(i, i + n);
                    const spaced = slice.join(' ');
                    const joined = slice.join('');
                    if (joined.length < 4) continue;
                    // "rn" is very often a misread "m"
                    const variants = [spaced, joined];
                    if (joined.includes('rn')) variants.push(joined.replace(/rn/g, 'm'));

                    const candidates = [];
                    for (const entry of DRUG_INDEX) {
                        // Brands are short, made-up words that collide with real words more easily: one typo stricter.
                        const maxD = Math.max(0, allowedEdits(entry.compact.length) - (entry.brand ? 1 : 0));
                        let best = maxD + 1;
                        for (const v of variants) {
                            const target = v.includes(' ') ? entry.key : entry.compact;
                            const d = levenshtein(v, target, maxD);
                            if (d < best) best = d;
                        }
                        if (best <= maxD) candidates.push({ entry, best });
                    }
                    // Many drug names are near-twins (Amoxicillin/Ampicillin, Thiamine/Calamine):
                    // a piece of text only counts as the closest one(s).
                    const minD = Math.min(...candidates.map(c => c.best));
                    for (const { entry, best } of candidates) {
                        if (best === minD) {
                            const prev = found.get(entry.display);
                            const lines = prev ? prev.lines : [];
                            if (!lines.includes(lineIdx)) lines.push(lineIdx);
                            if (!prev || best < prev.distance) {
                                found.set(entry.display, {
                                    name: entry.display,
                                    matched: slice.join(' '),
                                    line: prev ? Math.min(prev.line, lineIdx) : lineIdx,
                                    lines,
                                    distance: best,
                                    brand: entry.brand,
                                });
                            }
                        }
                    }
                }
            }
        });
        return [...found.values()].sort((a, b) => a.line - b.line || a.distance - b.distance);
    }

    // Normalise common OCR mistakes in dosage text ("5OO rng" -> "500 mg").
    function normalizeDosageText(text) {
        return text
            // letter-O / l / I inside numbers next to a unit
            .replace(/\b([0-9OoIlS]{1,5}(?:[.,][0-9OoIl]+)?)(?=\s*(?:mg|rng|m9|mq|m3|mb|ml|mI|g|mcg|iu)\b)/gi, m =>
                /\d/.test(m) ? m.replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5') : m)
            .replace(/(\d)\s*(?:rng|rn9|m9|mq|nig|rnq|m3|mb|mgr|me)\b/gi, '$1 mg')
            .replace(/(\d)\s*(?:rnl|mI|m1)\b/g, '$1 ml')
            .replace(/(\d)\s*(?:pg|µg|ug)\b/gi, '$1 mcg');
    }

    const DOSAGE_REGEX = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|ml|g|iu|%)(?:\s*\/\s*(\d*\s*(?:ml|tab(?:let)?|kaplet|kapsul|caps(?:ule)?)))?(?![a-z])/gi;

    function findDosages(text) {
        const out = [];
        normalizeDosageText(text).split('\n').forEach((line, lineIdx) => {
            let m;
            DOSAGE_REGEX.lastIndex = 0;
            while ((m = DOSAGE_REGEX.exec(line)) !== null) {
                const unit = m[2].toLowerCase();
                // A bare "g" right after a number is usually junk unless it is a plausible amount
                if (unit === 'g' && parseFloat(m[1].replace(',', '.')) > 50) continue;
                const per = m[3] ? ' / ' + m[3].trim() : '';
                out.push({ text: `${m[1]} ${unit === 'iu' ? 'IU' : unit}${per}`, line: lineIdx, index: m.index });
            }
        });
        return out;
    }

    // Pair every recognised drug with the dosage on the same line (or the next line,
    // since labels often wrap "Paracetamol" / "500 mg").
    function extractMedications(text) {
        const drugs = findDrugNames(text);
        const dosages = findDosages(text);
        const used = new Set();
        const doseFor = new Map();
        // Lines that name an active ingredient: a dosage there belongs to that ingredient.
        const generics = drugs.filter(d => !d.brand);
        const genericLines = new Set();
        generics.forEach(d => d.lines.forEach(l => genericLines.add(l)));
        // Active ingredients pick a dosage on their own line(s) first, then borrow from the
        // following line only if it doesn't name an ingredient of its own
        // ("Amoxicillin trihydrate setara" / "dengan 500 mg").
        generics.forEach(drug => {
            const dose = dosages.find(d => !used.has(d) && drug.lines.includes(d.line));
            if (dose) { used.add(dose); doseFor.set(drug, dose); }
        });
        generics.filter(drug => !doseFor.has(drug)).forEach(drug => {
            const dose = dosages.find(d => !used.has(d) && !genericLines.has(d.line) && drug.lines.includes(d.line - 1));
            if (dose) { used.add(dose); doseFor.set(drug, dose); }
        });
        drugs.filter(d => d.brand).forEach(drug => {
            const dose = dosages.find(d => !used.has(d) && d.line === drug.line);
            if (dose) { used.add(dose); doseFor.set(drug, dose); }
        });
        // Glare often wipes out just the unit ("Paracetamol 500"). A bare number ending an
        // ingredient's line is still worth showing, clearly flagged.
        const rawLines = normalizeDosageText(text).split('\n');
        const unclearDose = drug => {
            for (const l of drug.lines) {
                const m = rawLines[l].match(/[a-z]\S*\s+(\d{1,4}(?:[.,]\d+)?)\s*\S{0,2}$/i);
                if (m && !dosages.some(d => d.line === l)) return `${m[1]} (unit unclear)`;
            }
            return null;
        };
        const meds = drugs.map(drug => {
            const dosage = doseFor.has(drug) ? doseFor.get(drug).text : (drug.brand ? null : unclearDose(drug));
            return {
                name: drug.name,
                matched: drug.matched,
                dosage,
                doseUnclear: !!dosage && dosage.endsWith('(unit unclear)'),
                exact: drug.distance === 0,
                brand: drug.brand,
            };
        });

        // Fall back to the old heuristic (word right before a dosage) for drugs not in our list.
        const unknown = [];
        if (meds.length === 0) {
            const lines = normalizeDosageText(text).split('\n');
            dosages.forEach(d => {
                const before = lines[d.line].slice(0, d.index).replace(/[^a-zA-Z\s]/g, ' ').trim().split(/\s+/);
                const guess = before.slice(-2).filter(w => w.length > 2).join(' ');
                if (guess.length > 3 && !unknown.some(u => u.name === guess)) {
                    unknown.push({ name: guess, dosage: d.text });
                }
            });
        }
        return { meds, unknown, dosages: dosages.map(d => d.text) };
    }

    // Score an OCR pass so we can keep the best of several preprocessing attempts.
    function scoreResult(text, confidence) {
        const { meds, dosages } = extractMedications(text);
        const exact = meds.filter(m => m.exact).length;
        return meds.length * 100 + exact * 50 + dosages.length * 25 + (confidence || 0);
    }

    // ---------- RECOGNITION PIPELINE ----------
    // Shared by the app and the offline benchmark. `recognize(gray, width, height, psm)` must
    // run Tesseract and resolve to its `data` object (text, confidence, lines, words).

    const TARGET_LONG_SIDE = 2000;
    const IDEAL_WORD_HEIGHT = 40;   // px, word box height (incl. ascenders) Tesseract reads best
    const SMALL_WORD_HEIGHT = 28;   // below this we zoom in on the text region and read again
    const MAX_REFINE_PIXELS = 5e6;

    // Keep only lines that look like real text (drops edge noise, barcodes, logo fragments).
    function goodLines(data) {
        return (data.lines || []).filter(l => l.confidence >= 35 && /[a-z0-9]{2,}/i.test(l.text));
    }

    function cleanOcrText(data) {
        if (!data.lines || data.lines.length === 0) return (data.text || '').trim();
        return goodLines(data).map(l => l.text.replace(/\s+$/, '')).join('\n').trim();
    }

    // Median height of confidently-read words, plus the box around them.
    function textGeometry(data) {
        const words = (data.words || []).filter(w => w.confidence >= 50 && /[a-z]{2,}/i.test(w.text) && w.bbox);
        if (words.length === 0) return null;
        const heights = words.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
        const box = words.reduce((b, w) => ({
            x0: Math.min(b.x0, w.bbox.x0), y0: Math.min(b.y0, w.bbox.y0),
            x1: Math.max(b.x1, w.bbox.x1), y1: Math.max(b.y1, w.bbox.y1),
        }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
        return { wordHeight: heights[Math.floor(heights.length / 2)], box, count: words.length };
    }

    // Good enough to stop early: a real ingredient read cleanly and every mg/mcg/IU amount
    // on the label is attached to an ingredient (so no ingredient line was left unread).
    function isComplete(text, confidence) {
        const { meds, dosages } = extractMedications(text);
        const generics = meds.filter(m => !m.brand);
        if (!generics.some(m => m.exact) || confidence < 60) return false;
        const ingredientDoses = dosages.filter(d => /mg|mcg|IU/.test(d)).length;
        return generics.filter(m => m.dosage).length >= ingredientDoses;
    }

    // Combine medications seen across passes: different preprocessing often gets different lines right.
    function mergeMeds(passes) {
        const byName = new Map();
        passes.forEach(p => p.meds.forEach(m => {
            const prev = byName.get(m.name);
            if (!prev) { byName.set(m.name, { ...m, seen: 1, order: p.order * 1000 + byName.size }); return; }
            prev.seen++;
            if (!prev.dosage && m.dosage) prev.dosage = m.dosage;
            if (!prev.exact && m.exact) { prev.exact = true; prev.matched = m.matched; }
        }));
        return [...byName.values()].sort((a, b) => a.order - b.order).map(({ order, ...m }) => m);
    }

    async function runPipeline(src, recognize, opts) {
        opts = opts || {};
        const onStage = opts.onStage || (() => {});
        const shouldStop = opts.shouldStop || (() => false);
        const passes = [];
        const stages = [];

        // Straighten tilted labels first: Tesseract splits skewed lines into fragments,
        // which separates drug names from their dosages.
        const straight = deskew(src);
        if (straight.angle) stages.push(`Straightened ${straight.angle}°`);
        const base = prepare(straight, TARGET_LONG_SIDE, 3);

        async function pass(label, img, psm) {
            if (shouldStop()) throw new Error('cancelled');
            onStage(label, passes.length);
            stages.push(label);
            const data = await recognize(img.gray, img.width, img.height, psm);
            const text = cleanOcrText(data);
            const result = {
                label, data, text,
                confidence: data.confidence || 0,
                meds: extractMedications(text).meds,
                score: scoreResult(text, data.confidence),
                order: passes.length,
            };
            passes.push(result);
            return result;
        }
        const done = () => passes.some(p => isComplete(p.text, p.confidence));

        // 1. Contrast-stretched grayscale: best for normal dark-on-light print.
        const first = await pass('Reading label', base, '3');

        // 2. Small print: zoom in on where the text actually is and read it again at a size
        //    Tesseract likes. Fixes tiny ingredient lists and full-size gallery photos.
        const geo = textGeometry(first.data);
        if (!done() && geo && geo.wordHeight < SMALL_WORD_HEIGHT) {
            const s = base.scale;
            const pad = geo.wordHeight * 2;
            const x = (geo.box.x0 - pad) / s, y = (geo.box.y0 - pad) / s;
            const crop = cropGray(straight.gray, straight.width, straight.height, x, y,
                (geo.box.x1 - geo.box.x0 + 2 * pad) / s, (geo.box.y1 - geo.box.y0 + 2 * pad) / s);
            let zoom = (IDEAL_WORD_HEIGHT / geo.wordHeight) * s;
            zoom = Math.min(zoom, 5, Math.sqrt(MAX_REFINE_PIXELS / (crop.width * crop.height)));
            if (zoom > s * 1.2) {
                const zoomed = prepare(crop, Infinity, zoom);
                await pass('Zooming in on small text', zoomed, '3');
            }
        }

        // 3. Local (adaptive) threshold: survives glare, shadows, coloured boxes and
        //    light-on-dark text. Sparse-text mode suits scattered packaging text.
        if (!done()) await pass('Trying high contrast', { ...base, gray: adaptiveThreshold(base.gray, base.width, base.height) }, '11');

        // 4. Inverted grayscale for white print on dark/coloured backgrounds.
        if (!done()) await pass('Trying inverted colours', { ...base, gray: invert(base.gray) }, '11');

        // 5. Sideways text (very common on the narrow sides of medicine boxes).
        const anyGeneric = () => passes.some(p => p.meds.some(m => !m.brand));
        if (!anyGeneric()) {
            for (const dir of [1, -1]) {
                const rotated = rotateGray(base.gray, base.width, base.height, dir);
                await pass('Checking for sideways text', { ...rotated, scale: base.scale }, '3');
                if (anyGeneric()) break;
            }
        }

        const best = passes.reduce((a, b) => (b.score > a.score ? b : a));
        const merged = extractMedications(best.text);
        return {
            text: best.text,
            confidence: best.confidence,
            lines: goodLines(best.data).map(l => ({
                text: l.text,
                words: (l.words || []).map(w => ({ text: w.text, confidence: w.confidence })),
            })),
            meds: mergeMeds(passes),
            unknown: merged.unknown,
            stages,
        };
    }

    const api = {
        toGray, toBestGray, grayToRgba, sharpness, stretchContrast, sharpen, adaptiveThreshold, invert,
        resizeGray, cropGray, rotateGray, rotateArbitrary, estimateSkew, deskew, prepare, cleanOcrText, runPipeline,
        levenshtein, normalizeWord, findDrugNames, findDosages, normalizeDosageText,
        extractMedications, scoreResult, DRUG_GROUPS, BRAND_GROUPS,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else global.OcrUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
