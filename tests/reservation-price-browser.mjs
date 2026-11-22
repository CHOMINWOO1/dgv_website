// Isolated reservation fixture: every request is intercepted; no live auth or database writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';

const {chromium} = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || 'C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const projectRoot = new URL('../', import.meta.url);
const html = (await fs.readFile(new URL('reservation.html', projectRoot), 'utf8'))
  .replace(/<script\b[^>]*\bsrc\s*=[^>]*>[\s\S]*?<\/script>/gi, '');
const appURL = 'https://reservation-fixture.test/reservation.html';
const apiURL = 'https://supabase-fixture.test';
const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log('PASS', label); };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; console.log('PASS', label); };

async function createFixture(role = 'manager') {
  const context = await browser.newContext({viewport: {width: 1280, height: 1000}, serviceWorkers: 'block'});
  const page = await context.newPage();
  const errors = [], unexpectedRequests = [], reads = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({role, apiURL}) => {
    window.fixture = {
      role, writes: [], authCalls: [], identityCalls: 0, headerCalls: 0,
      rows: [{id: 'seed', created_at: '2026-11-22T00:00:00Z', res_date: '2026-11-23', res_time: '18:00', branch: 'ANT', guests_count: 4, price: 400000, menu_ko: '기존 메뉴', menu_vi: 'Fixture menu', guide_name: 'Fixture guide', note: 'Fixture-only reservation'}]
    };
    window.DGV = {
      config: {url: apiURL},
      escapeHTML: text => String(text ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char])),
      getIdentity: async () => { fixture.identityCalls++; return {role: fixture.role}; },
      signInAsAny: async (roles, password) => {
        fixture.authCalls.push({roles: [...roles], password});
        if (password !== 'fixture-manager') throw new Error('fixture authentication rejected');
        fixture.role = 'manager';
        return {role: fixture.role};
      },
      authHeaders: async () => { fixture.headerCalls++; return {Authorization: 'Bearer fixture-only-token', apikey: 'fixture-only-key'}; },
      supabase: {
        rpc: async (name, body) => {
          if (name !== 'app_create_reservation') throw new Error(`Unexpected fixture RPC: ${name}`);
          const id = `fixture-${fixture.writes.length + 1}`;
          fixture.writes.push({name, body: structuredClone(body)});
          const row = {id, created_at: `2026-11-22T00:00:${String(fixture.writes.length).padStart(2, '0')}Z`};
          for (const [key, value] of Object.entries(body)) row[key.replace(/^p_/, '')] = value;
          fixture.rows.unshift(row);
          return {data: id, error: null};
        }
      }
    };
  }, {role, apiURL});
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.url() === appURL && request.isNavigationRequest()) {
      await route.fulfill({status: 200, contentType: 'text/html', body: html});
    } else if (url.origin === apiURL && url.pathname === '/rest/v1/resv_groups' && request.method() === 'GET') {
      reads.push({url: request.url(), headers: request.headers()});
      const rows = await page.evaluate(() => structuredClone(fixture.rows));
      await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(rows)});
    } else {
      unexpectedRequests.push({url: request.url(), method: request.method()});
      await route.abort('blockedbyclient');
    }
  });
  await page.goto(appURL);
  return {context, page, errors, unexpectedRequests, reads};
}

async function prepare(page, {price = '200000', branch = 'ANT', menu = '김치찌개', time = '18:07'} = {}) {
  await page.locator('#res_date').fill('2026-11-24');
  await page.locator('#res_time_raw').fill(time);
  await page.locator('#guests_count').fill('13');
  await page.locator('#price').fill(price);
  await page.locator('#branch_select').selectOption(branch);
  await page.locator('#menu_select').selectOption(menu);
  await page.locator('#guide_name').fill(' Fixture guide ');
  await page.locator('#note').fill(' Fixture note ');
}

async function submit(page) {
  const count = await page.evaluate(() => fixture.writes.length);
  await page.locator('#btnSubmit').click();
  await page.waitForFunction(count => fixture.writes.length === count + 1 && !document.getElementById('btnSubmit').disabled, count);
  return page.evaluate(() => structuredClone(fixture.writes.at(-1)));
}

