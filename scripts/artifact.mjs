// Turns the single-file build (dist-single/index.html) into artifact-ready
// HTML: the artifact host supplies <!doctype>, <html>, <head> and <body>, so
// those wrappers are removed — but only OUTSIDE <script> blocks. (Stripping
// them inside scripts once deleted three.js's `#include <metalnessmap_fragment>`
// because it starts with "<meta".)
// Usage: node scripts/artifact.mjs [in] [out]
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] ?? 'dist-single/index.html';
const output = process.argv[3] ?? 'dist-single/artifact.html';
const src = readFileSync(input, 'utf8');

const parts = src.split(/(<script\b[\s\S]*?<\/script>)/i);
const cleaned = parts
  .map((p) => {
    if (/^<script\b/i.test(p)) return p;
    return p
      .replace(/<!doctype html>/gi, '')
      .replace(/<\/?html\b[^>]*>/gi, '')
      .replace(/<\/?head>/gi, '')
      .replace(/<meta\b[^>]*>/gi, '')
      .replace(/<\/?body\b[^>]*>/gi, '')
      .replace('<title>God Game — World Gen</title>', '<title>God Game World Gen</title>');
  })
  .join('')
  .trim();

// Guard: the script content must be byte-identical to the build.
const scripts = (s) => (s.match(/<script\b[\s\S]*?<\/script>/gi) ?? []).join('');
if (scripts(cleaned) !== scripts(src)) throw new Error('script content changed while cleaning');
if (!cleaned.includes('#include <metalnessmap_fragment>')) throw new Error('three.js shader chunks missing');
writeFileSync(output, cleaned + '\n');
console.log(`wrote ${output} (${cleaned.length} bytes)`);
