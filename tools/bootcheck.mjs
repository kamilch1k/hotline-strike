import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const p = await b.newPage({ viewport: { width: 900, height: 560 } });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.goto(url, { waitUntil: 'domcontentloaded' });
try {
  await p.waitForFunction('!!window.__ENGINE__', null, { timeout: 120000 });
  console.log('ENGINE UP');
} catch { console.log('ENGINE DID NOT COME UP'); }
await p.waitForTimeout(3000);
console.log('errors:', errs.length ? errs.slice(0, 6) : 'none');
await b.close();
