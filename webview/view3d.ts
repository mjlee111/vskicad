// 3D viewer for KiCad GLB exports. KiCad writes glTF in meters with +Y up;
// the board lies in the XZ plane, glTF +X = KiCad X and glTF +Z = KiCad 2D Y (down).
// Look: opaque board layers with sRGB-corrected colors, key-light shadows, ground shadow,
// screen-space ambient occlusion (GTAO), lacquered soldermask, dark gradient background.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type ViewPreset = 'top' | 'bottom' | 'front' | 'iso';

/** Camera expressed as kicad-cli `pcb render` arguments. */
export interface KicadView {
  /** `--rotate x,y,z` in degrees. */
  rotate: [number, number, number];
  /** `--zoom`, relative to the fitted view. */
  zoom: number;
}

// KiCad exports translucent soldermask at alpha 0.83; anything below this is treated as mask.
const SOLDERMASK_MAX_OPACITY = 0.85;
const KEY_LIGHT_DIR = new THREE.Vector3(-0.45, 1, 0.35).normalize();
const BACKGROUND_TOP = '#4a5366';
const BACKGROUND_BOTTOM = '#15181f';

export class View3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.0001, 100);
  private readonly controls: OrbitControls;
  private readonly loader = new GLTFLoader();
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
  private readonly ground: THREE.Mesh;
  private readonly composer: EffectComposer;
  private readonly gtao: GTAOPass;
  private model: THREE.Object3D | undefined;
  private components: THREE.Object3D = new THREE.Group();
  private componentCount = 0;
  private box = new THREE.Box3();
  /** Board geometry only (no components), used to mirror kicad-cli's zoom reference. */
  private boardBox = new THREE.Box3();
  private sphere = new THREE.Sphere();
  private loadSeq = 0;
  private renderQueued = false;
  private componentsVisible = true;
  // Preset to re-fit on resize until the user moves the camera (the pane may load while hidden).
  private autoFit: ViewPreset | undefined;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The scene is static: shadow maps are re-rendered only when geometry or visibility changes.
    this.renderer.shadowMap.autoUpdate = false;
    host.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.background = gradientTexture(BACKGROUND_TOP, BACKGROUND_BOTTOM);

    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.radius = 3;
    this.fillLight.position.copy(KEY_LIGHT_DIR).multiply(new THREE.Vector3(-1, 0.4, -1));
    this.scene.add(this.keyLight, this.keyLight.target, this.fillLight);

    // Receives the board's shadow so it reads as resting above a surface.
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.18 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.scene.add(this.ground);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => (this.autoFit = undefined));
    this.renderer.domElement.addEventListener('dblclick', () => this.setView('iso'));

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, size.x, size.y);
    this.gtao.blendIntensity = 0.9;
    this.composer.addPass(this.gtao);
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  get hasModel(): boolean {
    return !!this.model;
  }

  /** Loads a GLB; keeps the camera when the board extents are unchanged (refresh). */
  async load(uri: string): Promise<void> {
    const seq = ++this.loadSeq;
    const gltf = await this.loader.loadAsync(uri);
    if (seq !== this.loadSeq) {
      disposeObject(gltf.scene);
      return;
    }
    const optimized = optimizeScene(gltf.scene);
    const prevBox = this.box.clone();
    const hadModel = !!this.model;
    if (this.model) {
      this.scene.remove(this.model);
      disposeObject(this.model);
    }
    this.model = optimized.root;
    this.components = optimized.components;
    this.boardBox = new THREE.Box3().setFromObject(optimized.board);
    this.componentCount = optimized.componentCount;
    this.scene.add(this.model);
    this.box = new THREE.Box3().setFromObject(this.model);
    this.box.getBoundingSphere(this.sphere);
    this.components.visible = this.componentsVisible;
    this.fitLightsAndGround();

    const sameExtents = hadModel && prevBox.min.distanceTo(this.box.min) < 1e-5 && prevBox.max.distanceTo(this.box.max) < 1e-5;
    if (!sameExtents) this.setView('iso');
    else this.requestRender();
  }

  setView(preset: ViewPreset): void {
    if (this.box.isEmpty()) return;
    const center = this.box.getCenter(new THREE.Vector3());
    // camera.up stays +Y so OrbitControls keeps orbiting around the board normal.
    // The tiny Z offsets fix screen orientation: top view matches the KiCad 2D view,
    // bottom view is mirrored left-right like KiCad's bottom view.
    const dir = new THREE.Vector3();
    switch (preset) {
      case 'top':
        dir.set(0, 1, 0.001);
        break;
      case 'bottom':
        dir.set(0, -1, -0.001);
        break;
      case 'front':
        dir.set(0, 0.25, 1);
        break;
      case 'iso':
        dir.set(0.55, 0.9, 1);
        break;
    }
    dir.normalize();
    this.autoFit = preset;
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(center).addScaledVector(dir, this.fitDistance(center, dir));
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }

  setComponentsVisible(visible: boolean): void {
    this.componentsVisible = visible;
    this.components.visible = visible;
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  countComponents(): number {
    return this.componentCount;
  }

  /**
   * Converts the current camera to kicad-cli `pcb render` rotation and zoom for an image of
   * the given size.
   *
   * Rotation: kicad-cli applies the board-to-view rotation R = Rx(x) * Ry(y) * Rz(z) in KiCad
   * board coordinates (x right, y up = 2D -Y, z out of the top side).
   * Zoom: kicad-cli zoom scales linearly with apparent size and does not depend on the view
   * direction. At zoom 1 the board center is drawn at about min(H / max(boardW, boardH),
   * W / boardW) pixels per mm. Both were established by comparing kicad-cli 10.0.5 renders
   * with this viewer. Panning is not transferred: kicad-cli rotates about the board center.
   */
  getKicadView(imageWidth: number, imageHeight: number): KicadView {
    const toBoard = (v: THREE.Vector3) => new THREE.Vector3(v.x, -v.z, v.y);
    const viewDir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dir = toBoard(viewDir);
    const up = toBoard(new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion));
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const trueUp = new THREE.Vector3().crossVectors(dir, right).normalize();
    // Rows of R are the view axes expressed in board coordinates.
    const r = new THREE.Matrix4().set(
      right.x, right.y, right.z, 0,
      trueUp.x, trueUp.y, trueUp.z, 0,
      dir.x, dir.y, dir.z, 0,
      0, 0, 0, 1,
    );
    const e = new THREE.Euler().setFromRotationMatrix(r, 'XYZ');
    const deg = (a: number) => Math.round(THREE.MathUtils.radToDeg(a) * 100) / 100;

    // Apparent scale of this view in output-image pixels per mm, at the board center.
    const ref = (this.boardBox.isEmpty() ? this.box : this.boardBox).getCenter(new THREE.Vector3());
    const distMm = Math.max(this.camera.position.distanceTo(ref), 1e-6) * 1000;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const ourScale = imageHeight / (2 * distMm * tanV);
    const size = (this.boardBox.isEmpty() ? this.box : this.boardBox).getSize(new THREE.Vector3()).multiplyScalar(1000);
    const boardW = Math.max(size.x, 1e-3);
    const boardH = Math.max(size.z, 1e-3);
    const kicadScaleAtZoom1 = Math.min(imageHeight / Math.max(boardW, boardH), imageWidth / boardW);
    const zoom = Math.min(Math.max(ourScale / kicadScaleAtZoom1, 0.1), 50);
    return { rotate: [deg(e.x), deg(e.y), deg(e.z)], zoom: Math.round(zoom * 100) / 100 };
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.updateClipPlanes();
      // The ground plane would hide the board when looking from below.
      this.ground.visible = !!this.model && this.camera.position.y > this.box.min.y;
      this.composer.render();
    });
  }

  /**
   * Distance at which the board box fits the viewport for a view direction,
   * computed from the box corners in camera space (tighter than a bounding sphere).
   */
  private fitDistance(center: THREE.Vector3, dir: THREE.Vector3): number {
    if (this.box.isEmpty()) return 1;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tanH = tanV * this.camera.aspect;
    const probe = new THREE.PerspectiveCamera();
    probe.position.copy(center).add(dir);
    probe.lookAt(center);
    probe.updateMatrixWorld(true);
    const toCamera = probe.matrixWorldInverse.clone().setPosition(0, 0, 0);
    let dist = 0;
    const { min, max } = this.box;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).sub(center);
      p.applyMatrix4(toCamera); // camera space, looking down -Z
      dist = Math.max(dist, p.z + Math.abs(p.x) / tanH, p.z + Math.abs(p.y) / tanV);
    }
    return Math.max(dist, 1e-4) * 1.08;
  }

  /**
   * Keeps the near plane as far out as possible. Silkscreen sits ~0.03 mm above the
   * soldermask, which a fixed near plane cannot resolve in the depth buffer.
   */
  private updateClipPlanes(): void {
    const r = Math.max(this.sphere.radius, 1e-4);
    const d = this.camera.position.distanceTo(this.sphere.center);
    this.camera.near = Math.max((d - r) * 0.8, d * 0.01, 1e-6);
    this.camera.far = d + r * 3;
    this.camera.updateProjectionMatrix();
  }

  private fitLightsAndGround(): void {
    const center = this.box.getCenter(new THREE.Vector3());
    const r = Math.max(this.sphere.radius, 1e-4);
    this.keyLight.target.position.copy(center);
    this.keyLight.position.copy(center).addScaledVector(KEY_LIGHT_DIR, r * 3);
    const cam = this.keyLight.shadow.camera;
    cam.left = -r * 1.6;
    cam.right = r * 1.6;
    cam.top = r * 1.6;
    cam.bottom = -r * 1.6;
    cam.near = r * 0.5;
    cam.far = r * 6;
    cam.updateProjectionMatrix();
    // Biases in world units (meters), scaled to the board size.
    this.keyLight.shadow.bias = -r * 0.0002;
    this.keyLight.shadow.normalBias = r * 0.002;
    this.ground.scale.setScalar(r * 8);
    this.ground.position.set(center.x, this.box.min.y - r * 0.15, center.z);
    this.gtao.updateGtaoMaterial({ radius: r * 0.05, thickness: r * 0.05, distanceFallOff: 1, scale: 1.2, samples: 16 });
    this.gtao.setSceneClipBox(this.box.clone().expandByScalar(r * 0.05));
    this.renderer.shadowMap.needsUpdate = true;
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.autoFit && this.model) this.setView(this.autoFit);
    else this.requestRender();
  }
}

