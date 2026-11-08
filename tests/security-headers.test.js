const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const headers = config.headers.find(entry => entry.source === '/(.*)').headers;
const value = name => headers.find(header => header.key.toLowerCase() === name.toLowerCase())?.value;

test('production responses include baseline anti-sniffing and anti-framing headers', () => {
  assert.equal(value('X-Content-Type-Options'), 'nosniff');
  assert.equal(value('X-Frame-Options'), 'DENY');
  assert.equal(value('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.match(value('Permissions-Policy'), /camera=\(\)/);
  assert.match(value('Permissions-Policy'), /microphone=\(\)/);
  assert.match(value('Permissions-Policy'), /geolocation=\(\)/);
});

test('CSP blocks plugin objects, base URI injection, external framing and form exfiltration', () => {
  const csp = value('Content-Security-Policy');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
});
