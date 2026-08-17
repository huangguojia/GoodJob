// @ts-nocheck
// 3D 单证星球：客户=恒星，单据=轨道卫星。基于 three 的沉浸式可视化。
// 无 @types/three，故整文件跳过类型检查（Vite/esbuild 运行时不查类型）。
import * as THREE from "three";

export interface PlanetCustomer {
  id: string;
  company: string;
  country?: string;
}

export interface PlanetDocument {
  id: string;
  customerId: string;
  type: string;
  title: string;
  number: string;
  status: string;
}

export interface PlanetMountOptions {
  customers: PlanetCustomer[];
  documents: PlanetDocument[];
  onSelectCustomer?: (customerId: string) => void;
  onSelectDocument?: (documentId: string) => void;
}

const PALETTE = [0x1D9E75, 0xD85A30, 0xBA7517, 0x185FA5, 0x534AB7, 0x993556, 0x0F6E56, 0x854F0B];

function injectStyles() {
  if (document.getElementById("planet-styles")) return;
  const style = document.createElement("style");
  style.id = "planet-styles";
  style.textContent = `
.planet-view { position: absolute; inset: 0; z-index: 5; background: #0C1A3A; overflow: hidden; }
.planet-view[hidden] { display: none !important; }
.planet-canvas-wrap { position: absolute; inset: 0; }
.planet-canvas-wrap canvas { display: block; width: 100%; height: 100%; }
.planet-close-button {
  position: absolute; top: 16px; left: 16px; z-index: 25;
  min-height: 36px; padding: 0 13px; border: 1px solid rgba(255,255,255,.22);
  border-radius: 8px; color: #fff; background: rgba(10,24,54,.76);
  box-shadow: 0 5px 18px rgba(0,0,0,.2); cursor: pointer; font-size: 12px; font-weight: 700;
  backdrop-filter: blur(8px); transition: border-color .15s, background .15s, transform .15s;
}
.planet-close-button:hover { border-color: rgba(255,255,255,.5); background: rgba(20,43,87,.92); }
.planet-close-button:active { transform: translateY(1px); }
.planet-close-button:focus-visible { outline: 2px solid #8de1cd; outline-offset: 2px; }
.planet-tooltip {
  position: fixed; pointer-events: none; z-index: 30;
  background: #ffffff; color: #2C2C2A; border: 0.5px solid #e3e3e3;
  border-radius: 10px; padding: 8px 12px; font-size: 12px; line-height: 1.5;
  box-shadow: 0 4px 16px rgba(12,26,58,0.25); max-width: 240px;
}
.planet-tooltip b { color: #534AB7; }
.planet-tooltip .pt-sub { color: #6b7280; }
.planet-sidepanel {
  position: absolute; top: 16px; right: 16px; bottom: 16px; width: 280px; z-index: 20;
  background: #ffffff; border: 0.5px solid #e3e3e3; border-radius: 14px;
  padding: 16px; overflow-y: auto; box-shadow: 0 6px 24px rgba(12,26,58,0.3);
}
.planet-sidepanel .ps-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.planet-sidepanel .ps-company { font-size: 15px; font-weight: 500; color: #2C2C2A; }
.planet-sidepanel .ps-country { font-size: 12px; color: #6b7280; margin-bottom: 12px; }
.planet-sidepanel .ps-close { border: none; background: #f1f3f7; border-radius: 8px; width: 26px; height: 26px; cursor: pointer; color: #6b7280; font-size: 14px; }
.planet-sidepanel .ps-doc {
  display: block; width: 100%; text-align: left; border: 0.5px solid #e3e3e3;
  border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; background: #fbfcfe;
  cursor: pointer; transition: border-color .15s, background .15s;
}
.planet-sidepanel .ps-doc:hover { border-color: #534AB7; background: #f5f3ff; }
.planet-sidepanel .ps-doc b { display: block; font-size: 13px; color: #2C2C2A; font-weight: 500; }
.planet-sidepanel .ps-doc span { font-size: 11px; color: #6b7280; }
.planet-sidepanel .ps-empty { font-size: 12px; color: #9aa0a6; padding: 8px 0; }
.planet-legend {
  position: absolute; left: 16px; bottom: 16px; z-index: 20;
  background: rgba(20,38,79,0.78); color: #EAF0FF; border-radius: 12px; padding: 10px 14px;
}
.planet-legend-title { display: block; font-size: 13px; font-weight: 500; }
.planet-legend-hint { display: block; font-size: 11px; color: #9FB0D6; margin-top: 2px; }
`;
  document.head.appendChild(style);
}

