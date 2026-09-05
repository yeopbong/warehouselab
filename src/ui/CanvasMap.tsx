import { useEffect, useRef } from 'react';
import { pointKey, type Point, type Scenario, type StationRole } from '../core/model/types';
import { DisplayStore, type DisplaySample } from './display';
import {
  fitViewport,
  rasterizeStroke,
  screenToCell,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Viewport,
} from './viewport';

export type Selection =
  { kind: 'robot' | 'station'; id: string } | { kind: 'cell'; position: Point } | null;
export type Tool = 'select' | 'pan' | 'move' | 'obstacle' | 'erase' | StationRole | 'robot';
export type EditAction =
  | { type: 'paint'; tool: 'obstacle' | 'erase'; cells: Point[] }
  | { type: 'place'; tool: StationRole | 'robot'; point: Point }
  | { type: 'move'; selection: { kind: 'robot' | 'station'; id: string }; point: Point };
export const ROLE_COLORS = {
  supply: '#83a99a',
  process: '#91a7bd',
  assembly: '#b3a3bf',
  delivery: '#c3ac86',
};

interface Props {
  scenario: Scenario;
  store: DisplayStore;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  tool: Tool;
  editing: boolean;
  onEdit: (action: EditAction) => void;
  validateEdit?: (action: EditAction) => string | null;
  showPaths: boolean;
  heatmap: boolean;
  fitSignal?: number;
  onDisplayTick?: (tick: number) => void;
}
interface Gesture {
  pointerId: number;
  scenario: Scenario;
  tool: Tool;
  generation: number;
  kind: 'pan' | 'paint' | 'move' | 'place';
  start: Point;
  last: Point;
  view: Viewport;
  cells: Map<string, Point>;
  action?: EditAction;
  origin?: Point;
}
const sameSelection = (selection: Selection, kind: 'robot' | 'station', id: string) =>
  selection?.kind === kind && selection.id === id;
