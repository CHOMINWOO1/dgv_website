// Opt-in live integration: creates only a temporary karaoke room, then closes it.
// LIVE_KARAOKE_TEST=1; PLAYWRIGHT_MODULE points at playwright's index.mjs if not installed.
// Optional KARAOKE_BASE_URL tests deployed Pages instead of a loopback preview.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (process.env.LIVE_KARAOKE_TEST !== '1') throw new Error('Explicit LIVE_KARAOKE_TEST=1 required: creates a temporary karaoke room.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = 'https://fbbecxtxsaplrmanjunw.supabase.co/functions/v1/hana-karaoke';
const key = 'sb_publishable_kvhurEnExMnJxTiaqBLnOA_p2bcCuxx';
const failures = [], requests = [];
let checks = 0, created, browser, server;
const check = (value, label) => { assert.ok(value, label); checks++; console.log('PASS', label); };
async function waitFor(fn, label, timeout = 22000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) { checks++; console.log('PASS', label); return; } await new Promise(r => setTimeout(r, 200)); }
  throw new Error('Timed out: ' + label);
}
async function api(action, token, extra = {}) {
  const response = await fetch(endpoint, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, room: created?.room, token, requestId: crypto.randomUUID(), ...extra }) });
  return { status: response.status, data: await response.json() };
}
async function setup(context) {
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    window.__loads = []; window.__stops = 0;
    window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 }, Player: class {
      constructor(id, options) {
        this.options = options; this.video = ''; this.iframe = document.createElement('iframe');
        document.getElementById(id).replaceWith(this.iframe); window.__player = this;
        setTimeout(() => options.events.onReady({ target: this }), 10);
      }
      getIframe() { return this.iframe; } getVideoData() { return { video_id: this.video }; }
      emit(data) { this.options.events.onStateChange({ target: this, data }); }
      loadVideoById(v) { this.video = v.videoId; window.__loads.push(v.videoId); setTimeout(() => this.emit(1), 10); }
      cueVideoById(v) { this.video = v.videoId; window.__loads.push(v.videoId); }
      playVideo() { setTimeout(() => this.emit(1), 10); } pauseVideo() { setTimeout(() => this.emit(2), 10); }
      stopVideo() { window.__stops++; } destroy() { this.iframe.remove(); }
    }};
  });
  context.on('page', page => {
    page.on('pageerror', error => failures.push(error.message));
    page.on('request', request => requests.push(request.url()));
    page.on('response', async response => {
      if (response.url() === endpoint && response.request().postDataJSON()?.action === 'create' && response.ok()) created = await response.json();
      if (response.url() === endpoint && !response.ok()) {
        const body = await response.json().catch(() => ({}));
        console.log('API diagnostic', response.request().postDataJSON()?.action, response.status(), body.code || 'UNKNOWN');
      }
    });
  });
}
try {
  let base = process.env.KARAOKE_BASE_URL;
  if (!base) {
    server = createServer(async (req, res) => {
      let name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
      if (name === 'hana_karaoke') name += '.html';
      const file = path.resolve(root, name);
      if (!file.startsWith(root + path.sep) || !/^(hana_karaoke\.html|assets\/)/.test(name)) { res.writeHead(404).end(); return; }
      try { res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); }
      catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/hana_karaoke`;
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const tvContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await setup(tvContext); await setup(mobileContext);
  const tv = await tvContext.newPage();
  await tv.goto(base);
  if (await tv.locator('#searchConsent').count()) {
    check(await tv.locator('#create').isDisabled(), 'create waits for terms/privacy agreement');
    check(!requests.some(u => u === endpoint), 'no karaoke API calls before agreement');
    await tv.locator('#searchConsent').check();
  }
  await tv.locator('#create').click();
  await tv.locator('#session').waitFor({ state: 'visible', timeout: 30000 });
  check(Boolean(created?.hostToken), 'public create returns owner capability');
  check(await tv.locator('#qr canvas').count() > 0, 'local QR generated');
  const invite = await tv.locator('#share').inputValue();
  check(!invite.includes(created.hostToken), 'owner secret never shared in invite');
  await waitFor(() => tv.locator('#connection').evaluate(el => el.classList.contains('connected')), 'TV real Realtime subscription');
  const phone = await mobileContext.newPage();
  await phone.goto(invite);
  if (await phone.locator('#searchConsent').count()) await phone.locator('#searchConsent').check();
  await phone.locator('#session').waitFor({ state: 'visible' });
  check(await phone.locator('#tvPanel').isHidden(), 'phone is remote only');
  check(!phone.url().includes(created.joinToken), 'join capability removed from URL');
  await waitFor(() => phone.locator('#connection').evaluate(el => el.classList.contains('connected')), 'phone real Realtime subscription');
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px phone has no horizontal overflow');
  await phone.locator('#lang').selectOption('vi');
  check(await phone.locator('#add').innerText() !== '예약 추가', 'Vietnamese labels');
  await phone.locator('#lang').selectOption('ko');
  if (await phone.locator('#manualEntry').count()) await phone.locator('#manualEntry').evaluate(el => { el.open = true; });
  const add = async title => {
    await phone.locator('#songTitle').fill(title); await phone.locator('#songUrl').fill('https://youtu.be/dQw4w9WgXcQ');
    await phone.locator('#add').click(); await waitFor(async () => await phone.locator('#songUrl').inputValue() === '', 'add acknowledged');
  };
  await add('QA 첫 번째 곡'); await add('QA 같은 영상 두 번째 곡'); await add('QA 삭제용 곡');
  await waitFor(async () => await tv.locator('#queue .song').count() === 3, 'phone additions reach TV via Realtime');
  await phone.locator('#queue .song').last().getByRole('button', { name: /^예약 삭제/ }).click();
  await waitFor(async () => await tv.locator('#queue .song').count() === 2, 'queue removal reaches TV');
  await phone.locator('#play').click();
  await waitFor(async () => (await tv.locator('#currentTV').innerText()).includes('첫 번째'), 'phone starts first queue item');
  await waitFor(() => tv.evaluate(() => window.__loads.length === 1), 'player loads first item once');
  await tv.evaluate(() => window.__player.emit(2));
  await waitFor(async () => (await api('state', created.joinToken)).data.state.playing === false, 'native player pause persists to server');
  await phone.locator('#refresh').click();
  await phone.locator('#play').click();
  await waitFor(async () => (await api('state', created.joinToken)).data.state.playing === true, 'phone resumes paused native playback');
  await tv.evaluate(() => window.__player.emit(1));
  await tv.evaluate(() => window.__player.emit(0));
  await waitFor(async () => (await tv.locator('#currentTV').innerText()).includes('두 번째'), 'ended advances next queue entry');
  check(await tv.evaluate(() => window.__loads.length) === 2, 'same video queued twice reloads by queue ID');
  await tv.reload(); await tv.locator('#tvPanel').waitFor({ state: 'visible' });
  await waitFor(async () => (await tv.locator('#currentTV').innerText()).includes('두 번째'), 'TV refresh restores room and current song');
  await phone.reload(); await phone.locator('#session').waitFor({ state: 'visible' });
  check(await phone.locator('#tvPanel').isHidden(), 'phone refresh remains remote');
  if (await phone.locator('#manualPriority').count()) {
    await phone.locator('#manualEntry').evaluate(el => { el.open = true; });
    const beforePriority = (await api('state', created.joinToken)).data.state;
    await add('QA 일반 대기 곡');
    await phone.locator('#manualPriority').check();
    await add('QA 우선 대기 곡');
    await waitFor(async () => (await tv.locator('#queue .song').first().innerText()).includes('우선 대기'), 'priority add becomes next song via Realtime');
    let afterPriority = (await api('state', created.joinToken)).data.state;
    check(afterPriority.current.id === beforePriority.current.id && afterPriority.playing === beforePriority.playing, 'priority add never interrupts current playback');
    await phone.locator('#queue .song').last().locator('.priority-queue').click();
    await waitFor(async () => (await tv.locator('#queue .song').first().innerText()).includes('일반 대기'), 'existing queued song can be prioritized from phone');
    afterPriority = (await api('state', created.joinToken)).data.state;
    check(afterPriority.current.id === beforePriority.current.id && afterPriority.queue.length === 2, 'prioritize keeps current song and queue membership intact');
    const search = await api('search', created.joinToken, { query: process.env.KARAOKE_SEARCH_QUERY || 'karaoke', language: 'ko' });
    if (search.status === 200) {
      check(search.data.source === 'youtube' && Array.isArray(search.data.items), 'official search returns sanitized results');
    } else {
      check(search.data.code === 'SEARCH_NOT_CONFIGURED' && !process.env.KARAOKE_SEARCH_QUERY, 'missing search key gives explicit safe configuration error');
    }
    const afterSearch = (await api('state', created.joinToken)).data.state;
    check(afterSearch.revision === afterPriority.revision, 'search does not change queue or playback revision');
    await phone.locator('#searchConsent').uncheck();
    check(await phone.locator('#session').isHidden(), 'withdrawal leaves remote session');
    await phone.locator('#searchConsent').check();
    await phone.locator('#session').waitFor({ state: 'visible' });
    check(await phone.locator('#queue .song').count() === 2, 'renewed consent restores same queue without duplication');
  }
  const wrong = await api('state', 'a'.repeat(64));
  check(wrong.status === 404 && wrong.data.code === 'ROOM_NOT_FOUND', 'invalid capability rejected without revealing room existence');
  const guestClose = await api('close', created.joinToken);
  check(guestClose.status === 403, 'guest cannot close room');
  for (const table of ['hana_karaoke_rooms', 'hana_karaoke_settings', 'hana_karaoke_search_quota', 'hana_karaoke_search_cache']) {
    const r = await fetch(`https://fbbecxtxsaplrmanjunw.supabase.co/rest/v1/${table}?select=*`, { headers: { apikey: key } });
    check(r.status === 401 || r.status === 403, 'anonymous direct table access denied: ' + table);
  }
  if (process.env.KARAOKE_SCREENSHOT) await phone.screenshot({ path: process.env.KARAOKE_SCREENSHOT, fullPage: true });
  const closed = await api('close', created.hostToken);
  check(closed.status === 200 && closed.data.state.closed, 'host closes test room');
  await phone.locator('#refresh').click();
  await waitFor(() => phone.locator('#add').isDisabled(), 'closed room disables guest mutation controls');
  check(failures.length === 0, 'no browser runtime exceptions: ' + failures.join('; '));
  check(!requests.some(u => /api\.qrserver|quickchart|chart\.googleapis/.test(u)), 'QR capabilities not sent to third-party QR service');
  console.log(`Karaoke browser integration: ${checks} checks passed (YouTube playback mocked, live API + Realtime).`);
} finally {
  if (created) await api('close', created.hostToken).catch(() => {});
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
