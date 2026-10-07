// PCB layer stacking and default visibility for the 2D view.

/**
 * Distance of a layer from a viewer looking at the top side (larger = farther).
 * Layers are drawn farthest first. Bottom-side view mirrors the copper stack.
 */
function depth(name: string, flipped: boolean): number {
  if (name === 'Edge.Cuts') return -100;
  const inner = /^In(\d+)\.Cu$/.exec(name);
  let d: number;
  if (inner) d = 10 + parseInt(inner[1], 10);
  else if (name.startsWith('F.')) d = FRONT_ORDER[name.slice(2)] ?? 5;
  else if (name.startsWith('B.')) d = 200 - (FRONT_ORDER[name.slice(2)] ?? 5);
  else return -50; // User/drawing layers above everything but the board outline.
  return flipped ? 200 - d : d;
}

// Within one side: fabrication on top, copper at the bottom.
const FRONT_ORDER: Record<string, number> = {
  Fab: 0,
  CrtYd: 1,
  SilkS: 2,
  Paste: 3,
  Mask: 4,
  Adhes: 4.5,
  Cu: 9,
};

export function stackOrder(names: string[], flipped: boolean): string[] {
  return [...names].sort((a, b) => depth(b, flipped) - depth(a, flipped));
}

export function defaultVisible(name: string): boolean {
  return /\.Cu$/.test(name) || /\.SilkS$/.test(name) || name === 'Edge.Cuts';
}

export function defaultOpacity(name: string): number {
  if (/\.Cu$/.test(name)) return 0.85;
  if (/\.Mask$/.test(name)) return 0.5;
  return 1;
}
