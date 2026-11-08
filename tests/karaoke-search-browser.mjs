// Offline browser contract test: all karaoke API, Realtime and YouTube traffic is mocked.
// PLAYWRIGHT_MODULE and CHROME_PATH may point to an existing browser installation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const calls = [], browserErrors = [], rooms = new Map();
let checks = 0, browser, server, searchFailure = '', releaseSearch, searchArrived;
const check = (value, label) => { assert.ok(value, label); checks += 1; console.log('PASS', label); };
const sample = [
  { videoId: 'M7lc1UVf-VE', title: 'A & B <img src=x onerror=alert(1)>', channelTitle: '<script>not executable</script>', thumbnail: 'https://i.ytimg.com/vi/M7lc1UVf-VE/mqdefault.jpg' },
  { videoId: 'dQw4w9WgXcQ', title: 'Learn &amp; HTML', channelTitle: 'Sample channel', thumbnail: 'https://evil.invalid/tracker.jpg' },
  { videoId: 'jNQXAC9IVRw', title: 'Third song', channelTitle: 'Another channel', thumbnail: 'https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg' }
];
const createState = (room) => ({ room, queue: [], current: null, playing: false, revision: 0, topic: 'mock-topic-' + room, expiresAt: '2030-01-01T00:00:00Z', closed: false });

async function setup(context) {
  context.setDefaultTimeout(10000);
  await context.addInitScript(() => {
    window.__playerCreates = 0; window.__playerDestroys = 0;
    window.supabase = { createClient: () => ({
      channel: () => ({ on() { return this; }, subscribe(callback) { queueMicrotask(() => callback('SUBSCRIBED')); return this; } }), removeChannel: async () => 'ok'
    }) };
    window.YT = { PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 }, Player: class {
      constructor(id, options) { window.__playerCreates++; this.options = options; this.video = ''; this.frame = document.createElement('iframe'); document.getElementById(id).replaceWith(this.frame); queueMicrotask(() => options.events.onReady({ target: this })); }
      getIframe() { return this.frame; } getVideoData() { return { video_id: this.video }; }
      loadVideoById(video) { this.video = video.videoId; } cueVideoById(video) { this.video = video.videoId; }
      playVideo() {} pauseVideo() {} stopVideo() {} destroy() { window.__playerDestroys++; this.frame.remove(); }
    } };
  });
  await context.route('https://cdn.jsdelivr.net/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await context.route(/https:\/\/(?:[^/]*ytimg\.com|[^/]*youtube\.com)\//, (route) => route.fulfill({ status: 204, body: '' }));
  await context.route('https://fbbecxtxsaplrmanjunw.supabase.co/functions/v1/hana-karaoke', async (route) => {
    const payload = route.request().postDataJSON(); calls.push(payload);
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (payload.action === 'create') {
      const room = String(123456 + rooms.size); const state = createState(room); rooms.set(room, state);
      return reply({ room, hostToken: 'a'.repeat(64), joinToken: 'b'.repeat(64), state });
    }
    const state = rooms.get(payload.room);
    if (!state) return reply({ code: 'ROOM_NOT_FOUND', error: 'Invalid room' }, 404);
    if (payload.action === 'search') {
      if (searchArrived) { const arrived = searchArrived; searchArrived = null; arrived(); await new Promise((resolve) => { releaseSearch = resolve; }); }
      if (searchFailure) return reply({ code: searchFailure, error: 'Search unavailable' }, searchFailure === 'SEARCH_RATE_LIMITED' ? 429 : 503);
      return reply({ items: payload.pageToken ? [sample[2]] : sample, nextPageToken: payload.pageToken ? null : 'CAoQAA', source: 'youtube' });
    }
    if (payload.action === 'add') {
      const song = { id: payload.requestId, videoId: payload.videoId, title: payload.title };
      if (!state.queue.some((item) => item.id === song.id) && state.current?.id !== song.id) payload.priority ? state.queue.unshift(song) : state.queue.push(song);
      state.revision++;
    }
    if (payload.action === 'play') { if (!state.current) state.current = state.queue.shift() || null; state.playing = Boolean(state.current); state.revision++; }
    if (payload.action === 'prioritize') { const index = state.queue.findIndex((item) => item.id === payload.itemId); if (index >= 0) state.queue.unshift(...state.queue.splice(index, 1)); state.revision++; }
    if (payload.action === 'close') { state.closed = true; state.playing = false; state.revision++; }
    return reply({ state });
  });
  context.on('page', (page) => page.on('pageerror', (error) => browserErrors.push(error.message)));
}

