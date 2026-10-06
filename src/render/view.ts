import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ViewMode = 'globe' | 'map';

/**
 * Renders the planet from one equirectangular colour texture + one height
 * texture, either as a 3D globe (with displacement, bump lighting and an
 * atmosphere rim) or as a flat map that wraps horizontally.
 */
export class PlanetView {
  readonly renderer: THREE.WebGLRenderer;
  private globeScene = new THREE.Scene();
  private mapScene = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private colorTex?: THREE.DataTexture;
  private heightTex?: THREE.DataTexture;
  private globe: THREE.Mesh;
  private mapMeshes: THREE.Mesh[] = [];
  private atmo: THREE.Mesh;
  private starField: THREE.Points;
  /**
   * Rendering quality level. Some GPUs/drivers fail on parts of the full
   * material (vertex texture fetch, half-float bump maps), so after every
   * upload a tiny offscreen test frame checks the planet is really drawn and
   * steps down a level if not:
   *   0 lit + relief (displacement + bump)
   *   1 lit, no relief
   *   2 unlit colour only, no mipmaps
   */
  quality = 0;
  /** Called with a human-readable message when rendering degrades or fails. */
  onProblem: (msg: string) => void = (m) => console.warn(m);
  private shaderErrors: string[] = [];
  private sun = new THREE.DirectionalLight(0xffffff, 2.6);
  private mapSun = new THREE.DirectionalLight(0xffffff, 1.6);
  private globeArrows: THREE.LineSegments;
  private mapArrows: THREE.LineSegments[] = [];
  private arrowMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  private mapGroup = new THREE.Group();
  private mapZoom = 1;
  view: ViewMode = 'globe';
  private reliefExaggeration = 10;
  private radiusKm = 6371;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    container.appendChild(this.renderer.domElement);