function gradientTexture(top: string, bottom: string): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Components are glTF nodes named by reference designator (e.g. "C104"); board geometry
 * nodes are named "=>[...]". The original glTF name is in userData.name, because
 * three.js assigns generated names such as "mesh_0" to unnamed meshes.
 */
function findComponentRoots(root: THREE.Object3D): Set<THREE.Object3D> {
  const found = new Set<THREE.Object3D>();
  root.traverse((o) => {
    const gltfName = o.userData.name as string | undefined;
    if (o === root || !gltfName || gltfName.startsWith('=>')) return;
    // Keep only the outermost named node per component; nested parts belong to it.
    for (let p = o.parent; p && p !== root; p = p.parent) if (found.has(p)) return;
    found.add(o);
  });
  return found;
}

/**
 * KiCad GLB exports keep every STEP face as its own primitive (tens of thousands of draw
 * calls on real boards). The scene is static, so meshes are baked into world space and
 * merged per material, separately for board and components (for the visibility toggle).
 */
function optimizeScene(scene: THREE.Object3D): {
  root: THREE.Group;
  board: THREE.Group;
  components: THREE.Group;
  componentCount: number;
} {
  scene.updateMatrixWorld(true);
  const componentRoots = findComponentRoots(scene);
  const boardBuckets = new Map<THREE.Material, THREE.Mesh[]>();
  const compBuckets = new Map<THREE.Material, THREE.Mesh[]>();

  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    let inComponent = false;
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) {
      if (componentRoots.has(p)) {
        inComponent = true;
        break;
      }
    }
    const buckets = inComponent ? compBuckets : boardBuckets;
    const list = buckets.get(mesh.material) ?? [];
    list.push(mesh);
    buckets.set(mesh.material, list);
  });

  const root = new THREE.Group();
  const board = new THREE.Group();
  const components = new THREE.Group();
  for (const [material, meshes] of boardBuckets) board.add(mergeMeshes(meshes, prepareBoardMaterial(material)));
  for (const [material, meshes] of compBuckets) components.add(mergeMeshes(meshes, prepareComponentMaterial(material)));
  for (const group of [board, components]) {
    for (const m of group.children) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  }
  root.add(board, components);

  // Release source geometry; materials were replaced or reused by the merged meshes.
  scene.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  return { root, board, components, componentCount: componentRoots.size };
}

