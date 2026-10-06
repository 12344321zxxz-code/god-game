import './ui/style.css';
import { decodeParams, encodeParams, presetParams, type PlanetParams } from './core/presets';
import { CellLocator } from './grid/locator';
import { dirToLatLon } from './grid/sampler';
import { plateArrows } from './render/arrows';
import type { MapMode } from './render/bake';
import { PlanetView } from './render/view';
import { WorldClient } from './sim/client';
import type { CellData, WorkerResponse } from './sim/protocol';
import { BOUNDARY_NAMES, OROGENY_NAMES, type Plate, type WorldStats } from './sim/world';
import { Panel, randomSeed, type DisplayState } from './ui/panel';

const TEX_W = 4096;
const TEX_H = 2048;

const stage = document.getElementById('stage')!;
const hoverEl = document.getElementById('hover')!;
const statusEl = document.getElementById('status')!;
const legendEl = document.getElementById('legend')!;

const problemEl = document.getElementById('problem')!;
function showProblem(msg: string) {
  problemEl.textContent = msg;
  problemEl.classList.remove('hidden');
}
window.addEventListener('error', (e) => showProblem(`Error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => showProblem(`Error: ${String(e.reason)}`));

const view = new PlanetView(stage);
view.onProblem = showProblem;
const client = new WorldClient();

let params: PlanetParams = decodeParams(location.hash) ?? presetParams('earth', randomSeed());
let display: DisplayState = { view: 'globe', mode: 'satellite', hex: false, arrows: false, relief: 10 };

interface Current {
  params: PlanetParams;
  stats: WorldStats;
  plates: Plate[];
  cells: CellData;
  locator: CellLocator;
  rgba: Uint8Array;
  width: number;
  height: number;
}
let current: Current | undefined;
let latestGenerate = 0;
let latestRender = 0;

const panel = new Panel(document.getElementById('panel')!, params, display, {
  onParams(p) {
    params = p;
    scheduleGenerate();
  },
  onDisplay(d, changed) {
    display = d;
    if (changed === 'view') view.setView(d.view);
    if (changed === 'relief') view.setRelief(d.relief);
    if (changed === 'arrows') updateArrows();
    if (changed === 'mode' || changed === 'hex') requestRender();
    updateLegend();
  },
  onExportView() {
    void download(view.screenshot(), `${fileStem()}-view.png`);
  },
  onExportMap() {
    if (current) void download(textureToPng(current.rgba, current.width, current.height), `${fileStem()}-${display.mode}-map.png`);
  },
  async onCopyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      flashStatus('Link copied');
    } catch {
      flashStatus(`Copy this link: ${location.href}`);
    }
  },
});
view.setRelief(display.relief);

// --- generation --------------------------------------------------------------

let genTimer: number | undefined;
function scheduleGenerate() {
  window.clearTimeout(genTimer);
  genTimer = window.setTimeout(generate, 250);
}

async function generate() {
  try {
    history.replaceState(null, '', `#${encodeParams(params)}`);
  } catch {
    // sandboxed previews may block history changes; links just won't update
  }
  setStatus('Starting…', 0.02);
  latestGenerate = client.send({ type: 'generate', params, texWidth: TEX_W, texHeight: TEX_H, mode: display.mode, hex: display.hex });
}

async function requestRender() {
  if (!current) return;
  setStatus('Repainting…', 0.5);
  latestRender = client.send({ type: 'render', mode: display.mode, hex: display.hex });
}

client.onMessage((msg: WorkerResponse) => {
  switch (msg.type) {
    case 'progress':
      if (msg.id === latestGenerate) setStatus(msg.stage, msg.fraction);
      break;
    case 'generated': {
      if (msg.id !== latestGenerate) return; // a newer request is on its way
      const cells = msg.cells;
      current = {
        params: msg.params,
        stats: msg.stats,
        plates: msg.plates,
        cells,
        locator: new CellLocator({ pos: cells.pos, nbrOffset: cells.nbrOffset, nbrs: cells.nbrs, count: cells.plate.length }),
        rgba: msg.rgba,
        width: msg.width,
        height: msg.height,
      };
      view.setTextures(msg.rgba, msg.heightMap, msg.width, msg.height, msg.params.radiusKm);
      panel.setStats(msg.stats, msg.params.radiusKm, msg.params.gravity);
      panel.setScore(msg.score);
      updateArrows();
      updateLegend();
      // If the mode changed while generating, repaint in the new mode.
      if (msg.mode !== display.mode) requestRender();
      else clearStatus(client.mode === 'main-thread' ? ' (main thread)' : '');
      break;
    }
    case 'texture':
      if (msg.id !== latestRender || !current) return;
      current.rgba = msg.rgba;
      view.setColor(msg.rgba, msg.heightMap);
      clearStatus();
      break;
    case 'error':
      console.error(msg.message);
      setStatus(`Error: ${msg.message.split('\n')[0]}`, 1);
      break;
  }
});

function updateArrows() {
  view.setArrows(display.arrows && current ? plateArrows(current.cells) : null);
}

// --- hover info ----------------------------------------------------------------