    // --- globe ---
    this.persp = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.persp.position.set(0, 0.6, 3.6);
    this.controls = new OrbitControls(this.persp, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.15;
    this.controls.maxDistance = 8;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.controls.enablePan = false;

    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
        .filter((x) => x && x.trim())
        .join(' | ')
        .slice(0, 400);
      this.shaderErrors.push(log || 'unknown shader error');
      console.error('Shader error', log);
    };
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onProblem('The GPU reset the WebGL context. Reload the page to continue.');
    });

    this.globe = new THREE.Mesh(new THREE.SphereGeometry(1, 1024, 512), new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 }));
    this.globeScene.add(this.globe);
    this.atmo = this.atmosphere();
    this.globeScene.add(this.atmo);
    this.globeScene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1a1410, 0.6));
    this.globeScene.add(this.sun);
    this.starField = this.stars();
    this.globeScene.add(this.starField);
    this.globeScene.background = new THREE.Color(0x03050a);
    this.globeArrows = new THREE.LineSegments(new THREE.BufferGeometry(), this.arrowMat);
    this.globeArrows.visible = false;
    this.globeScene.add(this.globeArrows);

    // --- flat map: three copies side by side for seamless horizontal wrap ---
    this.ortho = new THREE.OrthographicCamera(-1, 1, 0.5, -0.5, -10, 10);
    this.ortho.position.set(0, 0, 5);
    const plane = new THREE.PlaneGeometry(2, 1);
    const mapMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    for (const dx of [-2, 0, 2]) {
      const m = new THREE.Mesh(plane, mapMat);
      m.position.x = dx;
      this.mapMeshes.push(m);
      this.mapGroup.add(m);
      const arrows = new THREE.LineSegments(new THREE.BufferGeometry(), this.arrowMat);
      arrows.position.set(dx, 0, 0.01);
      arrows.visible = false;
      this.mapArrows.push(arrows);
      this.mapGroup.add(arrows);
    }
    this.mapScene.add(this.mapGroup);
    this.mapScene.add(new THREE.AmbientLight(0xffffff, 1.1));
    this.mapSun.position.set(-1, 1, 1.6);
    this.mapScene.add(this.mapSun);
    this.mapScene.background = new THREE.Color(0x0b0f16);

    this.installMapControls();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  setView(v: ViewMode) {
    this.view = v;
    this.controls.enabled = v === 'globe';
  }

  setTextures(rgba: Uint8Array, height: Uint16Array, w: number, h: number, radiusKm: number) {
    this.radiusKm = radiusKm;
    if (!this.colorTex || this.colorTex.image.width !== w || this.colorTex.image.height !== h) {
      this.colorTex?.dispose();
      this.heightTex?.dispose();
      const ct = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      ct.colorSpace = THREE.SRGBColorSpace;
      ct.wrapS = THREE.RepeatWrapping;
      const ht = new THREE.DataTexture(height, w, h, THREE.RedFormat, THREE.HalfFloatType);
      ht.wrapS = THREE.RepeatWrapping;
      ht.minFilter = THREE.LinearFilter;
      ht.magFilter = THREE.LinearFilter;
      ht.generateMipmaps = false;
      this.colorTex = ct;
      this.heightTex = ht;
    } else {
      this.colorTex.image.data = rgba;
      this.heightTex!.image.data = height;
    }
    this.colorTex.needsUpdate = true;
    this.heightTex!.needsUpdate = true;
    this.applyQuality(this.quality);
    this.verify();
  }

  setColor(rgba: Uint8Array, height: Uint16Array) {
    if (!this.colorTex) return;
    this.colorTex.image.data = rgba;
    this.colorTex.needsUpdate = true;
    this.heightTex!.image.data = height;
    this.heightTex!.needsUpdate = true;
  }

  /** Vertical exaggeration of relief on the globe and of hill shading. */
  setRelief(exaggeration: number) {
    this.reliefExaggeration = exaggeration;
    this.applyRelief();
  }

  private applyRelief() {
    const k = this.reliefExaggeration;
    const g = this.globe.material as THREE.MeshStandardMaterial;
    const m = this.mapMeshes[0].material as THREE.MeshStandardMaterial;
    if (this.quality !== 0 || !(g instanceof THREE.MeshStandardMaterial)) return;
    // displacement in globe radii per metre of height
    g.displacementScale = k / (this.radiusKm * 1000);
    g.bumpScale = 0.00006 * k;
    m.bumpScale = 0.00004 * k;
  }

  /** Builds the globe and map materials for a quality level. */
  private applyQuality(level: number) {
    this.quality = level;
    const ct = this.colorTex!;
    const ht = this.heightTex!;
    const mips = level < 2;
    if (ct.generateMipmaps !== mips) {
      ct.generateMipmaps = mips;
      ct.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      ct.anisotropy = mips ? this.renderer.capabilities.getMaxAnisotropy() : 1;
      ct.needsUpdate = true;
    } else if (mips) {
      ct.minFilter = THREE.LinearMipmapLinearFilter;
      ct.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    }
    let globeMat: THREE.Material;
    let mapMat: THREE.Material;
    if (level === 0) {
      const gm = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, map: ct, bumpMap: ht, displacementMap: ht });
      // the relief texture carries the sea floor as negative heights (for
      // shading); only land is raised off the globe
      gm.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <displacementmap_vertex>',
          '#ifdef USE_DISPLACEMENTMAP\n\ttransformed += normalize( objectNormal ) * ( max( texture2D( displacementMap, vDisplacementMapUv ).x, 0.0 ) * displacementScale + displacementBias );\n#endif',
        );
      };
      globeMat = gm;
      mapMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, map: ct, bumpMap: ht });
    } else if (level === 1) {
      globeMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, map: ct });
      mapMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, map: ct });
    } else {
      globeMat = new THREE.MeshBasicMaterial({ map: ct });
      mapMat = new THREE.MeshBasicMaterial({ map: ct });
    }
    (this.globe.material as THREE.Material).dispose();
    this.globe.material = globeMat;
    (this.mapMeshes[0].material as THREE.Material).dispose();
    for (const m of this.mapMeshes) m.material = mapMat;
    this.applyRelief();
  }

  /**
   * Renders one 32×32 offscreen frame of each view against a magenta
   * background and checks the planet covers the centre. If it doesn't, drops
   * a quality level and tries again.
   */
  private verify() {
    const MAGENTA = new THREE.Color(1, 0, 1);
    const rt = new THREE.WebGLRenderTarget(32, 32);
    const px = new Uint8Array(4);
    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    cam.position.set(0, 0, 3.6);
    cam.lookAt(0, 0, 0);
    const probe = (scene: THREE.Scene, camera: THREE.Camera): boolean => {
      const bg = scene.background;
      scene.background = MAGENTA;
      this.atmo.visible = false;
      this.starField.visible = false;
      this.renderer.setRenderTarget(rt);
      this.renderer.render(scene, camera);
      this.renderer.readRenderTargetPixels(rt, 16, 16, 1, 1, px);
      this.renderer.setRenderTarget(null);
      scene.background = bg;
      this.atmo.visible = true;
      this.starField.visible = true;
      return !(px[0] > 240 && px[1] < 15 && px[2] > 240);
    };
    const mapCam = new THREE.OrthographicCamera(-0.2, 0.2, 0.2, -0.2, -10, 10);
    mapCam.position.set(0, 0, 5);
    const failures: string[] = [];
    let ok = false;
    for (;;) {
      this.shaderErrors = [];
      ok = probe(this.globeScene, cam) && probe(this.mapScene, mapCam);
      if (ok) break;
      failures.push(`level ${this.quality}${this.shaderErrors.length ? ` (${this.shaderErrors[0]})` : ''}`);
      if (this.quality >= 2) {
        this.onProblem(`The planet could not be drawn on this GPU. Details: ${failures.join('; ')}`);
        break;
      }
      this.applyQuality(this.quality + 1);
    }
    rt.dispose();
    if (ok && failures.length) {
      const what = this.quality === 1 ? 'relief shading is off' : 'lighting and relief are off';
      this.onProblem(`Simplified rendering on this GPU: ${what}. Details: ${failures.join('; ')}`);
    }
  }

  /** Line segments as xyz pairs on the unit sphere. */
  setArrows(segments: Float32Array | null) {
    const show = !!segments && segments.length > 0;
    this.globeArrows.visible = show;
    for (const a of this.mapArrows) a.visible = show;
    if (!segments) return;
    const g = new THREE.BufferGeometry();
    const lifted = new Float32Array(segments.length);
    for (let i = 0; i < segments.length; i++) lifted[i] = segments[i] * 1.02;
    g.setAttribute('position', new THREE.BufferAttribute(lifted, 3));
    this.globeArrows.geometry.dispose();
    this.globeArrows.geometry = g;

    // project to the map; drop segments that cross the antimeridian
    const flat: number[] = [];
    const ll = (i: number): [number, number] => {
      const x = segments[i], y = segments[i + 1], z = segments[i + 2];
      const lat = Math.asin(Math.max(-1, Math.min(1, y / Math.hypot(x, y, z))));
      let phi = Math.atan2(z, -x);
      if (phi < 0) phi += 2 * Math.PI;
      return [phi / Math.PI - 1, lat / Math.PI];
    };
    for (let i = 0; i < segments.length; i += 6) {
      const [ax, ay] = ll(i);
      const [bx, by] = ll(i + 3);
      if (Math.abs(ax - bx) > 0.5) continue;
      flat.push(ax, ay, 0, bx, by, 0);
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flat), 3));
    for (const a of this.mapArrows) {
      a.geometry.dispose();
      a.geometry = mg;
    }
  }

  /** Direction (unit vector) under the pointer, or null. */
  pick(clientX: number, clientY: number): [number, number, number] | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    if (this.view === 'globe') {
      ray.setFromCamera(ndc, this.persp);
      const hit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
      if (!hit) return null;
      hit.normalize();
      return [hit.x, hit.y, hit.z];
    }
    ray.setFromCamera(ndc, this.ortho);
    const o = ray.ray.origin;
    let u = o.x;
    const v = o.y;
    if (v < -0.5 || v > 0.5) return null;
    u = ((((u + 1) % 2) + 2) % 2) - 1; // wrap into [-1, 1)
    const lat = v * Math.PI;
    const phi = (u + 1) * Math.PI;
    return [-Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)];
  }

  /** Saves what is on screen as a PNG. */
  screenshot(): string {
    return this.renderer.domElement.toDataURL('image/png');
  }

  private frame() {
    if (this.view === 'globe') {
      this.controls.update();
      // Sun follows the camera, offset up-left, so the side you look at is lit.
      const cam = this.persp.position.clone().normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(up, cam).normalize();
      this.sun.position.copy(cam).multiplyScalar(4).addScaledVector(side, -2.2).addScaledVector(up, 1.8);
      this.renderer.render(this.globeScene, this.persp);
    } else {
      this.renderer.render(this.mapScene, this.ortho);
    }
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
  }

  private updateOrtho() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const aspect = w / Math.max(1, h);
    // At zoom 1 the whole map (2 × 1) fits the view.
    const halfH = Math.max(0.5, 1 / aspect) / this.mapZoom;
    const halfW = halfH * aspect;
    this.ortho.left = -halfW;
    this.ortho.right = halfW;
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.updateProjectionMatrix();
    this.clampMap();
  }

  private clampMap() {
    const halfH = (this.ortho.top - this.ortho.bottom) / 2;
    const maxY = Math.max(0, 0.5 - halfH);
    this.ortho.position.y = Math.max(-maxY, Math.min(maxY, this.ortho.position.y));
    this.ortho.position.x = ((((this.ortho.position.x + 1) % 2) + 2) % 2) - 1;
  }

  private installMapControls() {
    const el = this.renderer.domElement;
    let dragging = false;
    let lx = 0, ly = 0;
    el.addEventListener('pointerdown', (e) => {
      if (this.view !== 'map') return;
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || this.view !== 'map') return;
      const r = el.getBoundingClientRect();
      const sx = (this.ortho.right - this.ortho.left) / r.width;
      const sy = (this.ortho.top - this.ortho.bottom) / r.height;
      this.ortho.position.x -= (e.clientX - lx) * sx;
      this.ortho.position.y += (e.clientY - ly) * sy;
      lx = e.clientX;
      ly = e.clientY;
      this.clampMap();
    });
    el.addEventListener('pointerup', () => (dragging = false));
    el.addEventListener(
      'wheel',
      (e) => {
        if (this.view !== 'map') return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        // keep the point under the cursor fixed while zooming
        const fx = (e.clientX - r.left) / r.width - 0.5;
        const fy = 0.5 - (e.clientY - r.top) / r.height;
        const beforeX = this.ortho.position.x + fx * (this.ortho.right - this.ortho.left);
        const beforeY = this.ortho.position.y + fy * (this.ortho.top - this.ortho.bottom);
        this.mapZoom = Math.max(1, Math.min(40, this.mapZoom * Math.exp(-e.deltaY * 0.0015)));
        this.updateOrtho();
        this.ortho.position.x = beforeX - fx * (this.ortho.right - this.ortho.left);
        this.ortho.position.y = beforeY - fy * (this.ortho.top - this.ortho.bottom);
        this.clampMap();
      },
      { passive: false },
    );
  }

  private atmosphere(): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      uniforms: {},
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          // Back faces of a shell slightly larger than the planet: brightest
          // just outside the planet's silhouette, fading to nothing outward.
          float d = clamp(-dot(vNormal, vView) / 0.34, 0.0, 1.0);
          float glow = pow(d, 3.0);
          gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * glow * 0.9, glow);
        }`,
    });
    return new THREE.Mesh(new THREE.SphereGeometry(1.06, 96, 48), mat);
  }

  private stars(): THREE.Points {
    const n = 2500;
    const p = new Float32Array(3 * n);
    let s = 12345;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const z = 2 * rnd() - 1;
      const t = 2 * Math.PI * rnd();
      const r = Math.sqrt(1 - z * z);
      p[3 * i] = 40 * r * Math.cos(t);
      p[3 * i + 1] = 40 * z;
      p[3 * i + 2] = 40 * r * Math.sin(t);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899aa, size: 0.06, sizeAttenuation: true }));
  }
}
