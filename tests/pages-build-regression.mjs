import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPages, isPublicPath } from '../scripts/build-pages.mjs';

const fixture = mkdtempSync(path.join(tmpdir(), 'dgv-pages-test-'));
const root = path.join(fixture, 'source');
const destination = path.join(fixture, 'site');
const samples = {
  'index.html': '<!doctype html><a href="admin">Admin</a>',
  'admin.html': '<!doctype html><script src="assets/app.js"></script>',
  'hotel_reserv_list.html': '호텔 / Khách sạn',
  'CNAME': 'dalatgolfvoucher.com\n',
  'assets/app.js': 'console.log("unchanged");',
  'assets/models/model.bin': 'model data',
  'image/hotel/photo.jpg': 'photo bytes',
  'qr.png': 'QR bytes',
  'supabase/migrations/private.sql': 'not for public hosting',
  'tests/fixture.json': '{}',
  'scripts/internal.mjs': 'internal',
  '.env': 'never publish',
  'assets/.env': 'never publish',
  'package.json': '{}',
  'untracked.html': 'must not publish'
};
try {
  for (const [name, content] of Object.entries(samples)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  const trackedFiles = Object.keys(samples).filter(name => name !== 'untracked.html');
  const result = buildPages({ root, destination, trackedFiles });
  assert.equal(result.files.length, 8);
  for (const file of result.files) assert.deepEqual(readFileSync(path.join(destination, file)), readFileSync(path.join(root, file)));
  assert.equal(readFileSync(path.join(destination, 'CNAME'), 'utf8'), 'dalatgolfvoucher.com\n');
  assert.ok(existsSync(path.join(destination, '.nojekyll')));
  for (const file of Object.keys(samples).filter(name => !result.files.includes(name))) assert.equal(existsSync(path.join(destination, file)), false, file);
  for (const bad of ['../index.html', '/index.html', 'assets/../secret', 'assets/.keys/key', 'assets\\secret']) assert.equal(isPublicPath(bad), false);
  assert.throws(() => buildPages({ root, destination, trackedFiles }), /already exists/);
  assert.throws(() => buildPages({ root, destination: root, trackedFiles }), /overwrite/);
  assert.throws(() => buildPages({ root, destination: path.join(fixture, 'missing'), trackedFiles: ['index.html'] }), /CNAME/);
  assert.equal(existsSync(path.join(fixture, 'missing')), false);
  assert.equal(readFileSync(path.join(root, '.env'), 'utf8'), 'never publish');
  console.log('Pages packaging passed: unchanged HTML/assets/domain, tracked files only, private source excluded, safe fresh output.');
} finally {
  // Only the temporary fixture created by this test is removed.
  rmSync(fixture, { recursive: true, force: true });
}