stage.addEventListener('pointermove', (e) => {
  if (!current) return;
  const dir = view.pick(e.clientX, e.clientY);
  if (!dir) {
    hoverEl.classList.add('hidden');
    return;
  }
  const c = current.locator.nearest(dir[0], dir[1], dir[2]);
  const d = current.cells;
  const { lat, lon } = dirToLatLon(dir[0], dir[1], dir[2]);
  const elev = d.elevation[c];
  const speed = Math.hypot(d.velocity[3 * c], d.velocity[3 * c + 1], d.velocity[3 * c + 2]);
  const rows: [string, string][] = [
    ['Position', `${fmtLat(lat)} ${fmtLon(lon)}`],
    [elev >= 0 ? 'Elevation' : 'Depth', `${Math.abs(Math.round(elev)).toLocaleString()} m`],
    ['Crust', (d.crust[c] ? 'Continental' : `Oceanic, ${Math.round(d.oceanAge[c])} Myr old`) + (d.thickness[c] ? ` · ${Math.round(d.thickness[c])} km thick` : '')],
    ['Plate', `#${d.plate[c]} · ${speed.toFixed(0)} mm/yr`],
  ];
  if (d.orogeny[c]) rows.push(['Landform', OROGENY_NAMES[d.orogeny[c]]]);
  if (d.boundary[c]) rows.push(['Boundary', `${BOUNDARY_NAMES[d.boundary[c]]} (${Math.abs(d.boundaryRate[c]).toFixed(0)} mm/yr)`]);
  rows.push(['Cell', `#${c}`]);
  hoverEl.innerHTML = `<table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  hoverEl.classList.remove('hidden');
});
stage.addEventListener('pointerleave', () => hoverEl.classList.add('hidden'));

// --- legend ------------------------------------------------------------------------

function updateLegend() {
  const m: MapMode = display.mode;
  if (m === 'plates') {
    legendEl.innerHTML = [
      ['#e63c32', 'Convergent'],
      ['#3c96f0', 'Divergent'],
      ['#78d25a', 'Transform'],
    ].map(([c, l]) => `<div class="item"><span class="sw" style="background:${c}"></span>${l}</div>`).join('');
  } else if (m === 'elevation') {
    legendEl.innerHTML = `<div>Elevation</div><div class="grad" style="background:linear-gradient(90deg,#080e30,#1e4687,#5fa0cd,#467d4b,#aaaa69,#91694f,#f5f5f5)"></div><div class="ticks"><span>−11 km</span><span>0</span><span>+9 km</span></div>`;
  } else if (m === 'age') {
    legendEl.innerHTML = `<div>Ocean crust age</div><div class="grad" style="background:linear-gradient(90deg,#dc2828,#f08c28,#f0dc46,#6ec85a,#3caac8,#325abe,#462882)"></div><div class="ticks"><span>0 Myr</span><span>100</span><span>200</span></div>`;
  } else {
    legendEl.innerHTML = `<div>Satellite (preview)</div>`;
  }
}

// --- status line ---------------------------------------------------------------------

function setStatus(text: string, fraction: number) {
  statusEl.classList.remove('hidden');
  statusEl.innerHTML = `${text}<div class="bar"><i style="width:${Math.round(fraction * 100)}%"></i></div>`;
}
function clearStatus(suffix = '') {
  if (!current) return;
  const s = current.stats;
  statusEl.innerHTML = `${current.params.seed} · ${s.cells.toLocaleString()} cells${suffix}`;
}
function flashStatus(text: string) {
  statusEl.textContent = text;
  window.setTimeout(() => clearStatus(), 1500);
}

// --- helpers ---------------------------------------------------------------------------

function fmtLat(v: number) { return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`; }
function fmtLon(v: number) { return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`; }
function fileStem() { return `planet-${params.seed.replace(/[^a-z0-9-]/gi, '_')}`; }

/** Saves a data-URL image. Inside a claude.ai artifact a page cannot
 *  download by itself: the file is handed to the viewer's `downloads`
 *  capability (which asks before saving); elsewhere a plain link does it. */
async function download(url: string, name: string) {
  const claude = (window as unknown as { claude?: { use?: (n: string) => Promise<{ save(r: { filename: string; data: Blob }): Promise<unknown> } | null> } }).claude;
  if (claude?.use) {
    try {
      const downloads = await claude.use('downloads');
      if (downloads) {
        const bin = atob(url.slice(url.indexOf(',') + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await downloads.save({ filename: name, data: new Blob([bytes], { type: 'image/png' }) });
        flashStatus('Image saved');
      } else {
        flashStatus('Saving is not available here');
      }
      return;
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'declined') flashStatus(code === 'rate_limited' ? 'A save is already waiting' : 'Saving is not available here');
      return;
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

function textureToPng(rgba: Uint8Array, w: number, h: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  // texture rows run south → north; images run top → bottom
  for (let r = 0; r < h; r++) img.data.set(rgba.subarray((h - 1 - r) * w * 4, (h - r) * w * 4), r * w * 4);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

window.addEventListener('hashchange', () => {
  const p = decodeParams(location.hash);
  if (p && encodeParams(p) !== encodeParams(params)) panel.setParams(p);
});

updateLegend();
generate();

// handy for debugging from the console
Object.assign(window, { godgame: { view, client, get current() { return current; } } });
