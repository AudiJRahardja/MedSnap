// Usage: node bench2.js v1|v2 [filter]
const fs = require('fs'); const { PNG } = require('pngjs'); const Tesseract = require('tesseract.js');
const U = require(require('path').join(__dirname, '..', 'ocr-utils.js'));
const mode = process.argv[2] || 'v2'; const filter = process.argv[3] || '';
const exp = JSON.parse(fs.readFileSync(require('path').join(__dirname, process.env.DIR||'hard', 'expected.json'), 'utf8'));
function load(p) { const png = PNG.sync.read(fs.readFileSync(p)); return { data: png.data, width: png.width, height: png.height }; }
function grayPng(gray, w, h) { const png = new PNG({ width: w, height: h }); U.grayToRgba(gray, png.data); return PNG.sync.write(png); }
function resize(img, w, h) { const out = new Uint8ClampedArray(w*h*4);
  for (let y=0;y<h;y++){ const fy=(y+0.5)*img.height/h-0.5, y0=Math.max(0,Math.floor(fy)), y1=Math.min(img.height-1,y0+1), dy=Math.max(0,fy-y0);
    for (let x=0;x<w;x++){ const fx=(x+0.5)*img.width/w-0.5, x0=Math.max(0,Math.floor(fx)), x1=Math.min(img.width-1,x0+1), dx=Math.max(0,fx-x0);
      for (let c=0;c<4;c++){ const a=img.data[(y0*img.width+x0)*4+c], b=img.data[(y0*img.width+x1)*4+c], cc=img.data[(y1*img.width+x0)*4+c], d=img.data[(y1*img.width+x1)*4+c];
        out[(y*w+x)*4+c]=(a*(1-dx)+b*dx)*(1-dy)+(cc*(1-dx)+d*dx)*dy; } } } return { data: out, width: w, height: h }; }

// v1 = the pipeline currently in app.js (copied)
function cleanText(data) { if (!data.lines || !data.lines.length) return (data.text||'').trim();
  return data.lines.filter(l => l.confidence >= 35 && /[a-z0-9]{2,}/i.test(l.text)).map(l => l.text.replace(/\s+$/,'')).join('\n').trim(); }
async function v1(worker, img) {
  const scale = Math.min(3, 2000 / Math.max(img.width, img.height));
  const r = resize(img, Math.round(img.width*scale), Math.round(img.height*scale)); const { width, height } = r;
  const st = U.stretchContrast(U.toGray(r.data, width, height)); const enhanced = scale > 1.5 ? U.sharpen(st, width, height, 0.6) : st;
  const variants = [['3', () => enhanced], ['11', () => U.adaptiveThreshold(enhanced, width, height)], ['11', () => U.invert(enhanced)]];
  let best = null, passes = 0;
  for (const [psm, fn] of variants) { passes++;
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(grayPng(fn(), width, height));
    const text = cleanText(data); const score = U.scoreResult(text, data.confidence);
    if (!best || score > best.score) best = { text, score };
    if (U.extractMedications(text).meds.some(m => m.exact && !m.brand) && data.confidence >= 60) break; }
  return { meds: U.extractMedications(best.text).meds, passes, text: best.text };
}
let TIMEOUTS = 0; const W = {};
async function newWorker() { const w = await Tesseract.createWorker(['eng', 'ind'], 1); await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' }); return w; }
async function v2(worker, img) {
  const src = { gray: (process.env.PLAIN ? U.toGray : U.toBestGray)(img.data, img.width, img.height), width: img.width, height: img.height };
  let passes = 0;
  const recognize = async (g, w, h, psm) => { passes++;
    const job = (async () => { await W.w.setParameters({ tessedit_pageseg_mode: psm }); return (await W.w.recognize(grayPng(g, w, h))).data; })();
    let t; const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), 60000); });
    try { return await Promise.race([job, guard]); }
    catch (e) { console.log('   !! pass timed out, restarting worker'); TIMEOUTS++; W.w.terminate().catch(()=>{}); W.w = await newWorker(); return { text: '', confidence: 0, lines: [], words: [] }; }
    finally { clearTimeout(t); } };
  const r = await U.runPipeline(src, recognize, {});
  return { meds: r.meds, passes, text: r.text, stages: r.stages };
}
(async () => {
  const worker = await newWorker(); W.w = worker;
  const files = Object.keys(exp).filter(f => f.includes(filter)).sort();
  let tot = 0, nameOk = 0, doseOk = 0, labelsFull = 0, passesSum = 0; const byStyle = {};
  const t0 = Date.now();
  for (const f of files) {
    const img = load(require('path').join(__dirname, process.env.DIR||'hard', f));
    const r = await (mode === 'v1' ? v1 : v2)(worker, img);
    passesSum += r.passes;
    let fullOk = true; const miss = [];
    for (const e of exp[f]) { const m = e.match(/^(.*?) (\d+ mg)$/); const name = m[1], dose = m[2];
      const found = r.meds.find(x => x.name === name); tot++;
      if (found) nameOk++; else { fullOk = false; miss.push(name); }
      if (found && found.dosage === dose) doseOk++;
      else if (found && process.env.DOSE) console.log(`   dose ${f} ${name}: want ${dose} got ${found.dosage} | ${JSON.stringify(r.text).slice(0, 220)}`); }
    if (fullOk) labelsFull++;
    const st = f.split('_')[1].replace('.png',''); byStyle[st] = byStyle[st] || [0,0]; byStyle[st][1]++; if (fullOk) byStyle[st][0]++;
    console.log(`${f.padEnd(18)} ${fullOk ? 'OK  ' : 'MISS'} passes:${r.passes} ${miss.length ? 'missing: ' + miss.join(', ') : ''} ${r.stages ? '[' + r.stages.join(' > ') + ']' : ''}`);
  }
  console.log(`\n${mode}: labels fully read ${labelsFull}/${files.length} | ingredients ${nameOk}/${tot} | with correct dose ${doseOk}/${tot} | avg passes ${(passesSum/files.length).toFixed(2)} | timeouts ${TIMEOUTS} | ${((Date.now()-t0)/1000).toFixed(0)}s`);
  console.log(Object.entries(byStyle).map(([k,[a,b]]) => `${k}:${a}/${b}`).join('  '));
  await W.w.terminate();
})();
