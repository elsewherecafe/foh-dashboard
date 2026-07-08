// selftest.mjs - run in the scaffold folder before every push.
// Catches the mounted-folder sync hazard (truncation / null-padding) and gross
// parse errors, per playbook.md. Green = safe to push. Not a substitute for
// reconciliation; it only proves the files are whole and parseable.
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

function workerSyntaxOk(text) {
  // Strip the HTML text-import (Cloudflare Workers bundler feature, not valid Node)
  // then have Node itself parse the module. This is the true ESM syntax check.
  const stripped = text.replace(/import\s+dashboardHtml\s+from\s+['"]\.\/dashboard\.html['"];/, 'const dashboardHtml = "";');
  const tmp = '.selftest.worker.mjs';
  writeFileSync(tmp, stripped);
  try { execSync('node --check ' + tmp, { stdio: 'pipe' }); return null; }
  catch (e) { return (e.stderr || e.stdout || '' + e).toString().split('\n').slice(0, 3).join(' '); }
  finally { try { unlinkSync(tmp); } catch (_) {} }
}

const REQUIRED = ['worker.js', 'dashboard.html', 'wrangler.toml', 'package.json'];
let failed = false;
const fail = (f, msg) => { failed = true; console.error('  FAIL  ' + f + ': ' + msg); };
const ok = (f, msg) => console.log('  ok    ' + f + ': ' + msg);

for (const f of REQUIRED) {
  if (!existsSync(f)) { fail(f, 'missing'); continue; }
  const buf = readFileSync(f);
  if (buf.length === 0) { fail(f, 'empty'); continue; }
  if (buf.includes(0)) { fail(f, 'contains NUL bytes (null-padded - rebuild via shell)'); continue; }
  const text = buf.toString('utf8');
  const trimmedEnd = text.trimEnd();

  if (f === 'worker.js') {
    if (!/EOF worker\.js/.test(text)) fail(f, 'missing EOF marker - likely truncated');
    else if (!/export default/.test(text)) fail(f, 'no export default - not a worker');
    else if (!/const ADAPTERS =/.test(text)) fail(f, 'ADAPTERS block missing');
    else { const err = workerSyntaxOk(text); if (err) fail(f, 'syntax error: ' + err); else ok(f, 'whole, parses, has adapters'); }
  } else if (f === 'dashboard.html') {
    if (!/EOF dashboard\.html/.test(text)) fail(f, 'missing EOF marker - likely truncated');
    else if (!/<\/html>/.test(trimmedEnd.slice(-200) + text.slice(-200))) fail(f, 'no closing </html>');
    else if (!/fetchData\(\)|load\(false\)|load\(\)/.test(text)) fail(f, 'main data call missing - likely truncated');
    else ok(f, 'whole, closing tags present');
  } else if (f === 'wrangler.toml') {
    if (!/EOF wrangler\.toml/.test(text)) fail(f, 'missing EOF marker - likely truncated');
    else if (!/^name\s*=/m.test(text)) fail(f, 'no name field');
    else if (!/binding = "TOKENS"/.test(text)) fail(f, 'TOKENS KV binding missing');
    else if (/^name\s*=\s*"venue-dashboard"/m.test(text)) console.warn('  warn  ' + f + ': name still the default "venue-dashboard" - set it to the repo name before first push');
    else ok(f, 'whole, TOKENS binding present');
    if (/^name\s*=/m.test(text) && !/EOF wrangler\.toml/.test(text) === false) {} // no-op guard
  } else if (f === 'package.json') {
    try { const j = JSON.parse(text); if (!j.scripts || !j.scripts.deploy) fail(f, 'no deploy script'); else ok(f, 'valid JSON, deploy script present'); }
    catch (e) { fail(f, 'invalid JSON: ' + e.message); }
  }
}

console.log(failed ? '\nSELFTEST: RED - do not push.' : '\nSELFTEST: GREEN - safe to push.');
process.exit(failed ? 1 : 0);
