import { GRID_OPTIONS, PRESET_LABELS, cellCount, presetParams, type PlanetParams, type PresetId } from '../core/presets';
import { MAP_MODES, type MapMode } from '../render/bake';
import type { ViewMode } from '../render/view';
import type { Scorecard } from '../sim/metrics/scorecard';
import type { WorldStats } from '../sim/world';

export interface DisplayState {
  view: ViewMode;
  mode: MapMode;
  hex: boolean;
  arrows: boolean;
  relief: number;
}

export interface PanelHandlers {
  onParams(p: PlanetParams): void;
  onDisplay(d: DisplayState, changed: keyof DisplayState): void;
  onExportView(): void;
  onExportMap(): void;
  onCopyLink(): void;
}

const WORDS = ['ember', 'tide', 'aster', 'basalt', 'cinder', 'drift', 'fjord', 'gale', 'halo', 'isle', 'jade', 'karst', 'lumen', 'mesa', 'nadir', 'ore', 'pangea', 'quartz', 'rift', 'strata', 'terra', 'umber', 'vale', 'wadi', 'xeno', 'yarrow', 'zenith'];

export function randomSeed(): string {
  const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${w()}-${w()}-${Math.floor(Math.random() * 1000)}`;
}

/** Builds the right-hand control panel and keeps it in sync. */
export class Panel {
  private statsEl!: HTMLElement;
  private scoreEl!: HTMLElement;
  private scoreSumEl!: HTMLElement;
  private inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  private engineSeg!: HTMLElement;
  private driftRows: HTMLElement[] = [];

  constructor(
    private readonly root: HTMLElement,
    private params: PlanetParams,
    private display: DisplayState,
    private readonly h: PanelHandlers,
  ) {
    this.build();
    this.syncEngine();
  }

  private syncEngine() {
    for (const r of this.driftRows) r.style.display = this.params.engine === 'drift' ? '' : 'none';
    for (const b of this.engineSeg.children) b.classList.toggle('on', (b as HTMLElement).dataset.v === this.params.engine);
  }

  private build() {
    const r = this.root;
    r.innerHTML = '';
    r.append(el('div', { class: 'brand' }, [el('h1', {}, ['World Gen']), el('span', {}, ['M2b · plate simulation'])]));

    // --- Planet ---
    const planet = section('Planet');
    const presetSel = select(
      (Object.keys(PRESET_LABELS) as PresetId[]).map((id) => [id, PRESET_LABELS[id]]),
      this.params.preset,
      (v) => {
        if (v === 'custom') this.update({ preset: 'custom' });
        else this.setParams({ ...presetParams(v as Exclude<PresetId, 'custom'>, this.params.seed) });
      },
    );
    this.inputs.preset = presetSel;
    planet.append(row('Preset', presetSel));

    const seed = input('text', this.params.seed, (v) => this.update({ seed: v.trim() || 'terra' }), 'change');
    this.inputs.seed = seed;
    const dice = button('🎲', () => {
      seed.value = randomSeed();
      this.update({ seed: seed.value });
    });
    dice.title = 'Random seed';
    planet.append(row('Seed', seed, dice));

    this.inputs.radius = input('number', String(this.params.radiusKm), (v) => this.update({ radiusKm: clamp(+v, 500, 20000), preset: 'custom' }), 'change');
    planet.append(row('Radius km', this.inputs.radius));
    this.inputs.gravity = input('number', String(this.params.gravity), (v) => this.update({ gravity: clamp(+v, 0.05, 5), preset: 'custom' }), 'change');
    (this.inputs.gravity as HTMLInputElement).step = '0.01';
    planet.append(row('Gravity g', this.inputs.gravity));
    r.append(planet);

    // --- Tectonics ---
    const tect = section('Tectonics');
    tect.append(this.slider('plates', 'Plates', 2, 40, 1, this.params.plates, (v) => String(v), (v) => this.update({ plates: v, preset: 'custom' })));
    tect.append(this.slider('continents', 'Continents', 1, 24, 1, this.params.continents, (v) => String(v), (v) => this.update({ continents: v, preset: 'custom' })));
    tect.append(this.slider('land', 'Land', 5, 80, 1, Math.round(this.params.landFraction * 100), (v) => `${v}%`, (v) => this.update({ landFraction: v / 100, preset: 'custom' })));
    const eng = segmented([['drift', 'Full simulation'], ['snapshot', 'Sketch']], this.params.engine, (v) => {
      this.update({ engine: v as PlanetParams['engine'] });
      this.syncEngine();
    });
    this.engineSeg = eng;
    tect.append(row('Engine', eng));
    this.driftRows = [
      this.slider('myr', 'History', 50, 1500, 50, this.params.simMyr, (v) => `${v} Myr`, (v) => this.update({ simMyr: v })),
      this.slider('speed', 'Mantle vigour', 10, 100, 5, this.params.mantleSpeed, (v) => `${v} mm/yr`, (v) => this.update({ mantleSpeed: v, preset: 'custom' })),
    ];
    this.driftRows[0].title = 'How many million years of plate history to simulate. Longer = more collisions, rifts and eroded old ranges (and a longer wait).';
    this.driftRows[1].title = 'Mean plate speed the mantle drives (Earth today ≈ 40 mm/yr).';
    tect.append(...this.driftRows);
    const gridSel = select(
      GRID_OPTIONS.map((o) => [String(o.freq), o.label]),
      String(this.params.gridFreq),
      (v) => this.update({ gridFreq: +v }),
    );
    this.inputs.grid = gridSel;
    tect.append(row('Resolution', gridSel));
    tect.append(el('p', { class: 'note' }, ['Full simulation runs the plates through their history (subduction, collisions, rifting, hot spots, erosion) — about a minute per 100k cells.']));
    tect.append(button('New planet', () => {
      seed.value = randomSeed();
      this.update({ seed: seed.value });
    }, 'primary'));
    r.append(tect);

    // --- View ---
    const view = section('View');
    view.append(row('Camera', segmented([['globe', 'Globe'], ['map', 'Flat map']], this.display.view, (v) => this.setDisplay('view', v as ViewMode))));
    const modes = segmented(MAP_MODES.map((m) => [m.id, m.label]), this.display.mode, (v) => this.setDisplay('mode', v as MapMode));
    view.append(modes);
    view.append(el('div', { style: 'height:8px' }));
    view.append(check('Plate motion arrows', this.display.arrows, (v) => this.setDisplay('arrows', v)));
    view.append(check('Show hex cells', this.display.hex, (v) => this.setDisplay('hex', v)));
    view.append(this.slider('relief', 'Relief ×', 0, 60, 1, this.display.relief, (v) => String(v), (v) => this.setDisplay('relief', v)));
    r.append(view);

    // --- Stats ---
    const st = section('This planet');
    this.statsEl = el('dl', { class: 'stats' });
    st.append(this.statsEl);
    st.append(el('p', { class: 'note' }, ['Satellite colours are a latitude/elevation preview until the climate model lands.']));
    r.append(st);

    // --- Scorecard ---
    const sc = section('Scorecard');
    this.scoreSumEl = el('p', { class: 'score-sum' });
    this.scoreEl = el('div', { class: 'score' });
    sc.append(this.scoreSumEl, this.scoreEl);
    sc.append(el('p', { class: 'note' }, ['Checked against physically plausible ranges; Earth is shown for reference, not as the target. Hover a row for details.']));
    r.append(sc);

    // --- Export ---
    const ex = section('Share & export');
    ex.append(el('div', { class: 'row' }, [button('Copy link', () => this.h.onCopyLink()), button('Save view', () => this.h.onExportView()), button('Save map', () => this.h.onExportMap())]));
    r.append(ex);
  }

  private slider(key: string, label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onChange: (v: number) => void) {
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(min);
    inp.max = String(max);
    inp.step = String(step);
    inp.value = String(value);
    const out = document.createElement('output');
    out.textContent = fmt(value);
    inp.addEventListener('input', () => (out.textContent = fmt(+inp.value)));
    inp.addEventListener('change', () => onChange(+inp.value));
    // relief is purely visual → update live while dragging
    if (key === 'relief') inp.addEventListener('input', () => onChange(+inp.value));
    this.inputs[key] = inp;
    (inp as unknown as { _out: HTMLOutputElement })._out = out;
    return row(label, inp, out);
  }

  private update(patch: Partial<PlanetParams>) {
    this.params = { ...this.params, ...patch };
    if (patch.preset === 'custom') (this.inputs.preset as HTMLSelectElement).value = 'custom';
    this.h.onParams(this.params);
  }

  /** Replace all params (preset change or loading a link) and refresh inputs. */
  setParams(p: PlanetParams, notify = true) {
    this.params = p;
    const set = (k: string, v: string) => {
      const i = this.inputs[k];
      if (!i) return;
      i.value = v;
      const out = (i as unknown as { _out?: HTMLOutputElement })._out;
      if (out) out.textContent = k === 'land' ? `${v}%` : k === 'myr' ? `${v} Myr` : k === 'speed' ? `${v} mm/yr` : v;
    };
    set('preset', p.preset);
    set('seed', p.seed);
    set('radius', String(p.radiusKm));
    set('gravity', String(p.gravity));
    set('plates', String(p.plates));
    set('continents', String(p.continents));
    set('land', String(Math.round(p.landFraction * 100)));
    set('grid', String(p.gridFreq));
    set('myr', String(p.simMyr));
    set('speed', String(p.mantleSpeed));
    this.syncEngine();
    if (notify) this.h.onParams(p);
  }

  private setDisplay<K extends keyof DisplayState>(k: K, v: DisplayState[K]) {
    this.display = { ...this.display, [k]: v };
    this.h.onDisplay(this.display, k);
  }

  setStats(s: WorldStats, radiusKm: number, gravity: number) {
    const t = s.timings;
    const total = Object.values(t).reduce((a, b) => a + b, 0);
    const rows: [string, string][] = [
      ['Cells', `${s.cells.toLocaleString()} (~${Math.round(s.spacingKm)} km)`],
      ['Radius', `${radiusKm.toLocaleString()} km`],
      ['Gravity', `${gravity} g`],
      ['Land', `${(s.landFraction * 100).toFixed(1)}%`],
      ['Highest peak', `${Math.round(s.maxElevation).toLocaleString()} m`],
      ['Deepest trench', `${Math.round(-s.minElevation).toLocaleString()} m`],
      ...(s.drift
        ? ([
            ['History', `${Math.round(s.drift.time)} Myr · ${s.drift.steps.toLocaleString()} steps`],
            ['Plates now', `${s.drift.plates}`],
            ['Rifts · sutures', `${s.drift.rifts} · ${s.drift.merges}`],
            ['New subduction zones', `${s.drift.subductionStarts}`],
            ['Sea floor recycled', `${((s.drift.subductedSr / (4 * Math.PI)) * 100).toFixed(0)}% of the surface`],
          ] as [string, string][])
        : []),
      ['Generated in', `${(total / 1000).toFixed(2)} s`],
    ];
    this.statsEl.innerHTML = '';
    for (const [k, v] of rows) this.statsEl.append(el('dt', {}, [k]), el('dd', {}, [v]));
    this.statsEl.title = Object.entries(t).map(([k, v]) => `${k}: ${v} ms`).join('\n');
  }

  setScore(score: Scorecard | undefined) {
    this.scoreEl.innerHTML = '';
    if (!score) {
      this.scoreSumEl.textContent = '';
      return;
    }
    this.scoreSumEl.innerHTML = `<b class="ok">${score.pass} plausible</b> · <b class="warn">${score.warn} unusual</b> · <b class="fail">${score.fail} impossible</b>`;
    for (const m of score.metrics) {
      const row = el('div', { class: `score-row ${m.status}` }, [
        el('span', { class: 'dot' }),
        el('span', { class: 'lbl' }, [m.label]),
        el('span', { class: 'val' }, [m.display]),
      ]);
      const tip = [`Plausible: ${m.band}`, `Impossible if: ${m.failIf}`, `Earth: ${m.earth}`];
      if (m.note) tip.unshift(m.note);
      row.title = tip.join('\n');
      this.scoreEl.append(row);
    }
  }

  expectedCells(): number {
    return cellCount(this.params.gridFreq);
  }
}

// --- tiny DOM helpers --------------------------------------------------------

function el(tag: string, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

function section(title: string): HTMLElement {
  return el('div', { class: 'section' }, [el('h2', {}, [title])]);
}

function row(label: string, ...ctl: HTMLElement[]): HTMLElement {
  return el('div', { class: 'row' }, [el('label', {}, [label]), el('div', { class: 'ctl' }, ctl)]);
}

function input(type: string, value: string, onChange: (v: string) => void, evt: 'input' | 'change' = 'change'): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.value = value;
  i.addEventListener(evt, () => onChange(i.value));
  return i;
}

function select(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = document.createElement('select');
  for (const [v, l] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    s.append(o);
  }
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function segmented(options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
  const wrap = el('div', { class: 'seg' });
  for (const [v, l] of options) {
    const b = button(l, () => {
      for (const x of wrap.children) x.classList.remove('on');
      b.classList.add('on');
      onChange(v);
    });
    b.dataset.v = v;
    if (v === value) b.classList.add('on');
    wrap.append(b);
  }
  return wrap;
}

function check(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = value;
  i.addEventListener('change', () => onChange(i.checked));
  return el('label', { class: 'check' }, [i, label]);
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
