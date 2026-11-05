/**
 * 装箱计算。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView } from "../prototype-api";
import { type Shipment } from "./models";
import { qs } from "./shared";
import { api, toast } from "./ui";

// ===== 装箱计算 (Container Load Calculator) =====
let clScene: any = null;
let clThree: any = null;
const CL_DRAW_CAP = 3000;

// 产品库带入尺寸：缓存 + 选择器
let clProducts: any[] = [];
let clProductsLoaded = false;
let clSinglePid = "";
// 从发货单带入的装柜预设（打开装箱计算时消费）
interface ClShipmentPreset { name: string; rows: { name: string; lCm: number; wCm: number; hCm: number; unitW: number; shape: string; qtyTarget: number }[]; }
let clShipmentPreset: ClShipmentPreset | null = null;

function clProductOptionsHtml(selId?: string): string {
  const opts = clProducts.map((p) => {
    const dim = p.packLength && p.packWidth && p.packHeight ? ` ${p.packLength}×${p.packWidth}×${p.packHeight}cm` : "";
    const w = p.packWeight != null ? ` / ${p.packWeight}kg` : "";
    const label = `${(p.nameZh || p.nameEn || "未命名")}${dim}${w}`.slice(0, 64);
    return `<option value="${p.id}"${p.id === selId ? " selected" : ""}>${label}</option>`;
  }).join("");
  return `<option value="">从产品库选择…</option>` + opts;
}

async function clEnsureProducts(force = false): Promise<void> {
  if (clProductsLoaded && !force) return;
  try {
    const data = await api<{ products: any[] }>("/api/tools/products");
    clProducts = (data.products || []).filter(
      (p) => p.packLength || p.packWidth || p.packHeight || p.packWeight != null
    );
    clProductsLoaded = true;
    clRefreshProductPickers();
  } catch (e) {
    // 产品库不可用时仍允许手动输入，不阻断装柜计算
  }
}

function clRefreshProductPickers() {
  const sp = qs<HTMLSelectElement>("#clProductPick");
  if (sp) sp.innerHTML = clProductOptionsHtml(clSinglePid);
  document.querySelectorAll(".cl-m-pick").forEach((sel) => {
    const s = sel as HTMLSelectElement;
    s.innerHTML = clProductOptionsHtml(s.dataset.pid || "");
  });
}

function clApplyProductToSingle(p: any) {
  if (!p) return;
  const setVal = (id: string, v: string) => {
    const el = qs<HTMLInputElement>("#" + id);
    if (el) {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  if (p.packLength) setVal("clL", String(p.packLength));
  if (p.packWidth) setVal("clW", String(p.packWidth));
  if (p.packHeight) setVal("clH", String(p.packHeight));
  if (p.packWeight != null) setVal("clUnitW", String(p.packWeight));
}

function clApplyProductToRow(row: HTMLElement, p: any) {
  if (!p) return;
  const set = (sel: string, v: string) => {
    const el = row.querySelector(sel) as HTMLInputElement;
    if (el) {
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  if (p.packLength) set(".cl-m-l", String(p.packLength));
  if (p.packWidth) set(".cl-m-w", String(p.packWidth));
  if (p.packHeight) set(".cl-m-h", String(p.packHeight));
  if (p.packWeight != null) set(".cl-m-wt", String(p.packWeight));
  if (p.nameZh) set(".cl-m-name", p.nameZh);
}

interface ClContainer { id: string; name: string; L: number; W: number; H: number; payloadKg: number; }
const CL_CONTAINERS: ClContainer[] = [
  { id: "20gp", name: "20尺普柜 20GP", L: 5.90, W: 2.35, H: 2.39, payloadKg: 28200 },
  { id: "40gp", name: "40尺普柜 40GP", L: 12.03, W: 2.35, H: 2.39, payloadKg: 26600 },
  { id: "40hc", name: "40尺高柜 40HC/HQ", L: 12.03, W: 2.35, H: 2.70, payloadKg: 26500 },
  { id: "45hc", name: "45尺高柜 45HC", L: 13.56, W: 2.35, H: 2.70, payloadKg: 27800 }
];

function clCompute(c: ClContainer, g: { l: number; w: number; h: number }, allowRot: boolean, shape: "box" | "drum" | "bag" = "box") {
  let best: any;
  if (shape === "drum") {
    // 圆桶：直径取长/宽较大者，按 d×d×h 网格码放；圆柱旋转对称，忽略 allowRot
    const d = Math.max(g.l, g.w);
    const oh = g.h;
    const nx = Math.floor(c.L / d), ny = Math.floor(c.W / d), nz = Math.floor(c.H / oh);
    const count = nx * ny * nz;
    best = { count, ol: d, ow: d, oh, nx, ny, nz, d, isCyl: true };
  } else {
    const dims = [g.l, g.w, g.h];
    const perms = allowRot
      ? [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
      : [[0, 1, 2]];
    best = { count: 0, ol: 0, ow: 0, oh: 0, nx: 0, ny: 0, nz: 0 };
    for (const p of perms) {
      const ol = dims[p[0]], ow = dims[p[1]], oh = dims[p[2]];
      if (!(ol > 0 && ow > 0 && oh > 0)) continue;
      const nx = Math.floor(c.L / ol), ny = Math.floor(c.W / ow), nz = Math.floor(c.H / oh);
      const count = nx * ny * nz;
      if (count > best.count) best = { count, ol, ow, oh, nx, ny, nz };
    }
  }
  const goodVol = best.ol * best.ow * best.oh;
  const contVol = c.L * c.W * c.H;
  const util = contVol > 0 ? (best.count * goodVol) / contVol : 0;
  // 货物整齐码放时（从一角起始）的货块尺寸与重心（相对集装箱中心，单位 m）
  const bx = best.nx * best.ol, by = best.nz * best.oh, bz = best.ny * best.ow;
  const cgx = -c.L / 2 + bx / 2;   // 前后（箱长方向）重心偏移
  const cgy = -c.H / 2 + by / 2;   // 上下（箱高方向）重心高度
  const cgz = -c.W / 2 + bz / 2;   // 左右（箱宽方向）重心偏移
  // 形状实际填充系数（估算：含货物间隙、加固、不规则形态的必然空隙）
  const fillFactor: Record<string, number> = { box: 0.90, drum: 0.70, bag: 0.64 };
  const ff = fillFactor[shape] || 0.85;
  const actualUtil = util * ff;
  // 边角余隙（米）
  const gapL = c.L - bx, gapW = c.W - bz, gapH = c.H - by;
  return { ...best, goodVol, contVol, util, bx, by, bz, cgx, cgy, cgz, shape, isCyl: !!best.isCyl, d: best.d, actualUtil, fillFactor: ff, gapL, gapW, gapH };
}

async function clEnsureThree() {
  if (clThree) return clThree;
  const THREE = await import("three");
  const mod = await import("three/addons/controls/OrbitControls.js");
  clThree = { THREE, OrbitControls: mod.OrbitControls };
  return clThree;
}

// 装箱 3D 配色：黑白红高级色感。多 SKU 各取一色（白/灰/炭/红系），
// 单品用「白→暖灰」竖向渐变；箱体边线统一近黑描边，集装箱外框用朱红锚定主题。
const CL_BOX_PALETTE = [
  0xf2efe9, // 象牙白
  0xc23a32, // 朱红
  0xd6d0c8, // 浅暖灰
  0x2c2f36, // 炭黑
  0xe2a7a0, // 柔红
  0x9c968d, // 中灰
  0x9e2b25, // 深红
  0xb7b1a6  // 灰褐
];

// 由每个货块的变换矩阵与面颜色，构建「合并后的逐箱体边线」。
// 边线颜色 = 面色加深（×0.34），在 colored 面上形成清晰锐利、互不粘连的描边，
// 配合各块之间 0.02m 的间隙，使相邻小箱体边界一眼可辨。
function clMakeBoxEdges(
  geo: any,
  matrices: any[],
  colors: any[]
): any {
  const { THREE } = clThree;
  const edgeSrc = new THREE.EdgesGeometry(geo, 1);
  const posAttr = edgeSrc.attributes.position;
  const positions: number[] = [];
  const colorArr: number[] = [];
  const ec = new THREE.Color();
  const tmp = new THREE.Vector3();
  const EDGE_DARK = new THREE.Color(0x14161a);
  for (let i = 0; i < matrices.length; i++) {
    ec.copy(colors[i]).lerp(EDGE_DARK, 0.72);
    const m = matrices[i];
    for (let v = 0; v < posAttr.count; v++) {
      tmp.set(posAttr.getX(v), posAttr.getY(v), posAttr.getZ(v)).applyMatrix4(m);
      positions.push(tmp.x, tmp.y, tmp.z);
      colorArr.push(ec.r, ec.g, ec.b);
    }
  }
  edgeSrc.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colorArr, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.96 });
  const seg = new THREE.LineSegments(g, mat);
  seg.frustumCulled = false;
  return seg;
}

function clClear3D() {
  if (!clScene) return;
  for (const m of clScene.containerMeshes) {
    clScene.scene.remove(m);
    m.geometry?.dispose?.();
    m.material?.dispose?.();
  }
  clScene.containerMeshes = [];
  if (clScene.instanced) {
    clScene.scene.remove(clScene.instanced);
    clScene.instanced.geometry?.dispose?.();
    clScene.instanced.material?.dispose?.();
    clScene.instanced = null;
  }
}

function clInitScene(wrap: HTMLElement) {
  const { THREE, OrbitControls } = clThree;
  const w = wrap.clientWidth || 800, h = wrap.clientHeight || 460;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  wrap.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.4;
  // 黑白红主题下的精致打光：低环境光保留塑形 + 半球光做柔和过渡 + 主光塑形 + 背后轮廓光
  scene.add(new THREE.AmbientLight(0xffffff, 0.32));
  const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 0.55);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(1, 1.5, 1);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.32);
  dir2.position.set(-1, 0.6, -0.8);
  scene.add(dir2);
  clScene = { renderer, scene, camera, controls, wrap, raf: 0, ro: null, instanced: null, containerMeshes: [], dims: { L: 1, W: 1, H: 1 }, framed: false };
  const animate = () => {
    clScene.raf = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();
  const ro = new ResizeObserver(() => {
    const nw = wrap.clientWidth, nh = wrap.clientHeight;
    if (nw > 0 && nh > 0) {
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }
  });
  ro.observe(wrap);
  clScene.ro = ro;
}

function clResetView() {
  if (!clScene) return;
  const { L, W, H } = clScene.dims;
  const maxD = Math.max(L, W, H);
  clScene.camera.position.set(L * 0.55 + 1.5, H * 0.95 + maxD * 0.15, W * 1.3 + L * 0.35 + 2.5);
  clScene.controls.target.set(0, 0, 0);
  clScene.controls.update();
}

function clBuild3D(c: ClContainer, r: any) {
  if (!clScene) return;
  const { THREE } = clThree;
  clClear3D();
  const L = c.L, W = c.W, H = c.H;
  clScene.dims = { L, W, H };
  const boxGeo = new THREE.BoxGeometry(L, H, W);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color: 0xc23a32 }));
  const faces = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0xe9e4dd, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false }));
  clScene.scene.add(edges);
  clScene.scene.add(faces);
  clScene.containerMeshes = [edges, faces];
  const total = r.count;
  const drawn = Math.min(total, CL_DRAW_CAP);
  if (drawn > 0) {
    const gap = r.isCyl ? 0 : 0.02;
    const geo = r.isCyl
      ? new THREE.CylinderGeometry(r.d / 2 * 0.98, r.d / 2 * 0.98, Math.max(r.oh - gap, 0.01), 20)
      : new THREE.BoxGeometry(Math.max(r.ol - gap, 0.01), Math.max(r.oh - gap, 0.01), Math.max(r.ow - gap, 0.01));
    const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.5, metalness: 0.0, clearcoat: 0.28, clearcoatRoughness: 0.45 });
    const inst = new THREE.InstancedMesh(geo, mat, drawn);
    inst.frustumCulled = false;
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const matrices: any[] = [];
    const colors: any[] = [];
    let idx = 0;
    for (let ix = 0; ix < r.nx; ix++) {
      for (let iy = 0; iy < r.ny; iy++) {
        for (let iz = 0; iz < r.nz; iz++) {
          if (idx >= drawn) break;
          const stepX = r.isCyl ? r.d : r.ol;
          const stepZ = r.isCyl ? r.d : r.ow;
          const x = -L / 2 + stepX / 2 + ix * stepX;
          const z = -W / 2 + stepZ / 2 + iy * stepZ;
          const y = -H / 2 + r.oh / 2 + iz * r.oh;
          dummy.position.set(x, y, z);
          dummy.updateMatrix();
          inst.setMatrixAt(idx, dummy.matrix);
          matrices.push(dummy.matrix.clone());
          const t = (r.nz > 1) ? (iz / (r.nz - 1)) : 0;
          col.set(0xf2efe9).lerp(new THREE.Color(0xc9c3ba), t);
          colors.push(col.clone());
          inst.setColorAt(idx, col);
          idx++;
        }
      }
    }
    inst.count = idx;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    clScene.scene.add(inst);
    clScene.instanced = inst;
    // 逐箱体边线：色深于面，描边清晰、各块互不粘连
    if (matrices.length) {
      const edges = clMakeBoxEdges(geo, matrices, colors);
      clScene.scene.add(edges);
      clScene.containerMeshes.push(edges);
    }
  }
  // 货物重心标记（赤铜球，位于货块几何中心）
  if (total > 0) {
    const cgR = Math.max(Math.min(L, W, H) * 0.02, 0.06);
    const cgGeo = new THREE.SphereGeometry(cgR, 18, 18);
    const cgMat = new THREE.MeshStandardMaterial({ color: 0xc23a32, emissive: 0xc23a32, emissiveIntensity: 0.5, roughness: 0.45, metalness: 0.05 });
    const cgMesh = new THREE.Mesh(cgGeo, cgMat);
    cgMesh.position.set(r.cgx, r.cgy, r.cgz);
    clScene.scene.add(cgMesh);
    clScene.containerMeshes.push(cgMesh);
  }
  if (!clScene.framed) {
    clResetView();
    clScene.framed = true;
  }
}

// ===== 多 SKU 混合装载 =====
interface MultiItem { name?: string; shape: string; lCm: number; wCm: number; hCm: number; unitW: number; qtyTarget?: number; }
interface MultiSkuResult { item: MultiItem; r: any; actualQty: number; maxN: number; }
interface MultiResult { items: MultiSkuResult[]; totalCount: number; totalWeight: number; totalVolUtil: number; weightUtil: number; safeMargin: boolean; }

function clMulticompute(c: ClContainer, items: MultiItem[]): MultiResult {
  const contVol = c.L * c.W * c.H;
  const safeVol = contVol * 0.92;
  const computed = items.map(item => {
    const r = clCompute(c, { l: item.lCm / 100, w: item.wCm / 100, h: item.hCm / 100 }, true, (item.shape || "box") as "box" | "drum" | "bag");
    return { item, r, maxN: r.count };
  });
  let usedVol = 0, usedW = 0;
  const results: MultiSkuResult[] = computed.map(({ item, r, maxN }) => {
    let actualQty = 0;
    if (item.qtyTarget && item.qtyTarget > 0) {
      actualQty = Math.min(item.qtyTarget, maxN);
      usedVol += actualQty * r.goodVol;
      usedW += actualQty * item.unitW;
    }
    return { item, r, actualQty, maxN };
  });
  const autoItems = results.filter(x => x.actualQty === 0);
  if (autoItems.length > 0 && usedVol < safeVol) {
    const remVol = Math.max(safeVol - usedVol, 0);
    const totalAutoMaxVol = autoItems.reduce((s, x) => s + x.maxN * x.r.goodVol, 0);
    for (const ai of autoItems) {
      const share = totalAutoMaxVol > 0 ? (ai.maxN * ai.r.goodVol) / totalAutoMaxVol : 1 / autoItems.length;
      let extra = Math.floor((remVol * share) / ai.r.goodVol);
      extra = Math.min(extra, ai.maxN);
      ai.actualQty = extra;
      usedVol += extra * ai.r.goodVol;
      usedW += extra * ai.item.unitW;
    }
  }
  if (usedW > c.payloadKg) {
    const ratio = c.payloadKg / usedW;
    for (const ri of results) {
      if (!ri.item.qtyTarget || ri.item.qtyTarget <= 0) ri.actualQty = Math.floor(ri.actualQty * ratio);
    }
    usedW = results.reduce((s, r) => s + r.actualQty * r.item.unitW, 0);
    usedVol = results.reduce((s, r) => s + r.actualQty * r.r.goodVol, 0);
  }
  const totalCount = results.reduce((s, r) => s + r.actualQty, 0);
  const totalWeight = usedW;
  const totalVolUtil = contVol > 0 ? usedVol / contVol : 0;
  const weightUtil = c.payloadKg > 0 ? totalWeight / c.payloadKg : 0;
  return { items: results, totalCount, totalWeight, totalVolUtil, weightUtil, safeMargin: totalWeight <= c.payloadKg && usedVol <= contVol };
}

function clBuild3DMulti(c: ClContainer, multiRes: MultiResult) {
  if (!clScene) return;
  const { THREE } = clThree;
  clClear3D();
  const L = c.L, W = c.W, H = c.H;
  clScene.dims = { L, W, H };
  const boxGeo = new THREE.BoxGeometry(L, H, W);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color: 0xc23a32 }));
  const faces = new THREE.Mesh(boxGeo, new THREE.MeshStandardMaterial({ color: 0xe9e4dd, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false }));
  clScene.scene.add(edges); clScene.scene.add(faces);
  clScene.containerMeshes = [edges, faces];
  const totalVol = multiRes.items.reduce((s, it) => s + it.actualQty * it.r.goodVol, 0);
  if (totalVol <= 0 || L <= 0) { clResetView(); clScene.framed = true; return; }
  let xOffset = -L / 2;
  const dummy = new THREE.Object3D(), col = new THREE.Color();
  for (let idx = 0; idx < multiRes.items.length; idx++) {
    const it = multiRes.items[idx];
    if (it.actualQty <= 0) continue;
    const r = it.r, drawn = Math.min(it.actualQty, CL_DRAW_CAP);
    const segL = L * (it.actualQty * r.goodVol) / totalVol;
    const gap = r.isCyl ? 0 : 0.02;
    const geo = r.isCyl
      ? new THREE.CylinderGeometry(r.d / 2 * 0.98, r.d / 2 * 0.98, Math.max(r.oh - gap, 0.01), 20)
      : new THREE.BoxGeometry(Math.max(r.ol - gap, 0.01), Math.max(r.oh - gap, 0.01), Math.max(r.ow - gap, 0.01));
    const baseColor = new THREE.Color(CL_BOX_PALETTE[idx % CL_BOX_PALETTE.length]);
    const mat = new THREE.MeshPhysicalMaterial({ roughness: 0.5, metalness: 0.0, clearcoat: 0.28, clearcoatRoughness: 0.45 });
    const inst = new THREE.InstancedMesh(geo, mat, drawn);
    inst.frustumCulled = false;
    const stepX = r.isCyl ? r.d : r.ol, stepZ = r.isCyl ? r.d : r.ow;
    const matrices: any[] = [];
    const colors: any[] = [];
    let iIdx = 0;
    for (let ix = 0; ix < r.nx; ix++) {
      const x = xOffset + stepX / 2 + ix * stepX;
      if (x + stepX / 2 > xOffset + segL + 0.001) break;
      for (let iy = 0; iy < r.ny; iy++) {
        for (let iz = 0; iz < r.nz; iz++) {
          if (iIdx >= drawn) break;
          const z = -W / 2 + stepZ / 2 + iy * stepZ, y = -H / 2 + r.oh / 2 + iz * r.oh;
          dummy.position.set(x, y, z); dummy.updateMatrix();
          inst.setMatrixAt(iIdx, dummy.matrix);
          matrices.push(dummy.matrix.clone());
          col.copy(baseColor);
          if (r.nz > 1) col.offsetHSL(0, 0, -(iz / (r.nz - 1)) * 0.06);
          colors.push(col.clone());
          inst.setColorAt(iIdx, col); iIdx++;
        }
      }
    }
    inst.count = iIdx; inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    clScene.scene.add(inst); clScene.containerMeshes.push(inst);
    // 逐箱体边线
    if (matrices.length) {
      const edges = clMakeBoxEdges(geo, matrices, colors);
      clScene.scene.add(edges);
      clScene.containerMeshes.push(edges);
    }
    xOffset += segL;
  }
  if (!clScene.framed) { clResetView(); clScene.framed = true; }
}

function renderMultiCompute(c: ClContainer) {
  const rowsEl = qs<HTMLElement>("#clMultiRows"); if (!rowsEl) return;
  const rowEls = rowsEl.querySelectorAll(".cl-multi-row");
  const items: MultiItem[] = [];
  rowEls.forEach(row => {
    const shape = (row.querySelector(".cl-m-shape") as HTMLSelectElement)?.value || "box";
    const l = parseFloat((row.querySelector(".cl-m-l") as HTMLInputElement)?.value || "0");
    const w = parseFloat((row.querySelector(".cl-m-w") as HTMLInputElement)?.value || "0");
    const h = parseFloat((row.querySelector(".cl-m-h") as HTMLInputElement)?.value || "0");
    const wt = parseFloat((row.querySelector(".cl-m-wt") as HTMLInputElement)?.value || "0");
    const name = (row.querySelector(".cl-m-name") as HTMLInputElement)?.value?.trim() || "";
    const qtyRaw = (row.querySelector(".cl-m-qty") as HTMLInputElement)?.value;
    const qty = qtyRaw ? parseFloat(qtyRaw) : undefined;
    if (l > 0 && w > 0 && h > 0) items.push({ name, shape, lCm: l, wCm: w, hCm: h, unitW: wt, qtyTarget: qty });
  });
  const resEl = qs<HTMLElement>("#clMultiResult"); if (!resEl) return;
  if (items.length === 0) { resEl.innerHTML = `<div class="cl-layout"><span class="cl-tag">提示</span>请添加至少一种货物（填写长×宽×高）。</div>`; clClear3D(); return; }
  const res = clMulticompute(c, items);
  let html = `<div style="display:flex;gap:16px;margin-bottom:14px;flex-wrap:wrap;">
    <div><b style="font-size:24px;color:var(--brand)">${res.totalCount}</b><span style="font-size:12px;color:var(--muted)">件 · 总计</span></div>
    <div><b style="font-size:18px">${(res.totalWeight / 1000).toFixed(2)} t</b><span style="font-size:11px;color:var(--muted)">总重</span></div>
    <div><b style="font-size:18px">${(res.totalVolUtil * 100).toFixed(1)}%</b><span style="font-size:11px;color:var(--muted)">体积利用率</span></div>
    <div><b style="font-size:18px">${(res.weightUtil * 100).toFixed(1)}%</b><span style="font-size:11px;color:var(--muted)">载重利用率</span></div>
  </div><table class="cl-sku-table">
  <thead><tr><th>货物</th><th>形状</th><th>尺寸(cm)</th><th>单件重(kg)</th><th>件数</th><th>小计重(t)</th></tr></thead><tbody>`;
  for (const it of res.items) {
    if (it.actualQty === 0) continue;
    const sn = it.item.shape === "drum" ? "圆桶" : it.item.shape === "bag" ? "袋装" : "长方体";
    html += `<tr><td>${it.item.name || "—"}</td><td>${sn}</td><td>${it.item.lCm}×${it.item.wCm}×${it.item.hCm}</td><td>${it.item.unitW}</td><td><b>${it.actualQty}</b></td><td>${(it.actualQty * it.item.unitW / 1000).toFixed(2)}</td></tr>`;
  }
  html += `<tr class="cl-sku-total"><td colspan="4"><b>合计</b></td><td><b>${res.totalCount}</b></td><td><b>${(res.totalWeight / 1000).toFixed(2)}</b></td></tr></tbody></table>`;
  if (!res.safeMargin) html += `<div style="margin-top:10px;padding:10px;border-radius:10px;background:#fdf2ef;border:1px solid #e8806e;color:#c0392b;font-size:12.5px;">⚠ 总重 ${(res.totalWeight / 1000).toFixed(2)}t 已超过限重 ${(c.payloadKg / 1000).toFixed(1)}t，请减少数量或换更大柜型。</div>`;
  html += `<div class="cl-note" style="margin-top:10px;">* 混合装载采用启发式估算（体积比分配剩余空间），实际以现场装柜为准。建议对称分区码放以降低偏载风险。</div>`;
  resEl.innerHTML = html;
  clBuild3DMulti(c, res);
}

function addMultiRow(idx: number, preset?: Partial<MultiItem>) {
  const container = qs<HTMLElement>("#clMultiRows"); if (!container) return;
  const row = document.createElement("div"); row.className = "cl-multi-row"; row.dataset.index = String(idx);
  row.innerHTML = `<button class="cl-rm-row" type="button">×</button><div class="cl-multi-fields">
    <div class="cl-field"><label>名称</label><input type="text" placeholder="可选" class="cl-m-name" value="${preset?.name || ""}"></div>
    <div class="cl-field cl-field-grow"><label>从产品库</label><select class="cl-m-pick" data-pid="">${clProductOptionsHtml()}</select></div>
    <div class="cl-field"><label>形状</label><select class="cl-m-shape"><option value="box"${preset?.shape === "box" ? " selected" : ""}>长方体</option><option value="drum"${preset?.shape === "drum" ? " selected" : ""}>圆桶</option><option value="bag"${preset?.shape === "bag" ? " selected" : ""}>袋装</option></select></div>
    <div class="cl-field"><label>长(cm)</label><input type="number" min="1" step="1" value="${preset?.lCm || 60}" class="cl-m-l"></div>
    <div class="cl-field"><label>宽(cm)</label><input type="number" min="1" step="1" value="${preset?.wCm || 40}" class="cl-m-w"></div>
    <div class="cl-field"><label>高(cm)</label><input type="number" min="1" step="1" value="${preset?.hCm || 30}" class="cl-m-h"></div>
    <div class="cl-field"><label>重(kg)</label><input type="number" min="0" step="0.5" value="${preset?.unitW || 25}" class="cl-m-wt"></div>
    <div class="cl-field"><label>数量</label><input type="number" min="0" step="1" placeholder="尽量多" class="cl-m-qty" value="${preset?.qtyTarget ? preset.qtyTarget : ""}"></div>
  </div>`;
  container.appendChild(row);
  row.querySelectorAll("input,select").forEach(inp => inp.addEventListener("input", () => clComputeAndRender()));
  row.querySelector(".cl-m-pick")?.addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    row.dataset.pid = sel.value;
    const p = clProducts.find((x) => x.id === sel.value);
    clApplyProductToRow(row, p);
    clComputeAndRender();
  });
  row.querySelector(".cl-rm-row")?.addEventListener("click", () => { row.remove(); clComputeAndRender(); });
}

function clComputeAndRender() {
  const root = qs<HTMLElement>("#container-load");
  if (!root) return;
  const sel = qs<HTMLSelectElement>("#clContainer");
  const c = CL_CONTAINERS.find((x) => x.id === sel?.value) || CL_CONTAINERS[2];
  const mode = (document.querySelector('input[name="clMode"]:checked') as HTMLInputElement)?.value || "single";
  if (mode === "multi") { renderMultiCompute(c); return; }
  const lCm = parseFloat(qs<HTMLInputElement>("#clL")?.value || "0") / 100;
  const wCm = parseFloat(qs<HTMLInputElement>("#clW")?.value || "0") / 100;
  const hCm = parseFloat(qs<HTMLInputElement>("#clH")?.value || "0") / 100;
  const allowRot = !!qs<HTMLInputElement>("#clRot")?.checked;
  const shape = (qs<HTMLSelectElement>("#clShape")?.value || "box") as "box" | "drum" | "bag";
  const unitW = parseFloat(qs<HTMLInputElement>("#clUnitW")?.value || "0");
  const hint = qs<HTMLElement>("#clPresetHint");
  if (hint) hint.innerHTML = `内部净尺寸 <b>${c.L.toFixed(2)} × ${c.W.toFixed(2)} × ${c.H.toFixed(2)} m</b> · 容积 <b>${(c.L * c.W * c.H).toFixed(1)} m³</b> · 最大载货重 <b>${(c.payloadKg / 1000).toFixed(1)} t</b>`;
  const set = (id: string, v: string) => { const el = qs<HTMLElement>("#" + id); if (el) el.textContent = v; };
  const resetW = () => {
    set("clTotalW", "—"); set("clWeightPct", "—");
    const wb = qs<HTMLElement>("#clWeightBlock"); wb?.classList.remove("is-over", "is-ok");
    qs<HTMLElement>("#clWeightBar")?.style.setProperty("width", "0%");
    const b = qs<HTMLElement>("#clWeightBadge"); if (b) { b.className = "cl-badge is-idle"; b.textContent = "未输入单件重量"; }
  };
  const resetB = () => {
    set("clCgLong", "—"); set("clCgLat", "—"); set("clCgHeight", "—"); set("clCgHeightPct", "—");
    const bb = qs<HTMLElement>("#clBalanceBadge"); if (bb) { bb.className = "cl-badge is-idle"; bb.textContent = "—"; }
    set("clBalanceDetail", "请输入货物尺寸以评估配重。");
  };
  const resetA = () => {
    set("clActualUtil", "—"); set("clActualTheo", "—"); set("clGapTop", "—"); set("clGapLen", "—"); set("clGapWid", "—");
    const ab = qs<HTMLElement>("#clActualBlock"); ab?.classList.remove("is-ok", "is-warn");
    qs<HTMLElement>("#clActualBar")?.style.setProperty("width", "0%");
    const ab2 = qs<HTMLElement>("#clActualBadge"); if (ab2) { ab2.className = "cl-badge is-idle"; ab2.textContent = "—"; }
    set("clActualDetail", "请输入货物尺寸以评估实际可用利用率。");
  };
  if (!(lCm > 0 && wCm > 0 && hCm > 0)) {
    set("clCount", "0");
    set("clUtil", "0%");
    set("clOrient", "—");
    set("clContVol", (c.L * c.W * c.H).toFixed(1) + " m³");
    const layout = qs<HTMLElement>("#clLayout");
    if (layout) layout.innerHTML = `<span class="cl-tag">提示</span>请输入大于 0 的货物尺寸（厘米）。`;
    resetW(); resetB(); resetA();
    clClear3D();
    return;
  }
  const r = clCompute(c, { l: lCm, w: wCm, h: hCm }, allowRot, shape);
  set("clCount", String(r.count));
  set("clUtil", (r.util * 100).toFixed(1) + "%");
  set("clOrient", `${Math.round(r.ol * 100)}×${Math.round(r.ow * 100)}×${Math.round(r.oh * 100)}cm`);
  set("clContVol", r.contVol.toFixed(1) + " m³");
  // 实际可用利用率（形状修正 + 边角余隙 + 摆放建议）
  const shapeName = r.shape === "drum" ? "圆桶/圆柱" : r.shape === "bag" ? "袋装/不规则" : "长方体";
  const aWarn = r.actualUtil < 0.55;
  const ab = qs<HTMLElement>("#clActualBlock");
  ab?.classList.toggle("is-warn", aWarn);
  ab?.classList.toggle("is-ok", !aWarn);
  set("clActualUtil", (r.actualUtil * 100).toFixed(1) + "%");
  set("clActualTheo", (r.util * 100).toFixed(1) + "%");
  set("clGapTop", (r.gapH * 100).toFixed(0) + " cm");
  set("clGapLen", (r.gapL * 100).toFixed(0) + " cm");
  set("clGapWid", (r.gapW * 100).toFixed(0) + " cm");
  qs<HTMLElement>("#clActualBar")?.style.setProperty("width", Math.min(r.actualUtil, 1) * 100 + "%");
  const ab2 = qs<HTMLElement>("#clActualBadge");
  if (ab2) { ab2.className = "cl-badge " + (aWarn ? "is-warn" : "is-ok"); ab2.textContent = shapeName; }
  const tips: string[] = [];
  const gTop = r.gapH * 100, gLen = r.gapL * 100, gWid = r.gapW * 100;
  if (gTop > 8) tips.push(`顶部留 ${gTop.toFixed(0)}cm 空隙，可叠放一层扁平货物或填充缓冲材料`);
  else if (gTop > 2) tips.push(`顶部余 ${gTop.toFixed(0)}cm，码放较紧凑`);
  if (gLen > 8 || gWid > 8) tips.push(`边角余 ${gLen.toFixed(0)}×${gWid.toFixed(0)}cm，建议错位堆码（半件错位）利用边角空隙`);
  tips.push(`「${shapeName}」实际填充系数约 ${(r.fillFactor * 100).toFixed(0)}%，已计入货物间隙、加固与不规则形态必然空隙`);
  set("clActualDetail", tips.join("；") + "。");
  const layout = qs<HTMLElement>("#clLayout");
  if (layout) {
    layout.innerHTML =
      `<span class="cl-tag">推荐堆放</span>按 <b>${Math.round(r.ol * 100)}×${Math.round(r.ow * 100)}×${Math.round(r.oh * 100)} cm</b> 方向整齐码放：` +
      `沿箱长排 <b>${r.nx}</b> 件 · 沿箱宽排 <b>${r.ny}</b> 列 · 沿箱高堆 <b>${r.nz}</b> 层，共计 <b>${r.count}</b> 件。` +
      (r.count > CL_DRAW_CAP ? `<br><span style="color:var(--muted)">（3D 示意显示前 ${CL_DRAW_CAP} 件，实际依此规律排布）</span>` : ``);
  }
  // 重量校验（集装箱限重）
  if (unitW > 0) {
    const totalW = r.count * unitW;
    const weightUtil = totalW / c.payloadKg;
    const over = totalW > c.payloadKg;
    const wb = qs<HTMLElement>("#clWeightBlock");
    wb?.classList.toggle("is-over", over);
    wb?.classList.toggle("is-ok", !over);
    set("clTotalW", (totalW / 1000).toFixed(2) + " t");
    set("clWeightPct", (weightUtil * 100).toFixed(1) + "%");
    qs<HTMLElement>("#clWeightBar")?.style.setProperty("width", Math.min(weightUtil, 1) * 100 + "%");
    const b = qs<HTMLElement>("#clWeightBadge");
    if (b) {
      if (over) { b.className = "cl-badge is-over"; b.textContent = `超重 +${((totalW - c.payloadKg) / 1000).toFixed(2)} t`; }
      else { b.className = "cl-badge is-ok"; b.textContent = "未超限重"; }
    }
  } else { resetW(); }
  // 配重校验（重心 / 偏载）
  const offLong = c.L > 0 ? Math.abs(r.cgx) / (c.L / 2) : 0; // 前后偏载比例 0..1
  const offLat = c.W > 0 ? Math.abs(r.cgz) / (c.W / 2) : 0;  // 左右偏载比例 0..1
  const cgH = c.H > 0 ? r.cgy / (c.H / 2) : 0;               // 重心高度比例 -1..1
  set("clCgLong", (offLong * 100).toFixed(0) + "%");
  set("clCgLat", (offLat * 100).toFixed(0) + "%");
  set("clCgHeight", (Math.abs(r.cgy) < 0.005 ? 0 : r.cgy).toFixed(2) + " m");
  set("clCgHeightPct", (cgH * 100).toFixed(0) + "%");
  const bb = qs<HTMLElement>("#clBalanceBadge");
  const warns: string[] = [];
  let severe = false, mild = false;
  if (offLong > 0.45) { severe = true; warns.push(`前后偏载明显（重心偏离箱长中心 ${(offLong * 100).toFixed(0)}%），建议沿箱长方向居中摆放或加配重`); }
  else if (offLong > 0.20) { mild = true; warns.push(`前后略有偏载（重心偏离箱长中心 ${(offLong * 100).toFixed(0)}%），建议沿箱长方向居中`); }
  if (offLat > 0.45) { severe = true; warns.push(`左右偏载明显（重心偏离箱宽中心 ${(offLat * 100).toFixed(0)}%），建议对称码放`); }
  else if (offLat > 0.20) { mild = true; warns.push(`左右略有偏载（重心偏离箱宽中心 ${(offLat * 100).toFixed(0)}%），建议沿箱宽对称`); }
  if (cgH > 0.45) { severe = true; warns.push(`重心偏高（位于箱高 ${(cgH * 100).toFixed(0)}% 处），运输与堆叠稳定性下降，建议压低重心`); }
  let balClass = "is-ok", balText = "均衡";
  if (severe) { balClass = "is-over"; balText = "偏载风险"; }
  else if (mild || warns.length > 0) { balClass = "is-warn"; balText = "需注意"; }
  if (bb) { bb.className = "cl-badge " + balClass; bb.textContent = balText; }
  set("clBalanceDetail", warns.length
    ? warns.join("；") + "。"
    : "货物重心位于集装箱中心附近，偏载风险低。实际装柜将货块在箱长、箱宽方向居中，可进一步将偏载降至接近 0。");
  clBuild3D(c, r);
}

export function disposeContainerLoad() {
  if (!clScene) return;
  cancelAnimationFrame(clScene.raf);
  clScene.ro?.disconnect?.();
  clScene.controls?.dispose?.();
  clClear3D();
  clScene.renderer?.dispose?.();
  clScene.renderer?.domElement?.remove?.();
  clScene = null;
}

// 从发货单一键装入货物清单到装箱计算（多SKU混装）
export async function openContainerLoadForShipment(s: Shipment) {
  await clEnsureProducts();
  const rows = (s.items || []).map((it: any) => {
    const name = it.productName || "货物";
    const p = clProducts.find((x: any) => x.nameZh === name || x.name === name);
    const lCm = p?.packLength || 50;
    const wCm = p?.packWidth || 40;
    const hCm = p?.packHeight || 30;
    const unitW = p?.packWeight || (Number(it.grossWeight) || 10);
    const qtyTarget = Number(it.quantity) || 0;
    return { name, lCm, wCm, hCm, unitW, shape: "box", qtyTarget };
  }).filter((r: any) => r.lCm > 0);
  clShipmentPreset = { name: s.shipmentNo || "发货单", rows };
  activateNavView("container-load");
  toast(`已载入发货单 ${s.shipmentNo || ""} 的货物清单到装箱计算`, "success");
}

export function renderContainerLoad() {
  if (clScene) disposeContainerLoad();
  const root = qs<HTMLElement>("#container-load");
  if (!root) return;
  const opts = CL_CONTAINERS.map((c) => `<option value="${c.id}"${c.id === "40hc" ? " selected" : ""}>${c.name}</option>`).join("");
  root.innerHTML = `
    <div class="cl-wrap">
      <div class="view-head">
        <div class="view-head-text"><h2>装箱计算</h2></div>
        <p class="view-sub">选择集装箱、输入货物尺寸与单件重量，自动估算最大装载量，校验集装箱限重与配重（重心偏载），并生成可拖拽旋转的 3D 堆放演示。</p>
      </div>
      <div class="cl-mode-row" style="margin-bottom:16px;display:flex;gap:20px;align-items:center;font-size:14px;">
        <span style="font-weight:700;color:var(--ink)">装载模式：</span>
        <label class="cl-check"><input type="radio" name="clMode" value="single" checked> 单品装柜（一种货物）</label>
        <label class="cl-check"><input type="radio" name="clMode" value="multi"> 多 SKU 混装（多种货物）</label>
      </div>
      <div id="clSinglePanel">
      <div class="cl-grid">
        <section class="cl-inputs">
          <h3 class="cl-h">① 选择集装箱</h3>
          <div class="cl-field"><label>集装箱类型</label><select id="clContainer" class="cl-select">${opts}</select></div>
          <div class="cl-presets" id="clPresetHint"></div>
          <div class="cl-field cl-field-grow" style="margin-bottom:4px">
            <label>从产品库带入（自动填尺寸 + 单件重量）</label>
            <select id="clProductPick" class="cl-select">${clProductOptionsHtml()}</select>
          </div>
          <h3 class="cl-h">② 货物尺寸（厘米）</h3>
          <div class="cl-row">
            <div class="cl-field"><label>长</label><input id="clL" type="number" min="1" step="1" value="60"></div>
            <div class="cl-field"><label>宽</label><input id="clW" type="number" min="1" step="1" value="40"></div>
            <div class="cl-field"><label>高</label><input id="clH" type="number" min="1" step="1" value="30"></div>
          </div>
          <label class="cl-check"><input id="clRot" type="checkbox" checked> 允许货物旋转（6 种朝向择优）</label>
          <div class="cl-field cl-field-grow" style="margin-top:12px">
            <label>货物形状</label>
            <select id="clShape" class="cl-select">
              <option value="box" selected>长方体（纸箱/木箱/托盘）</option>
              <option value="drum">圆桶（圆柱/油桶/化工桶）</option>
              <option value="bag">袋装（编织袋/软包/不规则）</option>
            </select>
          </div>
          <h3 class="cl-h">③ 货物重量（千克）</h3>
          <div class="cl-row">
            <div class="cl-field cl-field-grow"><label>单件重量</label><input id="clUnitW" type="number" min="0" step="0.5" value="25"><span class="cl-suffix">kg / 件</span></div>
          </div>
        </section>
        <section class="cl-result">
          <div class="cl-big"><span id="clCount">0</span><small>件 · 最大装载量（理论）</small></div>
          <div class="cl-metrics">
            <div><b id="clUtil">0%</b><span>体积利用率</span></div>
            <div><b id="clOrient">—</b><span>推荐码放方向</span></div>
            <div><b id="clContVol">—</b><span>集装箱容积</span></div>
          </div>

          <div class="cl-check-block" id="clActualBlock">
            <div class="cl-check-head"><span class="cl-check-title">④ 实际可用利用率 · 形状修正</span><span class="cl-badge is-idle" id="clActualBadge">—</span></div>
            <div class="cl-check-row">
              <div class="cl-check-kv"><span>实际利用率</span><b id="clActualUtil">—</b></div>
              <div class="cl-check-kv"><span>理论利用率</span><b id="clActualTheo">—</b></div>
            </div>
            <div class="cl-bar"><i id="clActualBar" style="width:0%"></i></div>
            <div class="cl-balance-grid">
              <div class="cl-check-kv"><span>顶部余隙</span><b id="clGapTop">—</b></div>
              <div class="cl-check-kv"><span>箱长余隙</span><b id="clGapLen">—</b></div>
              <div class="cl-check-kv"><span>箱宽余隙</span><b id="clGapWid">—</b></div>
            </div>
            <div class="cl-balance-detail" id="clActualDetail">请输入货物尺寸以评估实际可用利用率。</div>
          </div>

          <div class="cl-check-block" id="clWeightBlock">
            <div class="cl-check-head"><span class="cl-check-title">⑤ 重量校验 · 集装箱限重</span><span class="cl-badge is-idle" id="clWeightBadge">未输入单件重量</span></div>
            <div class="cl-check-row">
              <div class="cl-check-kv"><span>货物总重</span><b id="clTotalW">—</b></div>
              <div class="cl-check-kv"><span>限重利用率</span><b id="clWeightPct">—</b></div>
            </div>
            <div class="cl-bar"><i id="clWeightBar" style="width:0%"></i></div>
          </div>

          <div class="cl-check-block" id="clBalanceBlock">
            <div class="cl-check-head"><span class="cl-check-title">⑥ 配重校验 · 重心偏载</span><span class="cl-badge is-idle" id="clBalanceBadge">—</span></div>
            <div class="cl-balance-grid">
              <div class="cl-check-kv"><span>前后偏移</span><b id="clCgLong">—</b></div>
              <div class="cl-check-kv"><span>左右偏移</span><b id="clCgLat">—</b></div>
              <div class="cl-check-kv"><span>重心高度</span><b id="clCgHeight">—</b></div>
            </div>
            <div class="cl-balance-detail" id="clBalanceDetail">请输入货物尺寸以评估配重。</div>
          </div>

          <div class="cl-layout" id="clLayout"></div>
          <div class="cl-note">* 理论最大值按同向整齐码放估算，实际装柜需留约 10–15% 安全余量（间隙、加固、不规则形状）。重量以「单件重量×件数」核对集装箱最大载货重；配重按贴角码放估算重心，实际居中摆放可显著降低偏载。</div>
        </section>
      </div>
      </div>
      <div id="clMultiPanel" style="display:none">
        <section class="cl-inputs">
          <h3 class="cl-h">多 SKU 货物清单</h3>
          <div id="clMultiRows"></div>
          <div style="margin-top:10px;display:flex;gap:10px;align-items:center;">
            <button class="btn btn-ghost" id="clAddRow" type="button">＋ 添加货物</button>
            <span style="font-size:12px;color:var(--muted)">每种货物独立设置尺寸、形状与目标数量（留空=尽量多装）</span>
          </div>
        </section>
        <section class="cl-result" id="clMultiResult">
          <!-- 混合结果由 JS 渲染 -->
        </section>
      </div>
      <section class="cl-stage-card">
        <div class="cl-stage-head">
          <h3 class="cl-h">⑦ 3D 堆放演示</h3>
          <div class="cl-stage-tools">
            <label class="cl-check"><input id="clAuto" type="checkbox"> 自动旋转</label>
            <button class="btn btn-ghost" id="clExport" type="button">导出装载方案</button>
            <button class="btn btn-ghost" id="clReset" type="button">复位视角</button>
          </div>
        </div>
        <div class="cl-canvas" id="clCanvas"></div>
        <div class="cl-stage-hint">左键拖拽旋转 · 滚轮缩放 · 右键平移 · <span class="cl-cg-dot"></span>赤铜球 = 货物重心</div>
      </section>
    </div>`;
  const recompute = () => clComputeAndRender();
  ["clContainer", "clL", "clW", "clH", "clUnitW"].forEach((id) => qs<HTMLElement>("#" + id)?.addEventListener("input", recompute));
  qs<HTMLElement>("#clRot")?.addEventListener("change", recompute);
  qs<HTMLElement>("#clShape")?.addEventListener("change", recompute);
  qs<HTMLElement>("#clProductPick")?.addEventListener("change", (e) => {
    const id = (e.target as HTMLSelectElement).value;
    clSinglePid = id;
    const p = clProducts.find((x) => x.id === id);
    clApplyProductToSingle(p);
    clComputeAndRender();
  });
  qs<HTMLElement>("#clReset")?.addEventListener("click", () => clResetView());
  qs<HTMLElement>("#clExport")?.addEventListener("click", () => exportContainerLoad());
  qs<HTMLInputElement>("#clAuto")?.addEventListener("change", (e) => {
    if (clScene) clScene.controls.autoRotate = (e.target as HTMLInputElement).checked;
  });
  // 装载模式切换
  document.querySelectorAll('input[name="clMode"]').forEach(el => el.addEventListener("change", () => {
    const sp = qs<HTMLElement>("#clSinglePanel"), mp = qs<HTMLElement>("#clMultiPanel");
    if (sp && mp) { sp.style.display = (el as HTMLInputElement).value === "single" ? "" : "none"; mp.style.display = (el as HTMLInputElement).value === "multi" ? "" : "none"; }
    clComputeAndRender();
  }));
  // 多 SKU 行管理
  qs<HTMLElement>("#clAddRow")?.addEventListener("click", () => {
    const container = qs<HTMLElement>("#clMultiRows");
    addMultiRow(container ? container.children.length : 0);
    clComputeAndRender();
  });
  // 初始化：优先消费发货单预设，否则放两条示例货物
  if (clShipmentPreset && clShipmentPreset.rows.length) {
    const mr = document.querySelector('input[name="clMode"][value="multi"]') as HTMLInputElement | null;
    if (mr) { mr.checked = true; mr.dispatchEvent(new Event("change", { bubbles: true })); }
    const cont = qs<HTMLElement>("#clMultiRows");
    if (cont) cont.innerHTML = "";
    clShipmentPreset.rows.forEach((r, i) => addMultiRow(i, { name: r.name, lCm: r.lCm, wCm: r.wCm, hCm: r.hCm, unitW: r.unitW, shape: r.shape, qtyTarget: r.qtyTarget }));
    clShipmentPreset = null;
  } else {
    addMultiRow(0, { name: "蓝牙音箱", lCm: 80, wCm: 60, hCm: 50, unitW: 12.5, shape: "box" });
    addMultiRow(1, { name: "太阳能路灯", lCm: 120, wCm: 100, hCm: 40, unitW: 42, shape: "box" });
  }
  // 拉取产品库（带包装尺寸），自动填充选择器
  void clEnsureProducts();
  clComputeAndRender();
  const wrap = qs<HTMLElement>("#clCanvas");
  if (wrap) {
    clEnsureThree().then(() => {
      if (!qs<HTMLElement>("#clCanvas")) return;
      clInitScene(wrap);
      clComputeAndRender();
    }).catch((err) => console.error("three load failed", err));
  }
}

// 导出 / 打印装载方案：汇总当前计算结果为一份可分享的装柜方案
function exportContainerLoad() {
  const g = (id: string) => qs<HTMLElement>("#" + id);
  const txt = (id: string) => g(id)?.textContent?.trim() || "—";
  const val = (id: string) => ((g(id) as HTMLInputElement | HTMLSelectElement)?.value || "").trim() || "—";
  const mode = (document.querySelector('input[name="clMode"]:checked') as HTMLInputElement)?.value || "single";
  const c = CL_CONTAINERS.find((x) => x.id === (g("clContainer") as HTMLSelectElement)?.value) || CL_CONTAINERS[2];
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const user = (window as any).state?.user?.name || (window as any).state?.user?.email || "操作员";

  let cargoHtml = "";
  let sectionTitle = "";
  if (mode === "single") {
    sectionTitle = "单品装柜方案";
    const shapeName = (g("clShape") as HTMLSelectElement)?.value === "drum" ? "圆桶" : (g("clShape") as HTMLSelectElement)?.value === "bag" ? "袋装" : "长方体";
    const pName = clSinglePid ? (clProducts.find((x) => x.id === clSinglePid)?.nameZh || "自定义货物") : "自定义货物";
    cargoHtml = `
      <table class="xp-tbl">
        <tr><th>货物名称</th><td>${escHtml(pName)}</td><th>货物形状</th><td>${shapeName}</td></tr>
        <tr><th>单件尺寸</th><td>${val("clL")} × ${val("clW")} × ${val("clH")} cm</td><th>单件重量</th><td>${val("clUnitW")} kg</td></tr>
        <tr><th>最大装载量</th><td><b>${txt("clCount")}</b> 件</td><th>推荐码放</th><td>${txt("clOrient")}</td></tr>
        <tr><th>体积利用率</th><td>${txt("clUtil")}</td><th>集装箱容积</th><td>${txt("clContVol")}</td></tr>
        <tr><th>实际可用利用率</th><td>${txt("clActualUtil")} <span class="xm">（理论 ${txt("clActualTheo")}）</span></td><th>状态</th><td>${badgeText("clActualBadge")}</td></tr>
        <tr><th>顶部 / 长 / 宽 余隙</th><td colspan="3">${txt("clGapTop")} / ${txt("clGapLen")} / ${txt("clGapWid")}</td></tr>
      </table>`;
  } else {
    sectionTitle = "多 SKU 混装方案";
    const rows = [...document.querySelectorAll("#clMultiRows .cl-multi-row")].map((row) => {
      const q = (s: string) => (row.querySelector(s) as HTMLInputElement)?.value || "—";
      const shape = (row.querySelector(".cl-m-shape") as HTMLSelectElement)?.value;
      const shapeName = shape === "drum" ? "圆桶" : shape === "bag" ? "袋装" : "长方体";
      const name = q(".cl-m-name") || "未命名";
      return `<tr><td>${escHtml(name)}</td><td>${shapeName}</td><td>${q(".cl-m-l")}×${q(".cl-m-w")}×${q(".cl-m-h")} cm</td><td>${q(".cl-m-wt")} kg</td></tr>`;
    }).join("");
    const summary = g("clMultiResult")?.innerHTML || "";
    cargoHtml = `
      <table class="xp-tbl">
        <tr><th style="width:22%">货物</th><th style="width:14%">形状</th><th style="width:34%">单件尺寸</th><th style="width:18%">单件重</th></tr>
        ${rows}
      </table>
      <div class="xp-summary">${summary}</div>`;
  }

  // 3D 缩略图
  let snap = "";
  try {
    const cv = clScene?.renderer?.domElement as HTMLCanvasElement | undefined;
    if (cv && cv.toDataURL) {
      const url = cv.toDataURL("image/png");
      if (url && url.length > 200) snap = `<div class="xp-3d"><img src="${url}" alt="3D 堆放演示"></div>`;
    }
  } catch (_) { /* ignore */ }

  const doc = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>装箱计算装载方案</title>
  <style>
    *{box-sizing:border-box} body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#16223b;margin:0;padding:32px;background:#fff}
    .xp-head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #cf8a1c;padding-bottom:14px;margin-bottom:20px}
    .xp-title{font-size:24px;font-weight:800;margin:0} .xp-sub{font-size:13px;color:#5b6678;margin-top:6px}
    .xp-meta{font-size:12px;color:#5b6678;text-align:right;line-height:1.7}
    .xp-h{font-size:15px;font-weight:700;margin:22px 0 10px;color:#16223b;border-left:4px solid #1f6f6b;padding-left:8px}
    .xp-tbl{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:6px}
    .xp-tbl th,.xp-tbl td{border:1px solid #e4e0d6;padding:8px 10px;text-align:left;vertical-align:top}
    .xp-tbl th{background:#f7f4ed;font-weight:600;width:18%;white-space:nowrap}
    .xp-tbl b{color:#1f6f6b;font-size:15px}
    .xm{color:#8a96a6;font-size:12px}
    .xp-summary{font-size:13px;background:#f7f4ed;border:1px solid #e4e0d6;border-radius:8px;padding:12px;margin-top:10px}
    .xp-badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#dcf3e6;color:#0f7a4f}
    .xp-badge.warn{background:#fbe0d8;color:#c0392b}
    .xp-3d{margin-top:16px} .xp-3d img{width:100%;max-width:720px;border:1px solid #e4e0d6;border-radius:8px}
    .xp-foot{margin-top:24px;border-top:1px dashed #cfc7b6;padding-top:10px;font-size:11px;color:#8a96a6}
    @media print{body{padding:16px}.xp-foot{position:fixed;bottom:8px;width:100%}}
  </style></head><body>
    <div class="xp-head">
      <div><h1 class="xp-title">装箱计算 · 装载方案</h1><div class="xp-sub">${sectionTitle} · 生成于 ${stamp}</div></div>
      <div class="xp-meta">集装箱：${escHtml(c.name)}<br>净尺寸：${c.L.toFixed(2)}×${c.W.toFixed(2)}×${c.H.toFixed(2)} m<br>最大载货重：${(c.payloadKg / 1000).toFixed(1)} t<br>制单人：${escHtml(user)}</div>
    </div>
    <div class="xp-h">货物与装载量</div>
    ${cargoHtml}
    <div class="xp-h">校验摘要</div>
    <table class="xp-tbl">
      <tr><th>重量校验 · 限重</th><td>${txt("clTotalW")} / 限重利用率 ${txt("clWeightPct")} <span class="xp-badge ${weightWarn()}">${badgeText("clWeightBadge")}</span></td></tr>
      <tr><th>配重校验 · 偏载</th><td>前后偏移 ${txt("clCgLong")} · 左右偏移 ${txt("clCgLat")} · 重心高度 ${txt("clCgHeight")} <span class="xp-badge ${balanceWarn()}">${badgeText("clBalanceBadge")}</span></td></tr>
    </table>
    ${snap}
    <div class="xp-foot">本方案由 GoodJob CRM 装箱计算模块生成，理论最大值按同向整齐码放估算，实际装柜请预留 10–15% 安全余量（间隙、加固、不规则形状）。重量以「单件重量×件数」核对集装箱最大载货重；配重按贴角码放估算重心。</div>
  </body></html>`;

  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) { toast("导出被浏览器拦截，请允许弹出窗口后重试", "error"); return; }
  w.document.open(); w.document.write(doc); w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (_) {} }, 500);
}

function badgeText(id: string) {
  const t = qs<HTMLElement>("#" + id)?.textContent?.trim();
  return t ? escHtml(t) : "—";
}
function weightWarn() { return (qs<HTMLElement>("#clWeightBadge")?.className || "").includes("is-over") ? "warn" : ""; }
function balanceWarn() { return (qs<HTMLElement>("#clBalanceBadge")?.className || "").includes("is-warn") ? "warn" : ""; }
function escHtml(s: string) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m] as string)); }

export interface EmailReturnFlowLog {
  id: string;
  messageId: string;
  entityType: string;
  entityId: string;
  entityName?: string;
  to: string;
  subject: string;
  source: string;
  sentAt: string;
  openCount: number;
  clickCount: number;
  firstOpenedAt?: string;
  lastOpenedAt?: string;
  lastClickedAt?: string;
  lastClickedUrl?: string;
  repliedAt?: string;
  bouncedAt?: string;
  createdAt: string;
}

export interface EmailReturnFlowTouchpoint {
  id: string;
  messageId?: string;
  eventType?: string;
  direction?: string;
  channel?: string;
  occurredAt?: string;
  subject?: string;
  content?: string;
  replyClassification?: string;
}

export const EMAIL_RETURN_EVENT_META: Record<string, { label: string; cls: string; icon: string }> = {
  send: { label: "发送", cls: "neutral", icon: "➤" },
  open: { label: "打开信号", cls: "green", icon: "👁" },
  click: { label: "点击信号", cls: "aqua", icon: "🔗" },
  reply: { label: "回复", cls: "green", icon: "↩" },
  bounce: { label: "退信", cls: "red", icon: "⚠" }
};

export function emailReturnFlowStatusBadges(log: EmailReturnFlowLog): string {
  const parts: string[] = [];
  if (log.bouncedAt) parts.push(`<span class="rf-pill rf-pill--bounce">退信</span>`);
  if (log.repliedAt) parts.push(`<span class="rf-pill rf-pill--reply">已回复</span>`);
  if (log.openCount > 0) parts.push(`<span class="rf-pill rf-pill--open" title="邮件客户端可能代为加载图片，仅作为追踪信号">打开信号 ${log.openCount}</span>`);
  if (log.clickCount > 0) parts.push(`<span class="rf-pill rf-pill--click" title="邮件安全扫描器可能访问链接，仅作为追踪信号">点击信号 ${log.clickCount}</span>`);
  if (!parts.length) parts.push(`<span class="rf-pill rf-pill--sent">已发送</span>`);
  return parts.join(" ");
}
