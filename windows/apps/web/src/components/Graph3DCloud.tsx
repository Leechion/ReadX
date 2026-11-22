/**
 * 三维点云：把跨文献实体与论文渲染成一团可旋转的点云。
 *
 * 结构（双环同心，参考 Orbitgraph）：
 *   - 核心环：被 ≥2 篇论文共享的实体，越靠圆心说明被越多篇共享；
 *   - 外围环：只出现在一篇里的实体；
 *   - 论文壳：论文摆在外圈，各连到自己包含的实体。
 * 连边分两种：实体之间的关系（亮）与论文到实体的包含（暗）。
 *
 * 几条刻意的取舍：
 *   - **收敛后静止**：布局分批算完就冻结位置，旋转交给相机。每帧重算力导向在几千个点上
 *     很贵，而点云要回答的是「结构长什么样」，不是「它此刻在怎么动」。
 *   - **不点边、只点实体**：三维里射线拾取细线极不可靠。悬停实体即高亮它全部连线，
 *     选中实体后在详情面板里看关系与逐字证据。
 *   - **降级要说话**：点或边超过上限时减少绘制并显示说明，不悄悄画一半。
 *   - **回调与选中不进场景依赖**：否则每选一个点就重建 WebGL 场景、相机也跟着跳。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFullscreen } from '../hooks/useFullscreen';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  advanceCloud,
  convergenceThreshold,
  defaultIterations,
  prepareCloud,
  type CloudLayout,
  type CloudNode,
} from '../lib/graph3dLayout';
import type { GraphEdge, GraphNode, GraphPaper } from '../api/client';

/** 超过这些上限就减少绘制并如实说明。 */
const MAX_RELATION_EDGES = 12000;
const MAX_MEMBER_EDGES = 9000;
const LABEL_LIMIT = 12;
const KIND_LABEL: Record<string, string> = { concept: '概念', method: '方法', conclusion: '结论' };

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  papers: GraphPaper[];
  selectedId: string | null;
  /** 点中一个点：实体给实体 id，论文点给 `paper:<key>`。 */
  onPick: (id: string) => void;
  onHover?: (id: string | null) => void;
}

/** 从主题变量里取色：四种主题（浅/深/纸张/跟随系统）下点云都跟着走。 */
function themeColor(name: string, fallback: string): THREE.Color {
  if (typeof window === 'undefined') return new THREE.Color(fallback);
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return new THREE.Color(fallback);
  try {
    return new THREE.Color(raw);
  } catch {
    return new THREE.Color(fallback);
  }
}

interface ThemePalette {
  concept: THREE.Color;
  method: THREE.Color;
  conclusion: THREE.Color;
  paper: THREE.Color;
  link: THREE.Color;
  linkMember: THREE.Color;
  /** 浅色主题下不能用加色混合：那是给深底设计的，浅底上越加越白，点会直接消失。 */
  additive: boolean;
}

function readPalette(): ThemePalette {
  const canvas = themeColor('--color-canvas', '#f5f7f4');
  const hsl = { h: 0, s: 0, l: 1 };
  canvas.getHSL(hsl);
  return {
    concept: themeColor('--color-entity-1', '#2f6f59'),
    method: themeColor('--color-entity-2', '#2872b8'),
    conclusion: themeColor('--color-entity-3', '#9d6b26'),
    paper: themeColor('--color-entity-4', '#7e8389'),
    link: themeColor('--color-line-strong', '#bccbbf'),
    linkMember: themeColor('--color-line', '#dfe6de'),
    additive: hsl.l < 0.5,
  };
}

const POINT_VERTEX = `
  attribute float size;
  attribute vec3 pointColor;
  attribute float alpha;
  uniform float pixelScale;
  uniform float refDepth;
  uniform float depthFade;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = pointColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // 远处更淡：浅色底上也能读出前后关系。
    float fade = clamp(1.35 - (-mv.z) / depthFade, 0.42, 1.0);
    vAlpha = alpha * fade;
    // 点的大小按**像素**给基准、再按景深自然缩放：
    // 若按世界单位算，画布变大或相机拉近时点会胀成一个个球（实测就是这样）。
    gl_PointSize = pixelScale * size * (refDepth / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAGMENT = `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // 圆形软边：中心实、边缘化开，叠在一起就是「点云」的观感。
    float dist = length(gl_PointCoord - vec2(0.5));
    float falloff = smoothstep(0.5, 0.12, dist);
    if (falloff <= 0.001) discard;
    gl_FragColor = vec4(vColor, falloff * vAlpha);
  }