try {
  server = createServer(async (request, response) => {
    let name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
    if (name === 'hana_karaoke') name += '.html';
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep) || !/^(hana_karaoke\.html|assets\/)/.test(name)) return response.writeHead(404).end();
    try { response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/hana_karaoke`;
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await setup(context);
  const page = await context.newPage(); await page.goto(base);
  check(await page.locator('#create').isDisabled() && calls.length === 0, 'consent gates room creation and initial API access');
  check(await page.evaluate(() => window.__playerCreates) === 0, 'no YouTube player before consent');
  await page.locator('#searchConsent').check(); await page.locator('#create').click(); await page.locator('#session').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#playerFrame iframe')?.title === 'YouTube karaoke player');
  check(await page.locator('#create').innerText() === '재생 화면 시작하기', 'playback screen label is device-neutral');
  await page.locator('#searchQuery').fill('same raw query');
  check(calls.filter((call) => call.action === 'search').length === 0, 'typing does not consume search quota');
  await page.locator('#searchSubmit').click(); await page.locator('.search-result').nth(2).waitFor();
  if (process.env.KARAOKE_SCREENSHOT) await page.screenshot({ path: process.env.KARAOKE_SCREENSHOT, fullPage: true });
  check(calls.find((call) => call.action === 'search').query === 'same raw query', 'query is submitted unchanged');
  check(await page.locator('.result-title').nth(1).innerText() === 'Learn &amp; HTML', 'already-decoded plain text is not decoded twice');
  check(await page.locator('#searchResults script').count() === 0 && await page.locator('#searchResults img[onerror]').count() === 0, 'result metadata stays text, not executable markup');
  check(await page.locator('.search-result').nth(1).locator('img').count() === 0, 'unapproved thumbnail host is rejected');
  await page.locator('.result-main').first().dblclick();
  await page.waitForFunction(() => document.querySelector('.result-label')?.textContent === '예약 완료');
  check(calls.filter((call) => call.action === 'add').length === 1, 'double tap reserves a result only once');
  await page.locator('.result-priority').nth(1).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.result-label')].filter((node) => node.textContent === '예약 완료').length === 2);
  check(calls.filter((call) => call.action === 'add').at(-1).priority === true, 'result priority reservation sends priority true');
  const state = rooms.get('123456');
  check(state.queue[0].videoId === sample[1].videoId && state.current === null, 'priority goes to queue front without starting or interrupting a song');
  await page.locator('#startTV').click();
  await page.waitForFunction(() => document.querySelector('#currentPhone').textContent.includes('Learn &amp; HTML'));
  const currentId = state.current.id;
  await page.locator('.result-main').nth(2).click(); await page.waitForFunction(() => [...document.querySelectorAll('.result-label')].every((node) => node.textContent === '예약 완료'));
  await page.locator('#queue .song').last().locator('.priority-queue').click();
  await page.waitForFunction(() => document.querySelector('#queue .song-title')?.textContent === 'Third song');
  check(calls.at(-1).action !== 'search' && state.current.id === currentId && state.queue[0].videoId === sample[2].videoId, 'queued priority changes only waiting order');
  await page.locator('#searchMore').click(); await page.waitForFunction(() => document.querySelectorAll('.search-result').length === 1);
  check(calls.filter((call) => call.action === 'search').at(-1).pageToken === 'CAoQAA', 'pagination is explicit and uses returned page token');
  const searchCount = calls.filter((call) => call.action === 'search').length;
  searchFailure = 'SEARCH_NOT_CONFIGURED'; await page.locator('#searchSubmit').click();
  await page.waitForFunction(() => document.querySelector('#searchStatus').textContent.includes('준비 중'));
  check(calls.filter((call) => call.action === 'search').length === searchCount + 1, 'search service failure is not automatically retried');
  check(await page.locator('#manualEntry').evaluate((node) => node.open), 'unconfigured search opens manual-link fallback');
  searchFailure = '';
  const arrived = new Promise((resolve) => { searchArrived = resolve; });
  await page.locator('#searchSubmit').click(); await arrived;
  await page.locator('#lang').selectOption('vi'); releaseSearch();
  check(await page.locator('.search-result').count() === 0, 'language change discards in-flight search results');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px view has no horizontal overflow');
  await page.locator('#searchConsent').uncheck();
  check(await page.locator('#session').isHidden() && await page.locator('#create').isDisabled(), 'revoking consent stops the session and gates re-entry');
  check(await page.evaluate(() => window.__playerDestroys > 0), 'revoking consent destroys the YouTube player');
  await page.locator('#searchConsent').check(); await page.locator('#session').waitFor({ state: 'visible' });
  check(await page.locator('#roomCode').innerText() === '123456', 're-agreement restores retained room once');

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }); await setup(phoneContext);
  const phone = await phoneContext.newPage(); let phoneApiCalls = 0;
  phone.on('request', (request) => { if (request.url().endsWith('/functions/v1/hana-karaoke')) phoneApiCalls++; });
  await phone.goto(base + '?room=123456#join=' + 'b'.repeat(64));
  check(!phone.url().includes('#join=') && await phone.locator('#session').isHidden() && phoneApiCalls === 0, 'fresh QR invitation is captured and scrubbed before consent, with no API call');
  await phone.locator('#searchConsent').check(); await phone.locator('#session').waitFor({ state: 'visible' });
  check(await phone.locator('#tvPanel').isHidden(), 'pending QR invitation resumes once as phone remote');
  check(await page.locator('#phoneControls').isHidden(), 'TV host still hides phone-only playback controls');
  check(await phone.locator('#phoneControls').evaluate(node => node.parentElement.classList.contains('session-grid')), 'phone controls are independent of the search panel');
  check(await phone.evaluate(() => {
    const panels = [...document.querySelector('.session-grid').children];
    return panels[0].id === 'phoneControls' && panels[1].classList.contains('queue-panel') && panels[2].id === 'phonePanel';
  }), 'DOM reading and keyboard order is controls, queue, then search');
  for (const viewport of [{width:320,height:740},{width:390,height:844},{width:844,height:390},{width:1024,height:768}]) {
    await phone.setViewportSize(viewport);
    const controls = await phone.locator('#phoneControls').boundingBox();
    const queue = await phone.locator('.queue-panel').boundingBox();
    const search = await phone.locator('#phonePanel').boundingBox();
    check(controls && queue && search && controls.y + controls.height <= queue.y + 1 && queue.y + queue.height <= search.y + 1,
      `phone layout ${viewport.width}px: controls and queue are above search`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `phone layout ${viewport.width}px has no horizontal overflow`);
  }
  await phone.setViewportSize({width:390,height:844});
  if (process.env.KARAOKE_PHONE_SCREENSHOT) await phone.screenshot({ path: process.env.KARAOKE_PHONE_SCREENSHOT, fullPage:true });
  check(browserErrors.length === 0, 'no browser runtime exceptions');
  console.log(`Karaoke search browser: ${checks} checks passed (all external services mocked).`);
} finally {
  releaseSearch?.();
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
