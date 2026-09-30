// Takes screenshots of the running app in headless Chromium (software WebGL).
// Usage: node scripts/screenshot.mjs [baseUrl] [outDir]
// Expects the app to be served (e.g. `npx vite preview --port 4173`).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:4173/';
const outDir = process.argv[3] ?? 'shots';
mkdirSync(outDir, { recursive: true });

const shots = [
  { name: 'earth-satellite-globe', hash: 's=basalt-drift-7&p=earth', mode: 'Satellite', view: 'Globe' },
  { name: 'earth-plates-globe', hash: 's=basalt-drift-7&p=earth', mode: 'Plates', view: 'Globe', arrows: true },
  { name: 'earth-satellite-map', hash: 's=basalt-drift-7&p=earth', mode: 'Satellite', view: 'Flat map' },
  { name: 'earth-elevation-map', hash: 's=basalt-drift-7&p=earth', mode: 'Elevation', view: 'Flat map' },
  { name: 'earth-age-map', hash: 's=basalt-drift-7&p=earth', mode: 'Crust age', view: 'Flat map' },
  { name: 'earth-plates-map', hash: 's=basalt-drift-7&p=earth', mode: 'Plates', view: 'Flat map', arrows: true },
  { name: 'mars-satellite-globe', hash: 's=basalt-drift-7&p=mars', mode: 'Satellite', view: 'Globe' },
];
const only = process.env.ONLY;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
async function freshPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[browser ${m.type()}]`, m.text());
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  return page;
}

for (const s of shots) {
  if (only && !s.name.includes(only)) continue;
  const t0 = Date.now();
  const page = await freshPage();
  await page.goto(`${base}#${s.hash}`);
  await page.waitForFunction(() => window.godgame?.current, null, { timeout: 600000 });
  const clickText = async (t) => page.locator('button', { hasText: t }).first().click();
  await clickText(s.view);
  if (s.arrows) await page.getByText('Plate motion arrows').click();
  if (s.mode !== 'Satellite') {
    await clickText(s.mode);
    await page.waitForFunction(() => !document.querySelector('#status .bar'), null, { timeout: 60000 });
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/${s.name}.png`, timeout: 180000 });
  console.log(`${s.name}: ${Date.now() - t0} ms`);
  await page.close();
}
await browser.close();
