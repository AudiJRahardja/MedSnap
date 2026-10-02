// End-to-end browser test of MedSnap: desktop upload flow + mobile camera flow (fake webcam).
const puppeteer = require('puppeteer-core');
const path = require('path');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.APP_URL || 'http://localhost:8765/index.html';
const OUT = __dirname;

async function waitForResults(page, label) {
    const t0 = Date.now();
    await page.waitForFunction(() => {
        const s = document.getElementById('results-sheet');
        return s && !s.classList.contains('hidden') && document.querySelector('#results-body .capture-preview');
    }, { timeout: 180000 });
    const meds = await page.$$eval('.med-card', cards => cards.map(c =>
        c.querySelector('.med-name').textContent + ' [' + [...c.querySelectorAll('.tag')].map(t => t.textContent).join(', ') + ']'));
    console.log(`${label}: results in ${((Date.now() - t0) / 1000).toFixed(1)}s ->`, meds);
    return meds;
}

(async () => {
    const mode = process.argv[2] || 'all';
    const errors = [];

    if (mode === 'all' || mode === 'desktop') {
        const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push('desktop pageerror: ' + e.message));
        page.on('console', m => { if (m.type() === 'error') errors.push('desktop console: ' + m.text()); });
        await page.setViewport({ width: 1280, height: 860 });
        await page.goto(URL, { waitUntil: 'networkidle0' });
        await page.screenshot({ path: path.join(OUT, 'shot-desktop.png') });
        const input = await page.$('#file-input-desktop');
        await input.uploadFile(path.join(OUT, 'hard', '1_clutter.png'));
        await waitForResults(page, 'desktop upload (4-ingredient label)');
        await page.screenshot({ path: path.join(OUT, 'shot-desktop-results.png') });
        // Wikipedia lookup
        await page.click('.med-info-btn');
        await page.waitForFunction(() => { const b = document.querySelector('.med-info'); return b && !/Looking up/.test(b.textContent); }, { timeout: 30000 }).catch(() => {});
        console.log('wiki box:', (await page.$eval('.med-info', e => e.textContent.trim().slice(0, 120))));
        // dark mode render
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
        await page.screenshot({ path: path.join(OUT, 'shot-desktop-results-dark.png') });
        await browser.close();
    }

    if (mode === 'all' || mode === 'mobile') {
        const browser = await puppeteer.launch({
            executablePath: CHROME, headless: 'new',
            args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                `--use-file-for-fake-video-capture=${path.join(OUT, 'label.y4m')}`],
        });
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push('mobile pageerror: ' + e.message));
        page.on('console', m => { if (m.type() === 'error') errors.push('mobile console: ' + m.text()); else if (/stages|Sharpest/.test(m.text())) console.log('  [page]', m.text().slice(0, 200)); });
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36');
        await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await page.goto(URL, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => document.querySelector('#status-chip.ready'), { timeout: 120000 });
        await page.screenshot({ path: path.join(OUT, 'shot-mobile.png') });
        await page.click('#capture-btn');
        await new Promise(r => setTimeout(r, 1500));
        await page.screenshot({ path: path.join(OUT, 'shot-mobile-scanning.png') });
        await waitForResults(page, 'mobile camera (fake webcam)');
        await page.screenshot({ path: path.join(OUT, 'shot-mobile-results.png') });
        // history
        await page.click('[data-close-sheet]');
        await page.click('#history-btn');
        await page.waitForSelector('#history-sheet:not(.hidden)');
        console.log('history items:', await page.$$eval('.history-item strong', els => els.map(e => e.textContent)));
        await page.screenshot({ path: path.join(OUT, 'shot-mobile-history.png') });
        await browser.close();
    }

    if (mode === 'cancel') {
        const browser = await puppeteer.launch({
            executablePath: CHROME, headless: 'new',
            args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                `--use-file-for-fake-video-capture=${path.join(OUT, 'label.y4m')}`],
        });
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push('cancel pageerror: ' + e.stack));
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36');
        await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await page.goto(URL, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => document.querySelector('#status-chip.ready'), { timeout: 120000 });
        await page.click('#capture-btn');
        await page.waitForFunction(() => /Reading label/.test(document.getElementById('status-chip').textContent), { timeout: 30000 });
        const t0 = Date.now();
        await page.click('#capture-btn'); // cancel
        await page.waitForFunction(() => !document.getElementById('capture-btn').classList.contains('busy'), { timeout: 30000 });
        console.log(`cancel took ${Date.now() - t0}ms; toast: "${await page.$eval('#toast', e => e.textContent)}"`);
        await page.waitForFunction(() => document.querySelector('#status-chip.ready'), { timeout: 120000 });
        await page.click('#capture-btn');
        await waitForResults(page, 'scan after cancel');
        await browser.close();
    }

    console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
})().catch(e => { console.error('E2E FAILED', e); process.exit(1); });