const isTextInput = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export default function CanvasMap(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef(props);
  current.current = props;
  const view = useRef<Viewport>({ width: 1, height: 1, cell: 20, x: 0, y: 0 });
  const automaticFit = useRef(true);
  const frame = useRef<DisplaySample | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const hover = useRef<Point | null>(null);
  const preview = useRef<EditAction | null>(null);
  const space = useRef(false);
  const pointerInside = useRef(false);
  const previewError = useRef<string | null>(null);

  const inside = (point: Point) =>
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < current.current.scenario.width &&
    point.y < current.current.scenario.height;
  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const updatePreview = (action: EditAction | null) => {
    preview.current = action;
    previewError.current = action ? (current.current.validateEdit?.(action) ?? null) : null;
  };
  const cancelGesture = () => {
    const active = gesture.current;
    gesture.current = null;
    updatePreview(null);
    if (active && canvas.current?.hasPointerCapture(active.pointerId))
      canvas.current.releasePointerCapture(active.pointerId);
  };
  const currentGesture = (active: Gesture) => {
    const p = current.current;
    return (
      active.scenario === p.scenario &&
      active.tool === p.tool &&
      active.generation === p.store.generation &&
      (active.kind === 'pan' || p.editing)
    );
  };
  const hit = (point: Point): Selection => {
    const world = screenToWorld(point, view.current);
    let robotId: string | null = null,
      closest = 0.48;
    for (const robot of frame.current?.robots ?? []) {
      const distance = Math.hypot(
        world.x - robot.position.x - 0.5,
        world.y - robot.position.y - 0.5,
      );
      if (distance < closest) {
        closest = distance;
        robotId = robot.id;
      }
    }
    if (robotId) return { kind: 'robot', id: robotId };
    const cell = screenToCell(point, view.current);
    const station = current.current.scenario.stations.find(
      (station) =>
        pointKey(station.position) === pointKey(cell) ||
        pointKey(station.service) === pointKey(cell),
    );
    if (station) return { kind: 'station', id: station.id };
    return inside(cell) ? { kind: 'cell', position: cell } : null;
  };

  useEffect(() => {
    automaticFit.current = true;
    const sc = current.current.scenario;
    view.current = fitViewport(view.current.width, view.current.height, sc.width, sc.height);
    cancelGesture();
  }, [props.fitSignal, props.scenario.id, props.scenario.width, props.scenario.height]);

  useEffect(() => {
    cancelGesture();
  }, [props.tool, props.editing, props.scenario]);

  useEffect(() => {
    const element = canvas.current!,
      container = host.current!;
    const resize = () => {
      const width = Math.max(1, container.clientWidth),
        height = Math.max(1, container.clientHeight);
      const previous = view.current;
      const sc = current.current.scenario;
      view.current = automaticFit.current
        ? fitViewport(width, height, sc.width, sc.height)
        : {
            ...previous,
            width,
            height,
            x: previous.x + (width - previous.width) / 2,
            y: previous.y + (height - previous.height) / 2,
          };
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      automaticFit.current = false;
      view.current = zoomAt(
        view.current,
        localPoint(event),
        Math.exp(-Math.max(-300, Math.min(300, event.deltaY)) * 0.002),
      );
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.code === 'Space' &&
        !isTextInput(event.target) &&
        (pointerInside.current || document.activeElement === element)
      ) {
        event.preventDefault();
        space.current = true;
        element.style.cursor = 'grab';
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        space.current = false;
        element.style.cursor = '';
      }
    };
    const blur = () => {
      space.current = false;
      cancelGesture();
    };
    element.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);

    const background = document.createElement('canvas');
    let cachedKey = '',
      cachedScenario: Scenario | null = null,
      ratio = 1;
    const facing = new Map<string, Point>();
    let previousTick = -1,
      lastNow: number | null = null,
      lastAttributes = -Infinity;
    let previousGeneration = -1;
    let raf = 0;
    const diagnostics = {
      callbackIntervals: [] as number[],
      drawMs: [] as number[],
      drawCount: 0,
      bitmapResizes: 0,
      staticBuilds: 0,
      tick: 0,
      robots: [] as { id: string; x: number; y: number }[],
      buffered: 0,
    };
    Object.assign(element, { __warehouseDiagnostics: diagnostics });
    const record = (list: number[], value: number) => {
      list.push(value);
      if (list.length > 4096) list.shift();
    };
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const draw = (now: number) => {
      const started = performance.now();
      if (lastNow !== null) record(diagnostics.callbackIntervals, now - lastNow);
      lastNow = now;
      const p = current.current,
        v = view.current,
        sc = p.scenario;
      frame.current = p.store.sample(now, media.matches);
      const display = frame.current;
      if (gesture.current && !currentGesture(gesture.current)) cancelGesture();
      if (p.store.generation !== previousGeneration || (display && display.tick < previousTick))
        facing.clear();
      previousGeneration = p.store.generation;
      previousTick = display?.tick ?? 0;
      ratio = window.devicePixelRatio || 1;
      const bitmapWidth = Math.round(v.width * ratio),
        bitmapHeight = Math.round(v.height * ratio);
      if (element.width !== bitmapWidth || element.height !== bitmapHeight) {
        element.width = bitmapWidth;
        element.height = bitmapHeight;
        diagnostics.bitmapResizes++;
        cachedKey = '';
      }
      const ctx = element.getContext('2d')!;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const key = `${v.width},${v.height},${v.cell},${v.x},${v.y},${ratio}`;
      if (cachedKey !== key || cachedScenario !== sc) {
        background.width = bitmapWidth;
        background.height = bitmapHeight;
        const bg = background.getContext('2d')!;
        bg.setTransform(ratio, 0, 0, ratio, 0, 0);
        bg.fillStyle = '#272c2f';
        bg.fillRect(0, 0, v.width, v.height);
        bg.fillStyle = '#303639';
        bg.fillRect(v.x, v.y, sc.width * v.cell, sc.height * v.cell);
        if (v.cell >= 12) {
          bg.lineWidth = 1;
          bg.strokeStyle = '#3b4245';
          bg.beginPath();
          for (let x = 0; x <= sc.width; x++) {
            bg.moveTo(v.x + x * v.cell, v.y);
            bg.lineTo(v.x + x * v.cell, v.y + sc.height * v.cell);
          }
          for (let y = 0; y <= sc.height; y++) {
            bg.moveTo(v.x, v.y + y * v.cell);
            bg.lineTo(v.x + sc.width * v.cell, v.y + y * v.cell);
          }
          bg.stroke();
        }
        for (const obstacle of sc.obstacles) {
          const x = v.x + obstacle.x * v.cell,
            y = v.y + obstacle.y * v.cell;
          bg.fillStyle = '#596064';
          bg.fillRect(x + 1, y + 1, Math.max(1, v.cell - 2), Math.max(1, v.cell - 2));
          if (v.cell >= 16) {
            bg.strokeStyle = '#747b7e';
            bg.lineWidth = 1;
            bg.beginPath();
            bg.moveTo(x + 3, y + 3);
            bg.lineTo(x + v.cell - 3, y + 3);
            bg.stroke();
          }
        }
        if (v.cell >= 20) {
          bg.font = '11px ui-monospace, SFMono-Regular, monospace';
          bg.fillStyle = '#a0a8a8';
          bg.textAlign = 'center';
          for (let x = 0; x < sc.width; x++)
            bg.fillText(String(x), v.x + (x + 0.5) * v.cell, v.y - 8);
          bg.textAlign = 'right';
          for (let y = 0; y < sc.height; y++)
            bg.fillText(String(y), v.x - 8, v.y + (y + 0.5) * v.cell + 4);
        }
        cachedKey = key;
        cachedScenario = sc;
        diagnostics.staticBuilds++;
      }
      ctx.drawImage(background, 0, 0, bitmapWidth, bitmapHeight, 0, 0, v.width, v.height);
      const box = (point: Point, inset = 0): [number, number, number, number] => [
        v.x + point.x * v.cell + inset,
        v.y + point.y * v.cell + inset,
        v.cell - inset * 2,
        v.cell - inset * 2,
      ];
      const center = (point: Point) => worldToScreen(point, v);
      if (p.heatmap) {
        const values = p.store.details.heatmap,
          max = Math.max(1, ...Object.values(values));
        for (const [key, count] of Object.entries(values)) {
          const [x, y] = key.split(',').map(Number);
          ctx.fillStyle = `rgba(192,135,103,${Math.min(0.55, (count / max) * 0.55)})`;
          ctx.fillRect(...box({ x, y }, 1));
        }
      }
      // These dashed routes are optional future plans, distinct from executed-frame motion.
      if (!display?.sampled)
        for (const [id, path] of Object.entries(p.store.details.paths)) {
          const selected = sameSelection(p.selection, 'robot', id);
          if ((!selected && !p.showPaths) || !path.length) continue;
          ctx.strokeStyle = selected ? '#c0d6cd' : '#8ca39a';
          ctx.globalAlpha = selected ? 0.9 : 0.22;
          ctx.lineWidth = selected ? 2 : 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          let previous: Point | null = null;
          for (const point of path) {
            const at = center(point);
            if (!previous || Math.abs(previous.x - point.x) + Math.abs(previous.y - point.y) > 1)
              ctx.moveTo(at.x, at.y);
            else ctx.lineTo(at.x, at.y);
            previous = point;
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      const stations = new Map(display?.frame.stations.map((station) => [station.id, station]));
      for (const station of sc.stations) {
        const at = center(station.position),
          service = center(station.service),
          c = v.cell;
        const status = stations.get(station.id),
          color = ROLE_COLORS[station.role];
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.65;
        ctx.beginPath();
        ctx.moveTo(at.x, at.y);
        ctx.lineTo(service.x, service.y);
        ctx.stroke();
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(...box(station.service, c * 0.12));
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.strokeStyle = '#22292b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(...box(station.position, c * 0.09), Math.min(5, c * 0.15));
        ctx.fill();
        ctx.stroke();
        ctx.save();
        ctx.translate(at.x, at.y - c * 0.15);
        ctx.scale(c, c);
        ctx.strokeStyle = '#2d3939';
        ctx.fillStyle = '#2d3939';
        ctx.lineWidth = 0.055;
        if (station.role === 'supply') {
          ctx.beginPath();
          ctx.moveTo(-0.23, -0.17);
          ctx.lineTo(0.23, -0.17);
          ctx.lineTo(0.12, 0.1);
          ctx.lineTo(-0.12, 0.1);
          ctx.closePath();
          ctx.stroke();
          ctx.fillRect(-0.06, 0.12, 0.12, 0.08);
        } else if (station.role === 'process') {
          ctx.strokeRect(-0.21, -0.2, 0.42, 0.35);
          ctx.fillRect(-0.13, -0.24, 0.26, 0.1);
          ctx.fillRect(-0.14, 0.17, 0.28, 0.05);
          ctx.fillRect(-0.03, -0.05, 0.06, 0.16);
        } else if (station.role === 'assembly') {
          for (const [x, y] of [
            [-0.16, -0.12],
            [0.13, -0.12],
            [-0.015, 0.13],
          ]) {
            ctx.beginPath();
            ctx.arc(x, y, 0.085, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.moveTo(-0.1, -0.08);
          ctx.lineTo(0.07, -0.08);
          ctx.lineTo(-0.015, 0.05);
          ctx.closePath();
          ctx.stroke();
        } else {
          ctx.strokeRect(-0.22, -0.2, 0.44, 0.37);
          ctx.beginPath();
          ctx.moveTo(-0.16, 0);
          ctx.lineTo(0.16, 0);
          ctx.moveTo(0.04, -0.1);
          ctx.lineTo(0.16, 0);
          ctx.lineTo(0.04, 0.1);
          ctx.stroke();
        }
        ctx.restore();
        if (c >= 36 && !display?.sampled) {
          const quantity =
            Object.values(status?.input ?? {}).reduce((a, n) => a + n, 0) +
            Object.values(status?.output ?? {}).reduce((a, n) => a + n, 0);
          ctx.font = '12px ui-monospace, SFMono-Regular, monospace';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#253132';
          ctx.fillText(String(quantity), at.x, at.y + c * 0.3);
        }
        if (status?.processing) {
          const duration =
            sc.recipes.find((recipe) => recipe.id === status.processing!.recipeId)?.duration ?? 1;
          ctx.fillStyle = '#233d37';
          ctx.fillRect(
            at.x - c * 0.32,
            at.y + c * 0.34,
            c * 0.64 * Math.max(0, 1 - status.processing.remaining / duration),
            Math.max(2, c * 0.05),
          );
        }
        if (sameSelection(p.selection, 'station', station.id)) {
          ctx.strokeStyle = '#eef5ed';
          ctx.lineWidth = 2;
          ctx.strokeRect(...box(station.position, -2));
          ctx.lineWidth = 1;
          ctx.strokeRect(...box(station.service, 1));
        }
      }
      const activeIds = new Set(display?.robots.map((robot) => robot.id));
      for (const id of facing.keys()) if (!activeIds.has(id)) facing.delete(id);
      for (const robot of display?.robots ?? []) {
        const at = center(robot.position),
          c = v.cell,
          selected = sameSelection(p.selection, 'robot', robot.id);
        if (robot.direction && (robot.direction.x || robot.direction.y))
          facing.set(robot.id, robot.direction);
        const direction = facing.get(robot.id) ?? { x: 0, y: -1 };
        const angle = Math.atan2(direction.y, direction.x) + Math.PI / 2;
        ctx.save();
        ctx.translate(at.x, at.y);
        ctx.rotate(angle);
        ctx.fillStyle = '#141b1d';
        ctx.fillRect(-c * 0.28, -c * 0.23, c * 0.1, c * 0.46);
        ctx.fillRect(c * 0.18, -c * 0.23, c * 0.1, c * 0.46);
        ctx.fillStyle = '#e0e4df';
        ctx.strokeStyle = '#202a2b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(-c * 0.22, -c * 0.29, c * 0.44, c * 0.58, Math.min(5, c * 0.12));
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#506a61';
        ctx.beginPath();
        ctx.moveTo(0, -c * 0.24);
        ctx.lineTo(c * 0.09, -c * 0.13);
        ctx.lineTo(-c * 0.09, -c * 0.13);
        ctx.closePath();
        ctx.fill();
        if (robot.load) {
          ctx.fillStyle = '#bba783';
          ctx.strokeStyle = '#5d5140';
          ctx.lineWidth = 1;
          ctx.fillRect(-c * 0.13, -c * 0.045, c * 0.26, c * 0.24);
          ctx.strokeRect(-c * 0.13, -c * 0.045, c * 0.26, c * 0.24);
          ctx.beginPath();
          ctx.moveTo(0, -c * 0.045);
          ctx.lineTo(0, c * 0.195);
          ctx.stroke();
        } else {
          ctx.strokeStyle = '#a4aeaa';
          ctx.lineWidth = 1;
          ctx.strokeRect(-c * 0.12, -c * 0.02, c * 0.24, c * 0.2);
        }
        ctx.restore();
        ctx.fillStyle =
          robot.status === 'waiting'
            ? '#ccb186'
            : robot.status === 'loading' || robot.status === 'unloading'
              ? '#a7bac9'
              : '#87a89a';
        ctx.beginPath();
        ctx.arc(at.x + c * 0.25, at.y + c * 0.24, Math.max(2, c * 0.055), 0, Math.PI * 2);
        ctx.fill();
        if (selected) {
          ctx.strokeStyle = '#edf6ed';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(
            at.x - c * 0.38,
            at.y - c * 0.39,
            c * 0.76,
            c * 0.78,
            Math.min(6, c * 0.12),
          );
          ctx.stroke();
        }
        if ((selected || p.editing) && c >= 24) {
          ctx.font = '12px ui-monospace, SFMono-Regular, monospace';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#e7eee8';
          ctx.fillText(robot.id, at.x, at.y - c * 0.47);
        }
      }
      if (p.selection?.kind === 'cell') {
        ctx.strokeStyle = '#c5dacf';
        ctx.lineWidth = 2;
        ctx.strokeRect(...box(p.selection.position, 1));
      }
      const action = preview.current;
      if (p.editing && action) {
        const color = previewError.current ? '#cf968d' : '#a7c6b4';
        ctx.fillStyle = previewError.current ? 'rgba(180,95,84,.36)' : 'rgba(147,190,164,.32)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        const points = action.type === 'paint' ? action.cells : [action.point];
        for (const point of points) {
          ctx.fillRect(...box(point, 1));
          ctx.strokeRect(...box(point, 1));
        }
        if (action.type === 'move' && action.selection.kind === 'station') {
          const station = sc.stations.find((station) => station.id === action.selection.id);
          if (station) {
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(
              ...box(
                {
                  x: action.point.x + station.service.x - station.position.x,
                  y: action.point.y + station.service.y - station.position.y,
                },
                2,
              ),
            );
            ctx.setLineDash([]);
          }
        }
        if (previewError.current) {
          ctx.font = '12px system-ui, sans-serif';
          ctx.textAlign = 'left';
          const message = previewError.current.slice(0, 110),
            width = Math.min(v.width - 24, ctx.measureText(message).width + 20);
          ctx.fillStyle = '#303639';
          ctx.fillRect(12, v.height - 36, width, 25);
          ctx.fillStyle = '#efd2cb';
          ctx.fillText(message, 22, v.height - 19, Math.max(0, width - 20));
        }
      } else if (hover.current && inside(hover.current)) {
        ctx.strokeStyle = '#788f83';
        ctx.lineWidth = 1;
        ctx.strokeRect(...box(hover.current, 1));
      }
      diagnostics.drawCount++;
      diagnostics.tick = display?.tick ?? 0;
      diagnostics.robots = (display?.robots ?? []).map((robot) => ({
        id: robot.id,
        x: robot.position.x,
        y: robot.position.y,
      }));
      diagnostics.buffered = p.store.buffered;
      record(diagnostics.drawMs, performance.now() - started);
      if (now - lastAttributes >= 200) {
        lastAttributes = now;
        element.dataset.cellSize = String(v.cell);
        element.dataset.offsetX = String(v.x);
        element.dataset.offsetY = String(v.y);
        element.dataset.displayTick = String(display?.tick ?? 0);
        element.dataset.drawCount = String(diagnostics.drawCount);
        element.dataset.sampled = String(display?.sampled ?? false);
        element.dataset.robotPositions = JSON.stringify(diagnostics.robots);
        p.onDisplayTick?.(Math.floor(display?.tick ?? 0));
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const local = localPoint(event),
      point = screenToCell(local, view.current),
      p = current.current;
    event.currentTarget.setPointerCapture(event.pointerId);
    const base: Gesture = {
      pointerId: event.pointerId,
      scenario: p.scenario,
      tool: p.tool,
      generation: p.store.generation,
      kind: 'pan',
      start: local,
      last: point,
      view: { ...view.current },
      cells: new Map(),
    };
    if (event.button === 1 || space.current || p.tool === 'pan') {
      automaticFit.current = false;
      gesture.current = base;
      return;
    }
    if (p.tool === 'select' || !p.editing) {
      p.onSelect(hit(local));
      return;
    }
    if (p.tool === 'move') {
      const target = hit(local);
      const selection =
        target?.kind === 'station' || target?.kind === 'robot' ? target : p.selection;
      if (!selection || selection.kind === 'cell') return;
      const object =
        selection.kind === 'robot'
          ? p.scenario.robots.find((robot) => robot.id === selection.id)
          : p.scenario.stations.find((station) => station.id === selection.id);
      if (!object) return;
      p.onSelect(selection);
      base.kind = 'move';
      base.origin = object.position;
      base.start = point;
      base.action = { type: 'move', selection, point: object.position };
    } else if (p.tool === 'obstacle' || p.tool === 'erase') {
      base.kind = 'paint';
      if (inside(point)) base.cells.set(pointKey(point), point);
      base.action = { type: 'paint', tool: p.tool, cells: [...base.cells.values()] };
    } else {
      base.kind = 'place';
      base.action = { type: 'place', tool: p.tool, point };
    }
    gesture.current = base;
    updatePreview(base.action ?? null);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const local = localPoint(event),
      point = screenToCell(local, view.current),
      g = gesture.current,
      p = current.current;
    hover.current = point;
    if (g && !currentGesture(g)) {
      cancelGesture();
      return;
    }
    if (!g) {
      if (p.editing && p.tool !== 'select' && p.tool !== 'move' && p.tool !== 'pan')
        updatePreview(
          p.tool === 'obstacle' || p.tool === 'erase'
            ? { type: 'paint', tool: p.tool, cells: inside(point) ? [point] : [] }
            : { type: 'place', tool: p.tool, point },
        );
      return;
    }
    if (g.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (g.kind === 'pan') {
      view.current = {
        ...g.view,
        x: g.view.x + local.x - g.start.x,
        y: g.view.y + local.y - g.start.y,
      };
      return;
    }
    if (g.kind === 'paint' && g.action?.type === 'paint') {
      const samples = [...(event.nativeEvent.getCoalescedEvents?.() ?? []), event];
      for (const sample of samples) {
        const sampleCell = screenToCell(localPoint(sample), view.current);
        for (const cell of rasterizeStroke(g.last, sampleCell))
          if (inside(cell)) g.cells.set(pointKey(cell), cell);
        g.last = sampleCell;
      }
      g.action = { ...g.action, cells: [...g.cells.values()] };
    } else if (g.kind === 'move' && g.action?.type === 'move' && g.origin) {
      g.action = {
        ...g.action,
        point: { x: g.origin.x + point.x - g.start.x, y: g.origin.y + point.y - g.start.y },
      };
    } else if (g.action?.type === 'place') g.action = { ...g.action, point };
    g.last = point;
    updatePreview(g.action ?? null);
  };
  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (g?.pointerId === event.pointerId) {
      if (!currentGesture(g)) {
        cancelGesture();
        return;
      }
      // Include the final pointer position even if the browser coalesced its last move.
      pointerMove(event);
      gesture.current = null;
      updatePreview(null);
      if (g.action && (g.action.type !== 'paint' || g.action.cells.length))
        current.current.onEdit(g.action);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div ref={host} className="canvas-host">
      <canvas
        ref={canvas}
        data-testid="factory-map"
        data-map-width={props.scenario.width}
        data-map-height={props.scenario.height}
        aria-label={`Factory map, ${props.scenario.width} by ${props.scenario.height} cells. ${props.editing ? 'Editing initial layout.' : 'Executed robot motion.'} Scroll to zoom, middle drag or Space drag to pan. Select objects on the map or in the inspector.`}
        className={props.editing ? 'editing' : ''}
        tabIndex={0}
        style={{
          touchAction: 'none',
          userSelect: 'none',
          cursor:
            props.tool === 'pan'
              ? 'grab'
              : props.tool === 'move'
                ? 'move'
                : props.editing && props.tool !== 'select'
                  ? 'crosshair'
                  : 'default',
        }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={cancelGesture}
        onPointerEnter={() => {
          pointerInside.current = true;
        }}
        onPointerLeave={() => {
          pointerInside.current = false;
          hover.current = null;
          if (!gesture.current) updatePreview(null);
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
    </div>
  );
}
