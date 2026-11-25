import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

export interface ViewerHandle {
  fit(): void;
  setView(v: ViewName): void;
  screenshot(width?: number): string | null;
}

export type ViewName = 'iso' | 'top' | 'front' | 'right' | 'left' | 'back' | 'bottom';

interface Props {
  url: string | null;
  kind?: '3d' | '2d' | 'empty' | 'error';
  /** Changes whenever the model at `url` changes. */
  version: string | number;
  /** When this changes, the camera re-fits on the next load (e.g. new project). */
  fitKey: string;
  onLoaded?: () => void;
}

// Steeze: the field is bg (#021d2e); the part is a pale ice so cyan stays the signal colour.
const MODEL_COLOR = 0xb9d6dc;

export const Viewer = forwardRef<ViewerHandle, Props>(function Viewer({ url, kind, version, fitKey, onLoaded }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    model: THREE.Group;
    grid: THREE.Group;
    edgesMat: THREE.LineBasicMaterial;
    meshMat: THREE.MeshStandardMaterial;
    clip: THREE.Plane;
    bbox: THREE.Box3 | null;
    render: () => void;
  } | null>(null);
  const lastFitKey = useRef<string | null>(null);
  const [edges, setEdges] = useState(true);
  const [wire, setWire] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [section, setSection] = useState(false);
  const [sectionPos, setSectionPos] = useState(0.5);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---------------------------------------------------------------- scene setup
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0x021d2e);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(120, -160, 120);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -1.5, 2);
    camera.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-2, 1, -1);
    camera.add(fill);
    scene.add(camera);

    const grid = new THREE.Group();
    const minor = new THREE.GridHelper(500, 100, 0x0c2a3b, 0x0c2a3b);
    minor.rotation.x = Math.PI / 2;
    const major = new THREE.GridHelper(500, 10, 0x1c4255, 0x1c4255);
    major.rotation.x = Math.PI / 2;
    major.position.z = 0.01;
    grid.add(minor, major);
    const axes = new THREE.AxesHelper(20);
    (axes.material as THREE.LineBasicMaterial).depthTest = false;
    axes.setColors(new THREE.Color(0xff2a4f), new THREE.Color(0x00e5ff), new THREE.Color(0xff2bd6));
    axes.renderOrder = 2;
    grid.add(axes);
    scene.add(grid);

    const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);
    const meshMat = new THREE.MeshStandardMaterial({
      color: MODEL_COLOR,
      roughness: 0.55,
      metalness: 0.05,
      flatShading: false,
      side: THREE.DoubleSide,
      clippingPlanes: [clip],
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const edgesMat = new THREE.LineBasicMaterial({ color: 0x01070b, transparent: true, opacity: 0.6, clippingPlanes: [clip] });
    const model = new THREE.Group();
    scene.add(model);

    let frame = 0;
    const render = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const moving = controls.update();
        renderer.render(scene, camera);
        if (moving) render();
      });
    };
    controls.addEventListener('change', render);

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    ctx.current = { renderer, scene, camera, controls, model, grid, edgesMat, meshMat, clip, bbox: null, render };
    return () => {
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      ctx.current = null;
    };
  }, []);

  // ---------------------------------------------------------------- camera helpers
  const frameBox = (dir: THREE.Vector3, up = new THREE.Vector3(0, 0, 1)) => {
    const c = ctx.current;
    if (!c) return;
    const box = c.bbox ?? new THREE.Box3(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(20, 20, 20));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    const vfov = THREE.MathUtils.degToRad(c.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * c.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.15;
    c.camera.up.copy(up);
    c.camera.position.copy(center).add(dir.clone().normalize().multiplyScalar(dist));
    c.camera.near = dist / 100;
    c.camera.far = dist * 100;
    c.camera.updateProjectionMatrix();
    c.controls.target.copy(center);
    c.controls.update();
    c.render();
  };

  const views: Record<ViewName, [THREE.Vector3, THREE.Vector3?]> = {
    iso: [new THREE.Vector3(1, -1.3, 1)],
    top: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
    bottom: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0)],
    front: [new THREE.Vector3(0, -1, 0)],
    back: [new THREE.Vector3(0, 1, 0)],
    right: [new THREE.Vector3(1, 0, 0)],
    left: [new THREE.Vector3(-1, 0, 0)],
  };

  useImperativeHandle(ref, () => ({
    fit: () => frameBox(views.iso[0]),
    setView: (v) => frameBox(views[v][0], views[v][1]),
    screenshot: (width = 640) => {
      const c = ctx.current;
      if (!c) return null;
      // On phones the 3D view can be hidden behind another tab; a capture then is blank.
      if (!host.current || host.current.clientWidth < 50 || host.current.clientHeight < 50) return null;
      c.renderer.render(c.scene, c.camera);
      const src = c.renderer.domElement;
      const canvas = document.createElement('canvas');
      const scale = width / src.width;
      canvas.width = width;
      canvas.height = Math.round(src.height * scale);
      canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    },
  }));

  // ---------------------------------------------------------------- model loading
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    if (!url) {
      c.model.clear();
      c.bbox = null;
      c.render();
      return;
    }
    const ac = new AbortController();
    setLoadError(null);
    (async () => {
      const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!res.ok) throw new Error((await res.text()).slice(0, 300) || res.statusText);
      const buf = await res.arrayBuffer();
      const group = new THREE.Group();
      const isSvg = kind === '2d' || res.headers.get('content-type')?.includes('svg') || res.headers.get('x-model-kind') === '2d';
      if (isSvg) {
        const data = new SVGLoader().parse(new TextDecoder().decode(buf));
        for (const path of data.paths) {
          for (const shape of SVGLoader.createShapes(path)) {
            const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
            const mesh = new THREE.Mesh(geo, c.meshMat);
            group.add(mesh);
          }
        }
        // OpenSCAD SVG uses y-down coordinates.
        group.scale.y = -1;
      } else {
        const geo = new STLLoader().parse(buf);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, c.meshMat);
        group.add(mesh);
        const eg = new THREE.EdgesGeometry(geo, 25);
        const lines = new THREE.LineSegments(eg, c.edgesMat);
        lines.name = 'edges';
        group.add(lines);
      }
      if (ac.signal.aborted) return;
      c.model.clear();
      c.model.add(group);
      c.bbox = new THREE.Box3().setFromObject(group);
      if (lastFitKey.current !== fitKey) {
        lastFitKey.current = fitKey;
        frameBox(views.iso[0]);
      }
      c.render();
      onLoaded?.();
    })().catch((err) => {
      if (!ac.signal.aborted) setLoadError(String(err.message ?? err));
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, version, kind, fitKey]);

  // ---------------------------------------------------------------- display toggles
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.edgesMat.visible = edges;
    c.meshMat.wireframe = wire;
    c.grid.visible = showGrid;
    if (section && c.bbox) {
      const z = c.bbox.min.z + (c.bbox.max.z - c.bbox.min.z) * sectionPos;
      c.clip.constant = z;
    } else c.clip.constant = 1e6;
    c.render();
  }, [edges, wire, showGrid, section, sectionPos, version]);

  return (
    <div className="viewer">
      <div ref={host} className="viewer-canvas" />
      <div className="viewer-tools">
        <button className="small" onClick={() => frameBox(views.iso[0])} title="Fit model">Fit</button>
        {(['iso', 'top', 'front', 'right'] as ViewName[]).map((v) => (
          <button key={v} className="small" onClick={() => frameBox(views[v][0], views[v][1])}>
            {v[0].toUpperCase() + v.slice(1)}
          </button>
        ))}
        <span className="sep" />
        <button className={`small ${edges ? 'on' : ''}`} onClick={() => setEdges(!edges)} title="Show edges">Edges</button>
        <button className={`small ${wire ? 'on' : ''}`} onClick={() => setWire(!wire)} title="Wireframe">Wire</button>
        <button className={`small ${showGrid ? 'on' : ''}`} onClick={() => setShowGrid(!showGrid)} title="Build plate grid (10 mm squares)">Grid</button>
        <button className={`small ${section ? 'on' : ''}`} onClick={() => setSection(!section)} title="Cut the model horizontally to see inside">Section</button>
        {section && (
          <input
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={sectionPos}
            onChange={(e) => setSectionPos(Number(e.target.value))}
            className="section-slider"
            title="Section height"
          />
        )}
      </div>
      {loadError && <div className="viewer-msg error">Couldn't load model: {loadError}</div>}
    </div>
  );
});
