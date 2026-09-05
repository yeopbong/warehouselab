import type { Point } from '../core/model/types';

export interface Viewport {
  width: number;
  height: number;
  cell: number;
  x: number;
  y: number;
}

export function fitViewport(
  width: number,
  height: number,
  columns: number,
  rows: number,
): Viewport {
  const cell = Math.max(2, Math.min((width - 48) / columns, (height - 48) / rows));
  return { width, height, cell, x: (width - columns * cell) / 2, y: (height - rows * cell) / 2 };
}
export function worldToScreen(point: Point, view: Viewport): Point {
  return { x: view.x + (point.x + 0.5) * view.cell, y: view.y + (point.y + 0.5) * view.cell };
}
export function screenToWorld(point: Point, view: Viewport): Point {
  return { x: (point.x - view.x) / view.cell, y: (point.y - view.y) / view.cell };
}
export function screenToCell(point: Point, view: Viewport): Point {
  const world = screenToWorld(point, view);
  return { x: Math.floor(world.x), y: Math.floor(world.y) };
}
export function zoomAt(view: Viewport, point: Point, factor: number): Viewport {
  const world = screenToWorld(point, view);
  const cell = Math.max(5, Math.min(160, view.cell * factor));
  return { ...view, cell, x: point.x - world.x * cell, y: point.y - world.y * cell };
}
/** Supercover cell traversal includes every crossed tile and bridges diagonal corner crossings. */
export function rasterizeStroke(from: Point, to: Point): Point[] {
  const points: Point[] = [{ ...from }];
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const nx = Math.abs(dx),
    ny = Math.abs(dy),
    sx = Math.sign(dx),
    sy = Math.sign(dy);
  let x = from.x,
    y = from.y,
    ix = 0,
    iy = 0;
  while (ix < nx || iy < ny) {
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision === 0) {
      if (ix < nx) points.push({ x: x + sx, y });
      if (iy < ny) points.push({ x, y: y + sy });
      x += sx;
      y += sy;
      ix++;
      iy++;
    } else if (decision < 0) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    points.push({ x, y });
  }
  return [...new Map(points.map((point) => [`${point.x},${point.y}`, point])).values()];
}