function makeLabelTexture(text: string, colorHex: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "600 46px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#" + colorHex.toString(16).padStart(6, "0");
  ctx.fillText(text, 16, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

export function mountPlanet(planetView: HTMLElement, opts: PlanetMountOptions) {
  injectStyles();

  const canvasWrap = planetView.querySelector<HTMLElement>("#planet-canvas-wrap")!;
  const tooltip = planetView.querySelector<HTMLElement>("#planet-tooltip")!;
  const sidepanel = planetView.querySelector<HTMLElement>("#planet-sidepanel")!;

  const customers = opts.customers || [];
  const documents = opts.documents || [];
  const docsByCustomer = new Map<string, PlanetDocument[]>();
  for (const doc of documents) {
    if (!doc.customerId) continue;
    const list = docsByCustomer.get(doc.customerId) || [];
    list.push(doc);
    docsByCustomer.set(doc.customerId, list);
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0C1A3A);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 2, 16);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  canvasWrap.appendChild(renderer.domElement);

  // 光照
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const coreLight = new THREE.PointLight(0x9a86ff, 1.4, 60);
  scene.add(coreLight);
  const dir = new THREE.DirectionalLight(0xffffff, 0.5);
  dir.position.set(5, 8, 10);
  scene.add(dir);

  const root = new THREE.Group();
  scene.add(root);

  // 中心 GoodJob 发光球 + 光晕
  const coreGeo = new THREE.SphereGeometry(1.5, 48, 48);
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x534AB7, emissive: 0x534AB7, emissiveIntensity: 0.7, roughness: 0.4 });
  const core = new THREE.Mesh(coreGeo, coreMat);
  root.add(core);
  const haloGeo = new THREE.SphereGeometry(2.1, 48, 48);
  const haloMat = new THREE.MeshBasicMaterial({ color: 0x7F77DD, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending });
  root.add(new THREE.Mesh(haloGeo, haloMat));
  const coreLabel = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLabelTexture("GoodJob", 0xAFA9EC), transparent: true }));
  coreLabel.scale.set(3, 0.75, 1);
  coreLabel.position.set(0, -2.6, 0);
  root.add(coreLabel);

  // 客户恒星 + 单据卫星
  const customerMeshes: THREE.Mesh[] = [];
  const starRadius = 6.5;
  const count = Math.max(customers.length, 1);
  customers.forEach((customer, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / count);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const dirVec = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi)
    );
    const pos = dirVec.clone().multiplyScalar(starRadius);

    const cgroup = new THREE.Group();
    cgroup.position.copy(pos);
    root.add(cgroup);

    const color = PALETTE[i % PALETTE.length];
    const starGeo = new THREE.SphereGeometry(0.55, 32, 32);
    const starMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.5 });
    const star = new THREE.Mesh(starGeo, starMat);
    star.userData = { customerId: customer.id, baseScale: 1, color };
    cgroup.add(star);
    customerMeshes.push(star);

    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeLabelTexture(customer.company, color), transparent: true }));
    label.scale.set(2.6, 0.65, 1);
    label.position.set(0, 0.95, 0);
    cgroup.add(label);

    // 单据卫星：环绕客户星的小圆轨道
    const docs = docsByCustomer.get(customer.id) || [];
    const orbitR = 1.15;
    docs.forEach((doc, j) => {
      const a = (j / Math.max(docs.length, 1)) * Math.PI * 2;
      const satGeo = new THREE.BoxGeometry(0.28, 0.36, 0.06);
      const satMat = new THREE.MeshStandardMaterial({ color: 0xEAF0FF, emissive: 0x6b7fb0, emissiveIntensity: 0.2, roughness: 0.6 });
      const sat = new THREE.Mesh(satGeo, satMat);
      sat.position.set(Math.cos(a) * orbitR, Math.sin(a) * orbitR, 0);
      sat.userData = { docId: doc.id, baseScale: 1 };
      cgroup.add(sat);
    });
  });

  // 点缀星
  const dotsGeo = new THREE.BufferGeometry();
  const dotPositions = new Float32Array(400 * 3);
  for (let i = 0; i < 400; i++) {
    const r = 18 + Math.random() * 20;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    dotPositions[i * 3] = r * Math.sin(p) * Math.cos(t);
    dotPositions[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
    dotPositions[i * 3 + 2] = r * Math.cos(p);
  }
  dotsGeo.setAttribute("position", new THREE.BufferAttribute(dotPositions, 3));
  scene.add(new THREE.Points(dotsGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.08, transparent: true, opacity: 0.6 })));

  // 交互状态
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered: THREE.Mesh | null = null;
  let dragging = false;
  let downX = 0, downY = 0, downTime = 0, moved = 0;
  let rotVelX = 0, rotVelY = 0;
  let autoRotate = true;

  function setPointerFromEvent(e: PointerEvent) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function onPointerMove(e: PointerEvent) {
    setPointerFromEvent(e);
    if (dragging) {
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      rotVelY = dx * 0.005;
      rotVelX = dy * 0.005;
      root.rotation.y += rotVelY;
      root.rotation.x = Math.min(Math.max(root.rotation.x + rotVelX, -1.2), 1.2);
      downX = e.clientX; downY = e.clientY;
      autoRotate = false;
      tooltip.hidden = true;
      return;
    }
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(customerMeshes, false);
    const hit = (hits[0]?.object as THREE.Mesh) || null;
    if (hit !== hovered) {
      if (hovered) hovered.scale.setScalar(hovered.userData.baseScale);
      hovered = hit;
      if (hovered) hovered.scale.setScalar(hovered.userData.baseScale * 1.5);
      canvasWrap.style.cursor = hovered ? "pointer" : "grab";
    }
    if (hovered) {
      const cid = hovered.userData.customerId;
      const c = customers.find((x) => x.id === cid);
      const n = (docsByCustomer.get(cid) || []).length;
      tooltip.innerHTML = `<b>${escapeHtml(c?.company || "")}</b><br><span class="pt-sub">${escapeHtml(c?.country || "")} · ${n} 份单据</span>`;
      tooltip.hidden = false;
      tooltip.style.left = e.clientX + 14 + "px";
      tooltip.style.top = e.clientY + 14 + "px";
    } else {
      tooltip.hidden = true;
    }
  }

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    downX = e.clientX; downY = e.clientY; downTime = Date.now();
    moved = 0;
    rotVelX = 0; rotVelY = 0;
  }

  function onPointerUp(e: PointerEvent) {
    const wasClick = moved < 6 && Date.now() - downTime < 350;
    dragging = false;
    if (!wasClick) return;
    setPointerFromEvent(e);
    raycaster.setFromCamera(pointer, camera);
    const satHits = raycaster.intersectObjects(root.children.flatMap((g) => (g as THREE.Group).children || []).filter((m) => m.userData?.docId), false);
    if (satHits[0]) {
      const docId = (satHits[0].object as THREE.Mesh).userData.docId;
      opts.onSelectDocument?.(docId);
      return;
    }
    const starHits = raycaster.intersectObjects(customerMeshes, false);
    if (starHits[0]) {
      const cid = (starHits[0].object as THREE.Mesh).userData.customerId;
      showSidePanel(cid);
      opts.onSelectCustomer?.(cid);
    }
  }

  function showSidePanel(customerId: string) {
    const c = customers.find((x) => x.id === customerId);
    const docs = docsByCustomer.get(customerId) || [];
    sidepanel.innerHTML = `
      <div class="ps-head">
        <span class="ps-company">${escapeHtml(c?.company || "")}</span>
        <button class="ps-close" id="planetSideClose">×</button>
      </div>
      <div class="ps-country">${escapeHtml(c?.country || "未知国家")} · 共 ${docs.length} 份单据</div>
      ${docs.length ? docs.map((d) => `<button class="ps-doc" data-doc-id="${escapeHtml(d.id)}"><b>${escapeHtml(d.type)} · ${escapeHtml(d.number)}</b><span>${escapeHtml(d.title)} · ${escapeHtml(d.status)}</span></button>`).join("") : `<div class="ps-empty">该客户暂无关联单据</div>`}
    `;
    sidepanel.hidden = false;
    sidepanel.querySelector<HTMLButtonElement>("#planetSideClose")?.addEventListener("click", () => { sidepanel.hidden = true; });
    sidepanel.querySelectorAll<HTMLButtonElement>(".ps-doc").forEach((btn) => {
      btn.addEventListener("click", () => opts.onSelectDocument?.(btn.dataset.docId || ""));
    });
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    camera.position.z = Math.min(Math.max(camera.position.z + e.deltaY * 0.01, 8), 30);
  }

  renderer.domElement.style.cursor = "grab";
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

  function resize() {
    const w = canvasWrap.clientWidth || 1;
    const h = canvasWrap.clientHeight || 1;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvasWrap);
  resize();

  let raf = 0;
  function animate() {
    raf = requestAnimationFrame(animate);
    if (autoRotate && !dragging) root.rotation.y += 0.0015;
    if (!dragging) {
      if (Math.abs(rotVelY) > 0.0001) { root.rotation.y += rotVelY; rotVelY *= 0.95; }
      if (Math.abs(rotVelX) > 0.0001) { root.rotation.x = Math.min(Math.max(root.rotation.x + rotVelX, -1.2), 1.2); rotVelX *= 0.95; }
    }
    haloMat.opacity = 0.16 + Math.sin(Date.now() * 0.002) * 0.05;
    renderer.render(scene, camera);
  }
  animate();

  function unmount() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    renderer.domElement.removeEventListener("pointermove", onPointerMove);
    renderer.domElement.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerUp);
    renderer.domElement.removeEventListener("wheel", onWheel);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    tooltip.hidden = true;
    sidepanel.hidden = true;
  }

  return { unmount };
}

function escapeHtml(s: string): string {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}