`;

export function Graph3DCloud({ nodes, edges, papers, selectedId, onPick, onHover }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const labelsHost = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'settling' | 'ready'>('idle');
  const [stats, setStats] = useState<CloudLayout['stats'] | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const { isFullscreen, toggleFullscreen } = useFullscreen(() => shell.current?.closest<HTMLElement>('.graph-section') ?? shell.current);
  const [webGLError, setWebGLError] = useState(false);


  // 回调与选中都走 ref：它们变化不该重建 WebGL 场景。
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const hoverRef = useRef(onHover);
  hoverRef.current = onHover;
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const applyFocusRef = useRef<((id: string | null) => void) | null>(null);
  const resetViewRef = useRef<(() => void) | null>(null);

  // 布局：分批推进，每帧给 10ms 预算，避免阻塞界面。
  const layout = useMemo(
    () => (nodes.length || papers.length ? prepareCloud({ nodes, edges, papers }) : null),
    [nodes, edges, papers],
  );

  useEffect(() => {
    if (!layout) {
      setPhase('idle');
      return;
    }
    let cancelled = false;
    setWebGLError(false);
    const velocity = new Float64Array(layout.nodes.length * 3);
    const maxIterations = defaultIterations(layout.nodes.length);
    const threshold = convergenceThreshold(layout);
    setPhase('settling');
    setProgress(0);
    let frame = 0;
    const runFrame = () => {
      if (cancelled) return;
      const started = performance.now();
      let moved = 0;
      // 每帧算到预算用尽：大图每轮更贵，这里自然就会少算几轮。
      while (performance.now() - started < 10 && layout.stats.iterations < maxIterations) {
        moved = advanceCloud(layout, velocity);
        if (moved < threshold) {
          layout.stats.converged = true;
          break;
        }
      }
      if (cancelled) return;
      setProgress(Math.min(1, layout.stats.iterations / maxIterations));
      if (layout.stats.converged || layout.stats.iterations >= maxIterations) {
        setStats({ ...layout.stats });
        setPhase('ready');
        return;
      }
      frame = requestAnimationFrame(runFrame);
    };
    frame = requestAnimationFrame(runFrame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [layout]);

  // 场景：只在收敛完成后建一次；依赖里不放回调与选中。
  useEffect(() => {
    const element = host.current;
    if (!element || !layout || phase !== 'ready') return;

    const palette = readPalette();
    const radius = layout.radius;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setWebGLError(true);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(element.clientWidth, Math.max(1, element.clientHeight), false);
    renderer.domElement.className = 'cloud-canvas';
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // 取景按收敛后的实际分布来算：用「88 分位半径」而不是最大半径——
    // 最外那一个点会把画面撑开，让整团点云只占中间一小块（实测就是这个问题）。
    const sortedRadii = layout.nodes
      .map((node) => Math.hypot(node.x, node.y, node.z))
      .sort((a, b) => a - b);
    const percentile = sortedRadii[Math.min(sortedRadii.length - 1, Math.floor(sortedRadii.length * 0.95))] ?? radius;
    const bound = Math.max(percentile, radius * 0.5);
    const fitDistance = (bound / Math.tan(((52 / 2) * Math.PI) / 180)) * 1.02;
    const camera = new THREE.PerspectiveCamera(
      52,
      element.clientWidth / Math.max(1, element.clientHeight),
      0.5,
      bound * 40,
    );
    const home = new THREE.Vector3(0.12, 0.4, 0.9).normalize().multiplyScalar(fitDistance);
    camera.position.copy(home);

    /**
     * 宽屏下横向拉伸。
     *
     * 球体按高度取景时横向只用得到一半宽度（宽屏越宽浪费越多），所以把整团云沿 x 拉长，
     * 让它铺满视野。拉伸是整体施加在 scene 上的，环向导、连边、点会一起变形，结构关系不变；
     * 只有标签的屏幕定位是自己算的，必须跟着乘同一个系数，否则标签会飘离它的点。
     */
    const stageAspect = element.clientWidth / Math.max(1, element.clientHeight);
    const stretch = Math.min(1.7, Math.max(1, stageAspect * 0.82));
    scene.scale.set(stretch, 1, 1);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.65;
    controls.zoomSpeed = 0.8;
    controls.minDistance = bound * 0.25;
    controls.maxDistance = bound * 8;
    controls.autoRotate = autoRotateRef.current;
    controls.autoRotateSpeed = 0.35;

    const kindColor = (node: CloudNode): THREE.Color => {
      if (node.ring === 'paper') return palette.paper;
      if (node.kind === 'method') return palette.method;
      if (node.kind === 'conclusion') return palette.conclusion;
      return palette.concept;
    };

    // ---- 点 ----
    const count = layout.nodes.length;
    // 点的基准像素：点少时给大一点（否则稀疏得像噪点），点多时收小（否则糊成一片）。
    const pixelScale = count > 800 ? 5 : count > 200 ? 6 : 8;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const baseSizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    layout.nodes.forEach((node, index) => {
      positions[index * 3] = node.x;
      positions[index * 3 + 1] = node.y;
      positions[index * 3 + 2] = node.z;
      // 核心环的点整体放大一点：它们才是跨文献的共识。
      const ringBoost = node.ring === 'core' ? 1.35 : node.ring === 'paper' ? 0.9 : 1;
      baseSizes[index] = node.size * ringBoost;
      sizes[index] = baseSizes[index]!;
      alphas[index] = node.ring === 'paper' ? (palette.additive ? 0.72 : 0.8) : 1;
      const color = kindColor(node);
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    });

    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    pointGeometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    pointGeometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    pointGeometry.setAttribute('pointColor', new THREE.BufferAttribute(colors, 3));
    const pointMaterial = new THREE.ShaderMaterial({
      uniforms: {
        pixelScale: { value: pixelScale },
        refDepth: { value: fitDistance },
        depthFade: { value: bound * 3.2 },
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: palette.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(pointGeometry, pointMaterial);
    scene.add(points);

    // ---- 环向导：双环同心的「环」得看得见，否则只是一团散点 ----
    // 参考实现本来就是同心圆结构，这里把两条主环与论文壳画成极淡的参考圆/球线框，
    // 让人一眼看出「哪些点在同一条轨道上」。
    const coreRadius = layout.nodes
      .filter((node) => node.ring === 'core')
      .reduce((sum, node, _, all) => sum + node.targetRadius / all.length, 0);
    const outerRadius = layout.nodes
      .filter((node) => node.ring === 'outer')
      .reduce((sum, node, _, all) => sum + node.targetRadius / all.length, 0);
    const guideMaterial = new THREE.LineBasicMaterial({
      color: palette.link,
      transparent: true,
      opacity: palette.additive ? 0.2 : 0.32,
      depthWrite: false,
      blending: palette.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const ringGuide = (ringRadius: number, segments = 96) => {
      const group = new THREE.Group();
      // 每个壳画三个正交圆（像万向环）而不是一个平面圆 + 网格球：
      // 单个平面圆会和球面上的点脱节，网格球又太抢眼；三个正交圆既交代了球壳，
      // 也让人一眼看出这是三维轨道而不是一张平面图。
      const orientations: ((u: number, v: number) => [number, number, number])[] = [
        (u, v) => [u, v, 0],
        (u, v) => [u, 0, v],
        (u, v) => [0, u, v],
      ];
      for (const orient of orientations) {
        const positions = new Float32Array((segments + 1) * 3);
        for (let index = 0; index <= segments; index += 1) {
          const angle = (index / segments) * Math.PI * 2;
          const [x, y, z] = orient(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius);
          positions[index * 3] = x;
          positions[index * 3 + 1] = y;
          positions[index * 3 + 2] = z;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        group.add(new THREE.Line(geometry, guideMaterial));
      }
      return group;
    };
    const guides: THREE.Object3D[] = [];
    if (Number.isFinite(coreRadius) && coreRadius > 0) {
      const ring = ringGuide(coreRadius);
      guides.push(ring);
      scene.add(ring);
    }
    if (Number.isFinite(outerRadius) && outerRadius > 0) {
      const ring = ringGuide(outerRadius);
      guides.push(ring);
      scene.add(ring);
    }

    // ---- 核心环的辉光：被多篇共享的实体值得一眼看见 ----
    const coreIndices = layout.nodes
      .map((node, index) => ({ node, index }))
      .filter((item) => item.node.ring === 'core')
      .map((item) => item.index);
    let haloGeometry: THREE.BufferGeometry | null = null;
    let haloMaterial: THREE.ShaderMaterial | null = null;
    if (coreIndices.length) {
      const haloPositions = new Float32Array(coreIndices.length * 3);
      const haloSizes = new Float32Array(coreIndices.length);
      const haloAlphas = new Float32Array(coreIndices.length);
      const haloColors = new Float32Array(coreIndices.length * 3);
      coreIndices.forEach((nodeIndex, position) => {
        const node = layout.nodes[nodeIndex]!;
        haloPositions[position * 3] = node.x;
        haloPositions[position * 3 + 1] = node.y;
        haloPositions[position * 3 + 2] = node.z;
        haloSizes[position] = node.size * 3.1;
        haloAlphas[position] = palette.additive ? 0.3 : 0.16;
        const color = kindColor(node);
        haloColors[position * 3] = color.r;
        haloColors[position * 3 + 1] = color.g;
        haloColors[position * 3 + 2] = color.b;
      });
      haloGeometry = new THREE.BufferGeometry();
      haloGeometry.setAttribute('position', new THREE.BufferAttribute(haloPositions, 3));
      haloGeometry.setAttribute('size', new THREE.BufferAttribute(haloSizes, 1));
      haloGeometry.setAttribute('alpha', new THREE.BufferAttribute(haloAlphas, 1));
      haloGeometry.setAttribute('pointColor', new THREE.BufferAttribute(haloColors, 3));
      haloMaterial = pointMaterial.clone();
      haloMaterial.uniforms = {
        pixelScale: { value: pixelScale },
        refDepth: { value: fitDistance },
        depthFade: { value: bound * 3.2 },
      };
      scene.add(new THREE.Points(haloGeometry, haloMaterial));
    }

    // ---- 边 ----
    const relationLinks = layout.links.filter((link) => link.kind === 'relation');
    const memberLinks = layout.links.filter((link) => link.kind === 'member');
    const relationDrawn = relationLinks.slice(0, MAX_RELATION_EDGES);
    const memberDrawn = memberLinks.slice(0, MAX_MEMBER_EDGES);
    const buildLines = (
      links: CloudLayout['links'],
      color: THREE.Color,
      opacity: number,
      brightenCrossPaper: boolean,
    ) => {
      const array = new Float32Array(links.length * 6);
      const lineColors = new Float32Array(links.length * 6);
      links.forEach((link, index) => {
        const a = layout.nodes[link.from]!;
        const b = layout.nodes[link.to]!;
        array.set([a.x, a.y, a.z, b.x, b.y, b.z], index * 6);
        const tint =
          brightenCrossPaper && link.docs.length > 1 ? color.clone().offsetHSL(0, 0.05, 0.12) : color;
        lineColors.set([tint.r, tint.g, tint.b, tint.r, tint.g, tint.b], index * 6);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
      const material = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: palette.additive ? opacity : Math.min(0.85, opacity * 0.72),
        depthWrite: false,
        blending: palette.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      return new THREE.LineSegments(geometry, material);
    };
    const relationLines = buildLines(relationDrawn, palette.link, 0.72, true);
    const memberLines = buildLines(memberDrawn, palette.linkMember, 0.34, false);
    scene.add(relationLines);
    scene.add(memberLines);

    // ---- 高亮层：悬停/选中时单独画它的连线与一个放大的点 ----
    const highlightGeometry = new THREE.BufferGeometry();
    highlightGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    highlightGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    const highlightMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: palette.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    scene.add(new THREE.LineSegments(highlightGeometry, highlightMaterial));

    const emptyFloat = () => new THREE.BufferAttribute(new Float32Array(0), 1);
    const focusGeometry = new THREE.BufferGeometry();
    focusGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    focusGeometry.setAttribute('size', emptyFloat());
    focusGeometry.setAttribute('alpha', emptyFloat());
    focusGeometry.setAttribute('pointColor', new THREE.BufferAttribute(new Float32Array(0), 3));
    const focusMaterial = pointMaterial.clone();
    focusMaterial.uniforms = {
      pixelScale: { value: pixelScale },
      refDepth: { value: fitDistance },
      depthFade: { value: bound * 3.2 },
    };
    scene.add(new THREE.Points(focusGeometry, focusMaterial));

    // ---- 邻接表与索引 ----
    const linksByNode = new Map<number, CloudLayout['links']>();
    layout.links.forEach((link) => {
      if (!linksByNode.has(link.from)) linksByNode.set(link.from, []);
      if (!linksByNode.has(link.to)) linksByNode.set(link.to, []);
      linksByNode.get(link.from)!.push(link);
      linksByNode.get(link.to)!.push(link);
    });
    const indexById = new Map(layout.nodes.map((node, index) => [node.id, index]));

    const applyFocus = (id: string | null) => {
      if (!id || !indexById.has(id)) {
        highlightGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
        highlightGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
        focusGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
        sizes.set(baseSizes);
        pointGeometry.attributes.size!.needsUpdate = true;
        return;
      }
      const index = indexById.get(id)!;
      const node = layout.nodes[index]!;
      const links = linksByNode.get(index) ?? [];
      const array = new Float32Array(links.length * 6);
      const lineColors = new Float32Array(links.length * 6);
      const tint = kindColor(node).clone().offsetHSL(0, 0, 0.28);
      links.forEach((link, position) => {
        const a = layout.nodes[link.from]!;
        const b = layout.nodes[link.to]!;
        array.set([a.x, a.y, a.z, b.x, b.y, b.z], position * 6);
        lineColors.set([tint.r, tint.g, tint.b, tint.r, tint.g, tint.b], position * 6);
      });
      highlightGeometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
      highlightGeometry.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
      // 被照亮的邻居也放大：一眼看清「这个点和谁相连」。
      sizes.set(baseSizes);
      sizes[index] = baseSizes[index]! * 2.1;
      for (const link of links) {
        const other = link.from === index ? link.to : link.from;
        sizes[other] = baseSizes[other]! * 1.45;
      }
      pointGeometry.attributes.size!.needsUpdate = true;
      focusGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([node.x, node.y, node.z]), 3));
      focusGeometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array([baseSizes[index]! * 3.4]), 1));
      focusGeometry.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array([1]), 1));
      const focusColor = kindColor(node).clone().offsetHSL(0, 0, 0.2);
      focusGeometry.setAttribute(
        'pointColor',
        new THREE.BufferAttribute(new Float32Array([focusColor.r, focusColor.g, focusColor.b]), 3),
      );
    };
    applyFocusRef.current = applyFocus;

    // ---- 交互 ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerInside = false;
    let hoverId: string | null = null;
    let pointerFrame = 0;

    /**
     * 拾取阈值随相机距离缩放。
     *
     * three 的 Points 拾取用的是「世界单位」的固定阈值，而点的大小在屏幕上随距离变化：
     * 拉远看点云时点只剩几个像素，固定阈值就永远拾取不到——那正是最需要悬停查看的时候。
     */
    const updateThreshold = () => {
      const distance = camera.position.distanceTo(controls.target);
      const scale = Math.max(0.6, Math.min(2.4, distance / (radius * 2.3)));
      raycaster.params.Points = { threshold: radius * 0.035 * scale };
    };

    const pick = (): string | null => {
      raycaster.setFromCamera(pointer, camera);
      updateThreshold();
      const hits = raycaster.intersectObject(points, false);
      const first = hits[0];
      if (!first || first.index === undefined) return null;
      return layout.nodes[first.index]?.id ?? null;
    };
    const onPointerMove = (event: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      pointerInside = true;
      cancelAnimationFrame(pointerFrame);
      pointerFrame = requestAnimationFrame(() => {
        const next = pointerInside ? pick() : null;
        if (next === hoverId) return;
        hoverId = next;
        setHovered(next);
        hoverRef.current?.(next);
        applyFocus(next ?? selectedRef.current);
      });
    };
    const onPointerLeave = () => {
      pointerInside = false;
      if (hoverId === null) return;
      hoverId = null;
      setHovered(null);
      hoverRef.current?.(null);
      applyFocus(selectedRef.current);
    };
    const onClick = () => {
      const id = pick();
      if (id) pickRef.current(id);
    };
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('click', onClick);

    // ---- 尺寸与渲染循环 ----
    const resize = () => {
      const width = element.clientWidth;
      const height = Math.max(1, element.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // 像素基准与景深基准都不随画布尺寸变，所以缩放时不用改 uniform。
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    let frame = 0;
    const projected = new THREE.Vector3();
    // 标签尺寸只量一次：每帧读 offsetWidth 会触发同步布局，十几帧下来就是浪费。
    const labelSize = new Map<string, { w: number; h: number }>();
    const placedBoxes: { x: number; y: number; w: number; h: number }[] = [];
    const tick = () => {
      controls.autoRotate = autoRotateRef.current;
      controls.update();
      renderer.render(scene, camera);
      // 标签跟着三维位置走：直接改 DOM，不走 React，免得每帧重渲染组件。
      const labelHost = labelsHost.current;
      if (labelHost) {
        const width = element.clientWidth;
        const height = element.clientHeight;
        placedBoxes.length = 0;
        for (const el of labelHost.querySelectorAll<HTMLElement>('[data-cloud-label]')) {
          const id = el.dataset.cloudLabel;
          const index = id ? indexById.get(id) : undefined;
          if (index === undefined || !id) continue;
          const node = layout.nodes[index]!;
          projected.set(node.x * stretch, node.y, node.z).project(camera);
          if (projected.z >= 1) {
            el.style.opacity = '0';
            continue;
          }
          const x = ((projected.x + 1) / 2) * width;
          const y = ((-projected.y + 1) / 2) * height - 16;
          let size = labelSize.get(id);
          if (!size) {
            size = { w: el.offsetWidth || 96, h: el.offsetHeight || 18 };
            labelSize.set(id, size);
          }
          const box = { x: x - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h };
          const selected = el.classList.contains('selected');
          // 标签互相压住时，后放的让位（选中那个永远保留）。
          const collides = placedBoxes.some(
            (other) =>
              box.x < other.x + other.w &&
              box.x + box.w > other.x &&
              box.y < other.y + other.h &&
              box.y + box.h > other.y,
          );
          if (collides && !selected) {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
            continue;
          }
          placedBoxes.push(box);
          el.style.opacity = '1';
          el.style.pointerEvents = 'auto';
          el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    resetViewRef.current = () => {
      camera.position.copy(home);
      controls.target.set(0, 0, 0);
      controls.update();
    };

    const trimmed =
      relationDrawn.length < relationLinks.length || memberDrawn.length < memberLinks.length;
    setNotice(
      trimmed
        ? `边太多：${relationLinks.length} 条关系只画了前 ${relationDrawn.length} 条、${memberLinks.length} 条包含边只画了前 ${memberDrawn.length} 条（用筛选缩小范围可以看得更全）。`
        : '',
    );

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(pointerFrame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      scene.clear();
      applyFocusRef.current = null;
      resetViewRef.current = null;
      pointGeometry.dispose();
      pointMaterial.dispose();
      focusGeometry.dispose();
      focusMaterial.dispose();
      highlightGeometry.dispose();
      highlightMaterial.dispose();
      relationLines.geometry.dispose();
      (relationLines.material as THREE.Material).dispose();
      memberLines.geometry.dispose();
      (memberLines.material as THREE.Material).dispose();
      for (const guide of guides) {
        guide.traverse((child) => {
          const geometry = (child as THREE.Mesh).geometry;
          geometry?.dispose();
        });
      }
      guideMaterial.dispose();
      haloGeometry?.dispose();
      haloMaterial?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [layout, phase]);

  // 选中变化：只刷新高亮，不重建场景（悬停优先于选中）。
  useEffect(() => {
    if (phase !== 'ready') return;
    if (hovered) return;
    applyFocusRef.current?.(selectedId);
  }, [selectedId, phase, hovered]);

  const resetView = useCallback(() => resetViewRef.current?.(), []);

  /** 悬停在标签上也点亮它的连线：标签是点的入口，不该只有画布能触发。 */
  const labelFocus = useCallback((id: string | null) => {
    setHovered(id);
    hoverRef.current?.(id);
    applyFocusRef.current?.(id ?? selectedRef.current);
  }, []);

  const hoveredNode = useMemo(
    () => (hovered && layout ? layout.nodes.find((node) => node.id === hovered) ?? null : null),
    [hovered, layout],
  );

  // 标签只给度数最高的若干实体 + 当前选中的那个。
  const labelled = useMemo(() => {
    if (!layout) return [];
    const top = layout.nodes
      .filter((node) => node.ring !== 'paper')
      .sort((a, b) => b.degree - a.degree)
      .slice(0, LABEL_LIMIT);
    if (selectedId && !top.some((node) => node.id === selectedId)) {
      const selected = layout.nodes.find((node) => node.id === selectedId);
      if (selected && selected.ring !== 'paper') top.push(selected);
    }
    return top;
  }, [layout, selectedId]);

  return (
    <div className="cloud-shell" ref={shell}>
      <div className="cloud-stage" ref={host}>
        {webGLError ? (
          <div className="cloud-fallback" role="status">
            <p>三维点云当前不可用。你仍可从列表选择实体或论文，查看关系与原文依据。</p>
            <ul>
              {layout?.nodes.slice(0, 200).map((node) => (
                <li key={node.id}>
                  <button type="button" onClick={() => onPick(node.id)}>
                    <span>{node.label}</span>
                    <small>{node.ring === 'paper' ? '论文' : KIND_LABEL[node.kind] ?? node.kind}</small>
                  </button>
                </li>
              ))}
            </ul>
            {layout && layout.nodes.length > 200 ? <small>共 {layout.nodes.length} 项；可用上方搜索和类型筛选缩小范围。</small> : null}
          </div>
        ) : null}
        <div className="cloud-labels" ref={labelsHost}>
          {phase === 'ready' && !webGLError
            ? labelled.map((node) => (
                <button
                  type="button"
                  key={node.id}
                  data-cloud-label={node.id}
                  className={`cloud-label kind-${node.kind}${selectedId === node.id ? ' selected' : ''}`}
                  onClick={() => onPick(node.id)}
                  onMouseEnter={() => labelFocus(node.id)}
                  onMouseLeave={() => labelFocus(null)}
                  title={node.label}
                >
                  {node.label}
                </button>
              ))
            : null}
        </div>
        {phase !== 'ready' && !webGLError ? (
          <div className="cloud-progress" role="status">
            <p>正在让点云收敛… {Math.round(progress * 100)}%</p>
            <span className="cloud-progress-track"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>
            <small>{layout ? `${layout.nodes.length} 个点 · ${layout.links.length} 条边` : ''}</small>
          </div>
        ) : null}
        {hoveredNode ? (
          <div className="cloud-hover">
            <strong>{hoveredNode.label}</strong>
            <span>
              {hoveredNode.ring === 'paper'
                ? '论文'
                : `${hoveredNode.kind === 'method' ? '方法' : hoveredNode.kind === 'conclusion' ? '结论' : '概念'} · ${hoveredNode.share} 篇论文 · ${hoveredNode.degree} 条关系`}
            </span>
          </div>
        ) : null}
      </div>

      <div className="cloud-overlay">
        <div className="cloud-legend">
          <span><i className="cloud-dot concept" />概念</span>
          <span><i className="cloud-dot method" />方法</span>
          <span><i className="cloud-dot conclusion" />结论</span>
          <span><i className="cloud-dot paper" />论文</span>
        </div>
        <div className="cloud-actions">
          <button
            type="button"
            aria-pressed={autoRotate}
            className={autoRotate ? 'active' : ''}
            onClick={() => setAutoRotate((value) => !value)}
          >
            自转
          </button>
          <button type="button" onClick={resetView}>重置视角</button>
          <button
            type="button"
            aria-pressed={isFullscreen}
            className={isFullscreen ? 'active' : ''}
            title="连应用顶栏一起盖住（Esc 退出）"
            onClick={toggleFullscreen}
          >
            {isFullscreen ? '退出全屏' : '全屏'}
          </button>
        </div>
      </div>

      <p className="cloud-status">
        越靠圆心＝被越多篇论文共享；外圈是只出现在一篇里的实体，最外层是论文。
        共 {layout?.stats.core ?? 0} 个跨文献实体、{layout?.stats.outer ?? 0} 个单篇实体、
        {layout?.stats.relations ?? 0} 条关系边
        {stats ? ` · 收敛 ${stats.iterations} 轮${stats.converged ? '' : '（到上限即停）'}` : ''}
        。拖拽旋转、滚轮缩放、右键平移；悬停一个点会点亮它的全部连线。
      </p>
      {notice ? <p className="cloud-notice">{notice}</p> : null}
    </div>
  );
}
