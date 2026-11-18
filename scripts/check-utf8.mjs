// Temporary build diagnostic: report any source file that is not valid UTF-8.
// Prints size, sha1 (git blob hash) and the bytes around the first bad offset.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const decoder = new TextDecoder('utf-8', { fatal: true });

function gitBlobHash(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function firstBadOffset(buf) {
  for (let i = 0; i < buf.length; i++) {
    try {
      decoder.decode(buf.subarray(0, i + 1), { stream: false });
    } catch {
      // the prefix up to i is invalid only if a complete sequence fails; probe forward a little
      try {
        decoder.decode(buf.subarray(0, Math.min(buf.length, i + 4)));
      } catch {
        return i;
      }
    }
  }
  return -1;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|css)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk('src', []);
let bad = 0;
for (const f of files) {
  const buf = readFileSync(f);
  try {
    decoder.decode(buf);
  } catch {
    bad++;
    const off = firstBadOffset(buf);
    const from = Math.max(0, off - 16);
    console.log(`[check-utf8] INVALID ${f} size=${buf.length} blob=${gitBlobHash(buf)} badOffset=${off}`);
    console.log(`[check-utf8]   bytes@${from}: ${buf.subarray(from, from + 48).toString('hex')}`);
  }
}
const ssrf = readFileSync('src/lib/ssrf.ts');
console.log(`[check-utf8] src/lib/ssrf.ts size=${ssrf.length} blob=${gitBlobHash(ssrf)}`);
console.log(`[check-utf8] scanned ${files.length} files, invalid=${bad}`);