/**
 * Board layers (substrate, copper, soldermask, silkscreen) are rendered opaque, like
 * KiCad's own renderer: blending them only lets the far side bleed through.
 * KiCad writes these colors as sRGB values into baseColorFactor, which glTF defines as
 * linear, so they are converted here; without it the board looks washed out.
 */
function prepareBoardMaterial(source: THREE.Material): THREE.Material {
  const std = source as THREE.MeshStandardMaterial;
  const wasMask = source.transparent && source.opacity < SOLDERMASK_MAX_OPACITY;
  if (std.color) std.color.convertSRGBToLinear();
  if (!wasMask) {
    source.transparent = false;
    source.opacity = 1;
    source.depthWrite = true;
    return source;
  }
  // Soldermask: lacquered finish via clearcoat.
  const mask = new THREE.MeshPhysicalMaterial({
    color: std.color,
    roughness: std.roughness,
    metalness: std.metalness,
    side: std.side,
    clearcoat: 0.6,
    clearcoatRoughness: 0.3,
  });
  source.dispose();
  return mask;
}

function prepareComponentMaterial(source: THREE.Material): THREE.Material {
  // Merged meshes share one sort position, so translucent parts must not occlude via depth.
  if (source.transparent) source.depthWrite = false;
  return source;
}

const _normalMatrix = new THREE.Matrix3();
const _v = new THREE.Vector3();