async function rejected(page, messagePattern, label) {
  const before = await page.evaluate(() => ({writes: fixture.writes.length, identityCalls: fixture.identityCalls}));
  await page.locator('#btnSubmit').click();
  await page.waitForFunction(() => !document.getElementById('btnSubmit').disabled);
  check(messagePattern.test(await page.locator('#msg').innerText()), label);
  equal(await page.evaluate(() => ({writes: fixture.writes.length, identityCalls: fixture.identityCalls})), before, `${label}: rejected before auth or RPC`);
}

try {
  const main = await createFixture(), {page} = main;
  await page.locator('#savedCards .rcard').waitFor();
  const price = page.locator('#price');
  equal(await price.getAttribute('type'), 'text', 'PRICE is a text control that can show grouping separators');
  equal(await price.getAttribute('inputmode'), 'numeric', 'PRICE retains a numeric mobile keyboard');
  equal(await page.locator('#branch_select').inputValue(), 'ANT', 'default branch remains ANT');
  equal(await page.locator('#menu_select').inputValue(), '__custom__', 'default menu remains custom input');
  check((await page.locator('#savedCards').innerText()).includes('400,000 VND'), 'existing saved cards still format prices');
  check(main.reads.length === 1 && main.reads[0].headers.authorization === 'Bearer fixture-only-token', 'initial saved-card load still uses authenticated read headers');

  await price.focus();
  for (const [digit, expected] of [['2', '2'], ['0', '20'], ['0', '200'], ['0', '2,000'], ['0', '20,000'], ['0', '200,000']]) {
    await price.pressSequentially(digit);
    equal(await price.inputValue(), expected, `live input ${expected} is formatted immediately`);
  }
  check(await price.evaluate(el => document.activeElement === el), 'formatting occurs while focused, without blur or save');
  equal(await price.evaluate(el => el.selectionStart), 7, 'typing keeps the caret at the end');
  await price.fill('123456789012');
  equal(await price.inputValue(), '123,456,789,012', 'large pasted digit strings format without precision loss');
  await price.fill('1,234,567');
  equal(await price.inputValue(), '1,234,567', 'already-grouped pasted amounts are not double-formatted');
  await price.fill('1234567');
  equal(await price.inputValue(), '1,234,567', 'ungrouped pasted amounts normalize to comma groups');

  await price.evaluate(el => el.setSelectionRange(1, 1));
  await price.pressSequentially('9');
  equal(await price.inputValue(), '19,234,567', 'inserting in the middle preserves the intended amount');
  equal(await price.evaluate(el => el.selectionStart), 2, 'middle insertion preserves the logical caret');
  await price.press('Backspace');
  equal(await price.inputValue(), '1,234,567', 'backspace continues at the middle insertion position');
  await price.evaluate(el => el.setSelectionRange(2, 5));
  await price.pressSequentially('9');
  equal(await price.inputValue(), '19,567', 'replacing a selected digit group preserves remaining digits');
  await price.fill('200000');
  await price.evaluate(el => el.setSelectionRange(4, 4));
  await price.press('Backspace');
  equal(await price.inputValue(), '20,000', 'backspace immediately after a comma removes the adjacent digit');
  await price.fill('200000');
  await price.evaluate(el => el.setSelectionRange(3, 3));
  await price.press('Delete');
  equal(await price.inputValue(), '20,000', 'delete immediately before a comma removes the adjacent digit');
  await price.press('End');
  await price.pressSequentially('1');
  equal(await price.inputValue(), '200,001', 'typing continues normally after comma-adjacent deletion');
  await price.press('ControlOrMeta+A');
  await price.press('Backspace');
  equal(await price.inputValue(), '', 'select-all deletion clears PRICE completely');
  await price.pressSequentially('0');
  equal(await price.inputValue(), '0', 'an explicit zero remains visible');

  await prepare(page);
  equal(await page.locator('#time_preview').innerText(), '18:10', 'TIME still rounds to nearest ten minutes');
  await page.locator('#res_date').fill('');
  await rejected(page, /DATE \/ TIME/, 'DATE remains required');
  await page.locator('#res_date').fill('2026-11-24');
  await page.locator('#res_time_raw').fill('bad');
  await rejected(page, /DATE \/ TIME/, 'invalid TIME remains rejected');
  await page.locator('#res_time_raw').fill('18:07');
  await page.locator('#branch_select').selectOption('__custom__');
  await page.locator('#branch_custom').fill('');
  await rejected(page, /BRANCH/, 'custom BRANCH remains required');
  await page.locator('#branch_select').selectOption('ANT');
  await page.locator('#guests_count').fill('0');
  await rejected(page, /NUMBER OF GUESTS/, 'guest count must remain positive');
  await page.locator('#guests_count').fill('13');
  for (const value of ['-100', '1.5', 'not-a-price', '2147483648', '9007199254740993']) {
    await price.fill(value);
    await rejected(page, /PRICE/, `invalid PRICE ${value} is not silently converted or rounded`);
  }
  await price.fill('200000');
  const readsBeforeSave = main.reads.length;
  const saved = await submit(page);
  equal(saved, {name: 'app_create_reservation', body: {p_res_date: '2026-11-24', p_res_time: '18:10', p_guests_count: 13, p_price: 200000, p_menu_ko: '김치찌개', p_menu_vi: 'Canh kim chi', p_note: 'Fixture note', p_branch: 'ANT', p_guide_name: 'Fixture guide'}}, 'save retains the RPC contract and sends numeric p_price, never comma text');
  check(typeof saved.body.p_price === 'number', 'saved p_price is a JSON number');
  check(main.reads.length === readsBeforeSave + 1, 'a successful save refreshes the saved-card list');
  equal(await page.locator('#savedCards .rcard').count(), 2, 'the new fixture reservation appears in saved cards');
  check((await page.locator('#savedCards .rcard').first().innerText()).includes('200,000 VND'), 'the saved card displays the correct formatted amount');
  equal(await price.inputValue(), '', 'successful save clears the formatted PRICE control');
  equal(await page.locator('#time_preview').innerText(), '--:--', 'successful save still resets TIME preview');
  equal(await page.locator('#branch_select').inputValue(), 'ANT', 'successful save still resets the default branch');

  await prepare(page, {price: '0', branch: '__custom__', menu: '__custom__', time: '23:59'});
  await page.locator('#branch_custom').fill(' DALAT ');
  await page.locator('#menu_ko').fill(' 제육볶음 ');
  equal(await page.locator('#menu_vi').inputValue(), 'Heo xào', 'custom menu still auto-translates a recognized Korean dish');
  await page.locator('#menu_vi').fill(' Fixture custom menu ');
  const zero = await submit(page);
  equal(zero.body.p_price, 0, 'explicit PRICE zero saves as numeric zero, not null');
  equal(zero.body.p_branch, 'DALAT', 'custom branch is still trimmed and saved');
  equal([zero.body.p_menu_ko, zero.body.p_menu_vi], ['제육볶음', 'Fixture custom menu'], 'custom menu values are still trimmed and saved');
  equal(zero.body.p_res_time, '23:50', 'late TIME still clamps to the final ten-minute slot');
  check((await page.locator('#savedCards .rcard').first().innerText()).includes('0 VND'), 'zero remains distinct in saved cards');

  await prepare(page, {price: ''});
  const blank = await submit(page);
  equal(blank.body.p_price, null, 'blank optional PRICE saves null, not zero or an empty string');
  equal(await page.locator('#savedCards .rcard').first().locator('.row').first().locator('.v').innerText(), '-', 'blank PRICE remains absent in the saved card');
  await prepare(page, {price: '2147483647'});
  const largest = await submit(page);
  equal(largest.body.p_price, 2147483647, 'the database integer maximum remains exact in the numeric payload');
  await prepare(page, {price: '1.5', branch: '__custom__', menu: '__custom__'});
  await page.locator('#branch_custom').fill('DALAT');
  await page.locator('#btnClear').click();
  equal(await price.inputValue(), '', 'Clear resets invalid or formatted PRICE');
  check(await price.evaluate(el => el.checkValidity()), 'Clear does not leave stale PRICE validation state');
  equal(await page.locator('#branch_select').inputValue(), 'ANT', 'Clear retains original branch-reset behavior');
  equal(await page.locator('#menu_select').inputValue(), '__custom__', 'Clear retains original menu-reset behavior');
  equal(await page.locator('#res_date').inputValue(), '', 'Clear still resets required date');
  const readsBeforeReload = main.reads.length;
  await page.locator('#btnReload').click();
  await page.waitForFunction(() => document.getElementById('savedMsg').textContent === '');
  check(main.reads.length === readsBeforeReload + 1, 'manual saved-card reload is unchanged');

  await prepare(page);
  await page.evaluate(() => { fixture.role = 'guest'; });
  await page.locator('#btnSubmit').click();
  await page.locator('#passModal').waitFor({state: 'visible'});
  const writesBeforeCancel = await page.evaluate(() => fixture.writes.length);
  await page.locator('#passCancelBtn').click();
  await page.waitForFunction(() => !document.getElementById('btnSubmit').disabled);
  equal(await page.evaluate(() => fixture.writes.length), writesBeforeCancel, 'canceling password modal prevents reservation writes');
  check((await page.locator('#msg').innerText()).includes('취소'), 'password cancellation still reports its existing message');
  await page.locator('#btnSubmit').click();
  await page.locator('#passModal').waitFor({state: 'visible'});
  await page.locator('#passInput').fill('fixture-manager');
  await page.locator('#passInput').press('Enter');
  await page.waitForFunction(count => fixture.writes.length === count + 1 && !document.getElementById('btnSubmit').disabled, writesBeforeCancel);
  equal(await page.evaluate(() => fixture.authCalls.at(-1).roles), ['manager', 'admin'], 'save authentication still allows exactly manager or admin');
  equal(await page.evaluate(() => fixture.writes.at(-1).body.p_price), 200000, 'password-protected save still sends the unformatted numeric amount');
  check(!(await page.evaluate(() => JSON.stringify(fixture.writes))).includes('fixture-manager'), 'authentication secret is not added to reservation payloads');

  const auth = await createFixture('guest');
  await auth.page.locator('#passModal').waitFor({state: 'visible'});
  equal(auth.reads.length, 0, 'initial authentication still gates saved-card reads');
  await auth.page.locator('#passInput').fill('fixture-manager');
  await auth.page.locator('#passOkBtn').click();
  await auth.page.locator('#savedCards .rcard').waitFor();
  equal(await auth.page.locator('#branch_select').inputValue(), 'ANT', 'initial password authentication still initializes reservation controls');
  equal(await auth.page.evaluate(() => fixture.writes.length), 0, 'initial authentication does not create a reservation');
  equal(main.errors.concat(auth.errors), [], 'both authenticated paths run without browser exceptions');
  equal(main.unexpectedRequests.concat(auth.unexpectedRequests), [], 'all requests stay inside intercepted fixture URLs');
  check(main.reads.concat(auth.reads).every(read => new URL(read.url).searchParams.get('limit') === '20'), 'saved-card fetch still requests the latest twenty reservations');
  await page.setViewportSize({width: 390, height: 844});
  await price.fill('200000');
  await price.scrollIntoViewIfNeeded();
  equal(await price.inputValue(), '200,000', 'mobile PRICE formats while focused');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile reservation layout has no horizontal overflow');
  await page.screenshot({path: fileURLToPath(new URL('tmp/reservation-price-mobile.png', projectRoot))});
  console.log(`Reservation PRICE browser: ${checks} checks passed, all external services mocked; only in-memory fixture writes.`);
} finally {
  await browser.close();
}
