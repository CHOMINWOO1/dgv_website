// Fully isolated browser test. All remote requests are intercepted; no hosted
// room, real YouTube playback, Google search quota, or business data is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = 'https://fbbecxtxsaplrmanjunw.supabase.co/functions/v1/hana-karaoke';
const calls = [], errors = [], contexts = [], states = new Map(), requests = new Map();
const hostToken = 'a'.repeat(64), joinToken = 'b'.repeat(64);
let checks = 0, browser, server, failAuto = false;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('PASS', label); };
async function waitFor(fn, label, timeout = 13000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) { check(true, label); return; } await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out: ' + label);
}
function mockAction(payload) {
  if (payload.action === 'create') {
    const room = String(654321 + states.size);
    const state = { room, queue: [], current: null, playing: false, revision: 0, topic: 'mock-topic-' + room, expiresAt: '2030-01-01T00:00:00Z', closed: false };
    states.set(room, state);
    return { room, hostToken, joinToken, state };
  }
  const state = states.get(payload.room);
  if (!state || ![hostToken, joinToken].includes(payload.token)) throw new Error('Invalid test capability');
  if (payload.action === 'state') return { state };
  if (payload.action === 'search') return { source: 'youtube', nextPageToken: null, items: [
    { videoId: 'M7lc1UVf-VE', title: '검색 예약 곡', channelTitle: 'Sample', thumbnail: '' },
    { videoId: 'jNQXAC9IVRw', title: '검색 우선예약 곡', channelTitle: 'Sample', thumbnail: '' }
  ] };
  if (requests.has(payload.requestId)) return { state };
  requests.set(payload.requestId, payload.action);
  if (payload.action === 'add') {
    const item = { id: payload.requestId, videoId: payload.videoId, title: payload.title };
    payload.priority ? state.queue.unshift(item) : state.queue.push(item);
  } else if (['next', 'ended'].includes(payload.action)) {
    if (payload.expectedCurrentId === (state.current?.id || null)) { state.current = state.queue.shift() || null; state.playing = Boolean(state.current); }
  } else if (payload.action === 'play') {
    if (!state.current) state.current = state.queue.shift() || null;
    state.playing = Boolean(state.current);
  } else if (payload.action === 'pause') state.playing = false;
  else if (payload.action === 'prioritize') {
    const index = state.queue.findIndex(item => item.id === payload.itemId);
    if (index >= 0) state.queue.unshift(...state.queue.splice(index, 1));
  } else if (payload.action === 'remove') state.queue = state.queue.filter(item => item.id !== payload.itemId);
  else if (payload.action === 'close') { state.closed = true; state.playing = false; }
  state.revision++;
  return { state };
}
async function invalidate() {
  await Promise.all(contexts.flatMap(context => context.pages()).map(page => page.evaluate(() => window.__invalidate?.()).catch(() => {})));
}
async function setup(context) {
  contexts.push(context); context.setDefaultTimeout(12000);
  await context.addInitScript(() => {
    window.__loads = []; window.__pauses = 0; window.__plays = 0; window.__blockAutoplay = false;
    window.supabase = { createClient: () => ({
      channel: () => ({ on(_type, _event, callback) { window.__invalidate = callback; return this; }, subscribe(callback) { queueMicrotask(() => callback('SUBSCRIBED')); return this; } }),
      removeChannel: async () => 'ok'
    }) };
    window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 }, Player: class {
      constructor(id, options) {
        this.options = options; this.video = ''; this.frame = document.createElement('iframe');
        document.getElementById(id).replaceWith(this.frame); window.__player = this;
        queueMicrotask(() => options.events.onReady({ target: this }));
      }
      getIframe() { return this.frame; } getVideoData() { return { video_id: this.video }; }
      emit(data) { this.options.events.onStateChange({ target: this, data }); }
      loadVideoById(video) { this.video = video.videoId; window.__loads.push(video.videoId); setTimeout(() => window.__blockAutoplay ? this.options.events.onAutoplayBlocked() : this.emit(1), 10); }
      cueVideoById(video) { this.video = video.videoId; }
      playVideo() { window.__plays++; setTimeout(() => this.emit(1), 10); }
      pauseVideo() { window.__pauses++; setTimeout(() => this.emit(2), 10); }
      stopVideo() {} destroy() { this.frame.remove(); }
    } };
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (/^http:\/\/127\.0\.0\.1:/.test(url)) return route.continue();
    if (url !== endpoint) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    const payload = request.postDataJSON(); calls.push(payload);
    if (failAuto && payload.action === 'next' && payload.expectedCurrentId === null) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ code: 'RATE_LIMITED' }) });
    const result = structuredClone(mockAction(payload));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    if (!['state', 'search'].includes(payload.action)) await invalidate();
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
}
async function add(phone, title, priority = false) {
  await phone.locator('#manualEntry').evaluate(element => { element.open = true; });
  await phone.locator('#songTitle').fill(title); await phone.locator('#songUrl').fill('https://youtu.be/dQw4w9WgXcQ');
  await phone.locator('#manualPriority').setChecked(priority); await phone.locator('#add').click();
  await waitFor(async () => await phone.locator('#songUrl').inputValue() === '', 'phone reservation acknowledged: ' + title);
}
try {
  server = createServer(async (request, response) => {
    let name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
    if (name === 'hana_karaoke' || name === 'hana_karaoke_tv') name += '.html';
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) || !/^(hana_karaoke(?:_tv)?\.html|assets\/)/.test(name)) return response.writeHead(404).end();
    try { response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/hana_karaoke_tv`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const tvContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await setup(tvContext); await setup(phoneContext);
  const tv = await tvContext.newPage(); await tv.goto(base);
  check(calls.length === 0, 'no API traffic before consent');
  await tv.locator('#launchTVFullscreen').focus(); await tv.keyboard.press('Enter');
  await waitFor(() => tv.evaluate(() => document.fullscreenElement === document.documentElement), 'remote OK can enter fullscreen before room creation');
  check(calls.length === 0, 'fullscreen itself never touches the DB or YouTube');
  await tv.locator('#searchConsent').focus(); await tv.keyboard.press('Enter');
  check(await tv.locator('#searchConsent').isChecked(), 'remote OK can explicitly agree to the consent checkbox');
  await tv.keyboard.press('ArrowDown');
  check(await tv.evaluate(() => document.activeElement.id !== 'searchConsent' && document.activeElement.classList.contains('tv-focus')), 'remote Down moves focus and highlights the selected control');
  await tv.locator('#create').focus(); await tv.keyboard.press('Enter');
  await tv.locator('body.tv-display.tv-idle').waitFor();
  check(await tv.evaluate(() => document.fullscreenElement === document.documentElement), 'creating a room preserves fullscreen selected on the welcome screen');
  check(await tv.locator('#displayQR canvas').count() === 1, 'idle TV shows local high-resolution invitation QR');
  check(await tv.locator('.session-grid').isHidden() && await tv.locator('.site-header').isHidden(), 'TV display hides search, queue and management panels');
  check(await tv.locator('#playerFrame').isHidden(), 'idle TV does not show an empty video');
  const invite = await tv.locator('#share').inputValue();
  check(!invite.includes(hostToken) && invite.includes('#join='), 'QR shares only the guest capability');
  await tv.locator('#screenStart').focus(); await tv.keyboard.press('ArrowRight');
  check(await tv.evaluate(() => document.activeElement.id === 'screenSettings'), 'remote Right moves to the TV settings button');
  await tv.keyboard.press('ArrowLeft');
  check(await tv.evaluate(() => document.activeElement.id === 'screenStart'), 'remote Left returns to the fullscreen button');
  await tv.keyboard.press('Enter');
  await waitFor(() => tv.evaluate(() => document.fullscreenElement === document.documentElement), 'local TV gesture enters document fullscreen');
  const phone = await phoneContext.newPage(); await phone.goto(invite);
  await phone.locator('#searchConsent').check(); await phone.locator('#phoneControls').waitFor();
  check(await phone.evaluate(() => !window.__player && !document.body.classList.contains('tv-display')), 'phone is a remote, never a playback receiver');
  await add(phone, '첫 곡');
  const state = states.get('654321');
  await waitFor(() => tv.evaluate(() => window.__loads.length === 1), 'first phone reservation automatically starts on TV');
  check(state.current?.title === '첫 곡' && state.playing, 'first song becomes current without phone Play');
  check(calls.some(call => call.action === 'next' && call.token === hostToken && call.expectedCurrentId === null), 'automatic start uses the atomic idle-only server guard');
  check(await tv.locator('#displayIdle').isHidden() && await tv.locator('#playerFrame').isVisible(), 'QR is replaced by the video');
  await waitFor(() => tv.evaluate(() => !document.body.classList.contains('tv-controls-visible')), 'TV controls disappear after inactivity');
  await add(phone, '일반 다음 곡'); await add(phone, '우선 곡', true);
  check(state.current.title === '첫 곡' && state.queue[0].title === '우선 곡', 'priority queues after current without interruption');
  await phone.locator('#pause').click();
  await waitFor(() => tv.evaluate(() => window.__pauses > 0), 'phone Pause reaches the TV player');
  await add(phone, '일시정지 중 추가 곡');
  check(state.playing === false && state.current.title === '첫 곡', 'a new reservation never resumes or replaces a paused song');
  check(state.playing === false, 'legacy phone can pause the TV-only receiver');
  await phone.locator('#play').click();
  await waitFor(() => tv.evaluate(() => window.__plays > 0), 'phone Play resumes TV playback');
  await phone.locator('#next').click();
  await waitFor(() => state.current?.title === '우선 곡' && tv.evaluate(() => window.__loads.length === 2), 'phone Next starts the priority song');
  await tv.evaluate(() => window.__player.emit(0));
  await waitFor(() => state.current?.title === '일반 다음 곡', 'song ending automatically starts the next reservation');
  check(await tv.evaluate(() => window.__loads.length) === 3, 'repeated video IDs reload once per reservation');
  await tv.evaluate(() => window.__player.emit(0));
  await waitFor(() => state.current?.title === '일시정지 중 추가 곡', 'remaining queue advances in order');
  await tv.evaluate(() => window.__player.emit(0));
  await tv.locator('body.tv-display.tv-idle').waitFor();
  check(state.current === null && state.queue.length === 0, 'last song empties the queue');
  check(await tv.evaluate(() => document.fullscreenElement === document.documentElement), 'fullscreen persists when the QR waiting screen returns');
  check(await tv.locator('#displayQR').isVisible(), 'QR waiting screen returns after the last song');
  check(calls.filter(call => call.action === 'create').length === 1, 'remote OK creates exactly one room');
  if (process.env.KARAOKE_TV_SCREENSHOT) await tv.screenshot({ path: process.env.KARAOKE_TV_SCREENSHOT });
  await tv.evaluate(() => { window.__blockAutoplay = true; });
  await add(phone, '차단된 자동 재생');
  await waitFor(async () => (await tv.locator('#displayMessage').innerText()).includes('자동 재생이 차단'), 'autoplay blocking shows a local TV recovery message');
  check(await tv.locator('#screenStart').isVisible() && await tv.locator('#playerFrame').isVisible(), 'blocked playback keeps the native player and recovery button accessible');
  await tv.locator('#screenStart').click();
  await waitFor(async () => !(await tv.locator('#displayMessage').innerText()).includes('자동 재생'), 'one local TV click recovers blocked playback');
  await tv.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
  await tv.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'BrowserBack', keyCode: 461, bubbles: true, cancelable: true })));
  check(await tv.locator('#showTVScreen').isVisible() && await tv.locator('.session-grid').isVisible(), 'LG remote Back opens settings without closing the active room');
  await tv.locator('#showTVScreen').click();
  await tv.reload(); await tv.locator('body.tv-display').waitFor();
  check(await tv.locator('#displayIdle').isHidden(), 'receiver reload restores the current song, not a blank QR screen');
  await tv.evaluate(() => { Object.defineProperty(document.documentElement, 'requestFullscreen', { value: undefined }); Object.defineProperty(document.documentElement, 'webkitRequestFullscreen', { value: undefined }); });
  await tv.locator('#screenStart').click();
  check((await tv.locator('#displayMessage').innerText()).includes('전체화면을 허용하지'), 'unsupported fullscreen gives a visible fallback instead of throwing');
  await phone.locator('#next').click(); await tv.locator('body.tv-idle').waitFor();
  failAuto = true;
  await add(phone, '오류 재시도 확인');
  await waitFor(async () => (await tv.locator('#displayMessage').innerText()).includes('요청이 너무 많'), 'auto-start API failure is shown on TV');
  const failuresBefore = calls.filter(call => call.action === 'next' && call.expectedCurrentId === null).length;
  await tv.evaluate(() => { window.__invalidate(); window.__invalidate(); });
  await new Promise(resolve => setTimeout(resolve, 5500));
  check(calls.filter(call => call.action === 'next' && call.expectedCurrentId === null).length === failuresBefore, 'failed automatic start does not loop or hammer the API');
  failAuto = false;
  await phone.locator('#play').click(); await waitFor(() => Boolean(state.current), 'phone Play can recover after an automatic-start API failure');
  await phone.locator('#lang').selectOption('vi');
  check(await phone.locator('#pause').innerText() === 'Tạm dừng', 'legacy remote controls remain localized in Vietnamese');
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile remote has no horizontal overflow');
  await tv.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
  await tv.locator('#screenSettings').click();
  await tv.locator('#searchConsent').uncheck();
  check(await tv.locator('#session').isHidden() && !await tv.evaluate(() => document.body.classList.contains('tv-display')), 'consent withdrawal exits the TV display and stops the receiver');
  check(errors.length === 0, 'no browser exceptions: ' + errors.join('; '));
  console.log(`Karaoke TV browser: ${checks} checks passed (all external services mocked).`);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}