/**
 * Bakes meshes into one geometry. The result is re-centered on its bounding box so
 * three.js can depth-sort translucent objects (sorting uses object positions).
 */
function mergeMeshes(meshes: THREE.Mesh[], material: THREE.Material): THREE.Mesh {
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position');
    vertexCount += pos.count;
    indexCount += m.geometry.index ? m.geometry.index.count : pos.count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const bounds = new THREE.Box3();
  let vOff = 0;
  let iOff = 0;
  for (const m of meshes) {
    const g = m.geometry;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    _normalMatrix.getNormalMatrix(m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      const o = (vOff + i) * 3;
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      bounds.expandByPoint(_v);
      positions[o] = _v.x;
      positions[o + 1] = _v.y;
      positions[o + 2] = _v.z;
      _v.fromBufferAttribute(nor, i).applyMatrix3(_normalMatrix).normalize();
      normals[o] = _v.x;
      normals[o + 1] = _v.y;
      normals[o + 2] = _v.z;
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices[iOff + i] = g.index.getX(i) + vOff;
      iOff += g.index.count;
    } else {
      for (let i = 0; i < pos.count; i++) indices[iOff + i] = vOff + i;
      iOff += pos.count;
    }
    vOff += pos.count;
  }
  const center = bounds.getCenter(new THREE.Vector3());
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] -= center.x;
    positions[i * 3 + 1] -= center.y;
    positions[i * 3 + 2] -= center.z;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, material);
  mesh.position.copy(center);
  return mesh;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}
