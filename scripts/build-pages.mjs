import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Only browser-delivered files belong in the public Pages artifact.
// SQL, tests, tooling, credentials and untracked local files stay out.
export function isPublicPath(file) {
  if (!file || file.includes('\\') || file.startsWith('/') || file.split('/').some(part => !part || part === '..' || part.startsWith('.'))) return false;
  if (file.startsWith('assets/') || file.startsWith('image/')) return true;
  if (file.includes('/')) return false;
  return file === 'CNAME' || file === 'robots.txt' || file === 'sitemap.xml'
    || file === 'manifest.json' || /\.(?:html|css|js|webmanifest|ico|png|jpe?g|gif|svg|webp|avif)$/i.test(file);
}

export function buildPages({ root, destination, trackedFiles }) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  if (destination === root || root.startsWith(destination + path.sep)) throw new Error('Output must not overwrite the source directory.');
  if (existsSync(destination)) throw new Error('Output already exists; use a fresh staging directory.');
  const files = [...new Set(trackedFiles.filter(isPublicPath))].sort();
  for (const required of ['index.html', 'CNAME']) {
    if (!files.includes(required)) throw new Error(`Missing required public file: ${required}`);
  }
  // Validate the complete inventory before creating any output.
  let bytes = 0;
  for (const file of files) {
    let current = root;
    for (const part of file.split('/')) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${file}`);
    }
    const stat = lstatSync(current);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${file}`);
    bytes += stat.size;
  }
  mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const target = path.join(destination, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, file), target);
  }
  // Preserve the plain HTML files and their existing GitHub Pages URLs.
  writeFileSync(path.join(destination, '.nojekyll'), '');
  return { files, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const result = buildPages({ root, destination: path.join(root, '_site'), trackedFiles });
  console.log(`Prepared ${result.files.length} public files (${result.bytes.toLocaleString('en-US')} bytes).`);
}
