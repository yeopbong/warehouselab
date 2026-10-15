import { useEffect, useRef, useState } from 'react';
import { fitViewport, screenToCell, zoomAt, type Viewport } from '../ui/viewport';
import type { SortingScenario } from './types';

export interface MapRobot {
  id: string | number;
  cell: number;
  goal?: number | null;
  packageId?: string | number | null;
}

interface Props {
  scenario: SortingScenario;
  mapping: string[];
  selectedDestination: string;
  selectedChute: number | null;
  changed?: number[];
  robots?: MapRobot[];
  closedChutes?: number[];
  selectedRobot?: string | number | null;
  onChute?: (index: number) => void;
  onRobot?: (id: string | number) => void;
  label?: string;
}

export default function SortingMap(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<Viewport>({ width: 600, height: 420, x: 0, y: 0, cell: 8 });
  const current = useRef(props);
  current.current = props;
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; original: Viewport; moved: boolean } | null>(null);
  const fit = () =>
    setView((old) =>
      fitViewport(old.width, old.height, props.scenario.map.width, props.scenario.map.height),
    );

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setView(
        fitViewport(
          width,
          height,
          current.current.scenario.map.width,
          current.current.scenario.map.height,
        ),
      );
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(fit, [props.scenario.map.id, props.scenario.map.width, props.scenario.map.height]);

  useEffect(() => {
    const element = canvas.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      setView((old) =>
        zoomAt(
          old,
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          event.deltaY < 0 ? 1.14 : 1 / 1.14,
        ),
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(view.width * ratio);
    element.height = Math.round(view.height * ratio);
    const ctx = element.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#eef1eb';
    ctx.fillRect(0, 0, view.width, view.height);
    const { width, height, layout, chutes, workstations } = props.scenario.map;
    const cellRect = (x: number, y: number, inset = 0) =>
      [
        view.x + x * view.cell + inset,
        view.y + y * view.cell + inset,
        view.cell - inset * 2,
        view.cell - inset * 2,
      ] as const;
    ctx.fillStyle = '#fafbf7';
    ctx.fillRect(view.x, view.y, width * view.cell, height * view.cell);
    ctx.fillStyle = '#d7ddd4';
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const character = layout[y]?.[x];
        if (character && '#@T'.includes(character)) ctx.fillRect(...cellRect(x, y));
      }
    if (view.cell >= 13) {
      ctx.strokeStyle = '#e9ede5';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let x = 0; x <= width; x++) {
        ctx.moveTo(view.x + x * view.cell, view.y);
        ctx.lineTo(view.x + x * view.cell, view.y + height * view.cell);
      }
      for (let y = 0; y <= height; y++) {
        ctx.moveTo(view.x, view.y + y * view.cell);
        ctx.lineTo(view.x + width * view.cell, view.y + y * view.cell);
      }
      ctx.stroke();
    }
    const closed = new Set(props.closedChutes ?? []);
    const changes = new Set(props.changed ?? []);
    const inset = Math.min(1.5, view.cell * 0.12);
    for (let index = 0; index < chutes.length; index++) {
      const chute = chutes[index];
      const selected = props.mapping[index] === props.selectedDestination;
      ctx.fillStyle = closed.has(index) ? '#bc6248' : selected ? '#398777' : '#bbc9bf';
      ctx.fillRect(...cellRect(chute.x, chute.y, inset));
      if (changes.has(index) || props.selectedChute === index) {
        ctx.strokeStyle = props.selectedChute === index ? '#162f28' : '#c89135';
        ctx.lineWidth = props.selectedChute === index ? 2.5 : 2;
        ctx.strokeRect(...cellRect(chute.x, chute.y, -1));
      }
    }
    for (const station of workstations) {
      ctx.fillStyle = '#8e9fb3';
      ctx.fillRect(...cellRect(station.x, station.y, inset));
    }
    const selectedRobot = (props.robots ?? []).find((robot) => robot.id === props.selectedRobot);
    if (selectedRobot?.goal != null && selectedRobot.goal >= 0) {
      const a = selectedRobot.cell,
        b = selectedRobot.goal;
      ctx.strokeStyle = '#1e667b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(
        view.x + ((a % width) + 0.5) * view.cell,
        view.y + (Math.floor(a / width) + 0.5) * view.cell,
      );
      ctx.lineTo(
        view.x + ((b % width) + 0.5) * view.cell,
        view.y + (Math.floor(b / width) + 0.5) * view.cell,
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const robot of props.robots ?? []) {
      if (robot.cell < 0) continue;
      ctx.fillStyle = robot.id === props.selectedRobot ? '#da823d' : '#263f48';
      ctx.beginPath();
      ctx.arc(
        view.x + ((robot.cell % width) + 0.5) * view.cell,
        view.y + (Math.floor(robot.cell / width) + 0.5) * view.cell,
        Math.max(1.5, view.cell * 0.27),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }, [props, view]);

  return (
    <div className="sorting-map-wrap">
      <div className="sorting-map" ref={host}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={props.label ?? 'Destination-to-chute mapping'}
          data-testid="sorting-map"
          onPointerDown={(event) => {
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              original: viewRef.current,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start) return;
            const dx = event.clientX - start.x,
              dy = event.clientY - start.y;
            if (Math.hypot(dx, dy) > 4) start.moved = true;
            if (start.moved)
              setView({ ...start.original, x: start.original.x + dx, y: start.original.y + dy });
          }}
          onPointerUp={(event) => {
            const start = drag.current;
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            if (!start || start.moved) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const point = screenToCell(
              { x: event.clientX - rect.left, y: event.clientY - rect.top },
              viewRef.current,
            );
            if (
              point.x < 0 ||
              point.y < 0 ||
              point.x >= props.scenario.map.width ||
              point.y >= props.scenario.map.height
            )
              return;
            const cell = point.y * props.scenario.map.width + point.x;
            const robot = props.robots?.find((value) => value.cell === cell);
            if (robot && props.onRobot) {
              props.onRobot(robot.id);
              return;
            }
            const index = props.scenario.map.chutes.findIndex((chute) => chute.cell === cell);
            if (index >= 0) props.onChute?.(index);
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        />
        <div className="sorting-map-tools">
          <button
            onClick={() =>
              setView((old) => zoomAt(old, { x: old.width / 2, y: old.height / 2 }, 1.35))
            }
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            onClick={() =>
              setView((old) => zoomAt(old, { x: old.width / 2, y: old.height / 2 }, 1 / 1.35))
            }
            aria-label="Zoom out"
          >
            −
          </button>
          <button onClick={fit}>Fit</button>
        </div>
      </div>
      <div className="sorting-map-legend">
        <span>
          <i className="selected" /> Selected destination
        </span>
        <span>
          <i /> Other chutes
        </span>
        <span>
          <i className="closed" /> Closed
        </span>
        <span>
          <i className="station" /> Workstation
        </span>
        <span>
          <i className="changed" /> Changed
        </span>
        <span className="map-hint">Drag to pan · scroll to zoom</span>
      </div>
    </div>
  );
}
