/**
 * A world choropleth on NSH's `Canvas`: each country filled with the brand color at an opacity that
 * grows with its value (square-root scale, so one huge country does not wash every other one out to
 * nothing), countries without data on the hover wash, hairline borders in the page color. The
 * shapes are the Worker's `/api/world.json` (SVG path data in the map's own coordinates), parsed
 * once natively through `Path2D` and kept per map.
 *
 * Interaction: hovering a country outlines it and names it in the caption under the map; pressing
 * one calls `onSelect` (the screens add it as a filter). The map is a picture for screen readers
 * (`role="image"` with a summary label): the keyboard path to the same countries is the list the
 * screen shows beside it, which is why the map has no focus stops of its own.
 *
 * Motion: none on purpose. The map is drawn at once when it loads; the hover outline follows the
 * pointer without lag (a pointer-follow, which an easing would only make feel late).
 *
 * Two canvases, so hovering never repaints the map: the base layer (fills and borders) draws only
 * when the values, the selection, the appearance or the size change; the overlay above it draws just
 * the hovered outline. Hit testing first checks each country's bounding box, so a pointer move runs
 * `isPointInPath` on the one or two countries actually under it rather than on ~200. The map is
 * fitted to the land's own bounding box, not the projection's frame, so it fills the card.
 */
import { Canvas, type CanvasRenderingContext2D, Path2D, signal, token, View } from "nsh";
import { Txt } from "./text";
import { size } from "./tokens";

export interface WorldShapes {
  width: number;
  height: number;
  /** ISO 3166-1 alpha-2 → SVG path data. */
  countries: Record<string, string>;
}

interface Shape {
  code: string;
  path: Path2D;
  /** Bounding box in map coordinates: [minX, minY, maxX, maxY]. */
  box: [number, number, number, number];
}
interface Parsed {
  shapes: Shape[];
  byCode: Map<string, Shape>;
  /** The land's bounding box, what the map is fitted to. */
  bounds: [number, number, number, number];
}

/** Parsed paths and bounds, per map object: parsing ~200 outlines on every redraw would be wasted work. */
const parsed = new WeakMap<WorldShapes, Parsed>();
function parse(map: WorldShapes): Parsed {
  let p = parsed.get(map);
  if (p) return p;
  const shapes: Shape[] = [];
  const all: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [code, d] of Object.entries(map.countries)) {
    // The outlines are absolute M/L/Z commands (scripts/build-map.mjs), so the numbers are x,y pairs.
    const n = d.match(/-?\d+(?:\.\d+)?/g) ?? [];
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 1 < n.length; i += 2) {
      const x = Number(n[i]);
      const y = Number(n[i + 1]);
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    }
    if (box[0] === Infinity) continue;
    shapes.push({ code, path: new Path2D(d), box });
    all[0] = Math.min(all[0], box[0]);
    all[1] = Math.min(all[1], box[1]);
    all[2] = Math.max(all[2], box[2]);
    all[3] = Math.max(all[3], box[3]);
  }
  if (all[0] === Infinity) all.splice(0, 4, 0, 0, map.width, map.height);
  p = { shapes, byCode: new Map(shapes.map((sh) => [sh.code, sh])), bounds: all };
  parsed.set(map, p);
  return p;
}

/** Where the map sits in a canvas of this size: scale, then the offset of the bounds' top-left. */
function fitOf(p: Parsed, area: { width: number; height: number }) {
  const [x0, y0, x1, y1] = p.bounds;
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const s = Math.min(area.width / w, area.height / h);
  return { s, ox: (area.width - w * s) / 2 - x0 * s, oy: (area.height - h * s) / 2 - y0 * s };
}

/** The opacity of a country's fill for its value: a floor so the smallest still reads as "some". */
export function choroplethAlpha(value: number, max: number): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return 0.18 + 0.82 * Math.sqrt(Math.min(1, value / max));
}

export function WorldMap(props: {
  map: WorldShapes;
  /** Value by country code (upper case). */
  values: Record<string, number>;
  /** The country drawn with the strong outline (the current filter). */
  selected?: string | null;
  onSelect?: (code: string) => void;
  /** A code's display name, for the caption. */
  name: (code: string) => string;
  /** A value's text, for the caption ("1,204 visitors"). */
  format: (value: number) => string;
  accessibilityLabel: string;
  /** A hint while nothing is hovered ("Press a country to filter by it"). */
  hint?: string;
  testID?: string;
}) {
  const hovered = signal<string | null>(null);
  // The fit of the map into the canvas, kept from the last draw so pointer positions map back.
  let fit = { s: 1, ox: 0, oy: 0 };
  let hitCtx: CanvasRenderingContext2D | undefined;

  const max = () => Math.max(0, ...Object.values(props.values));
  const hit = (x: number, y: number): string | null => {
    if (!hitCtx) return null;
    const mx = (x - fit.ox) / fit.s;
    const my = (y - fit.oy) / fit.s;
    for (const sh of parse(props.map).shapes) {
      const b = sh.box;
      if (mx < b[0] || mx > b[2] || my < b[1] || my > b[3]) continue;
      if (hitCtx.isPointInPath(sh.path, mx, my)) return sh.code;
    }
    return null;
  };
  const hover = (code: string | null) => {
    if (code !== hovered()) hovered.set(code);
  };

  /** The base layer: reads values, selection and theme, never `hovered`, so hovering leaves it alone. */
  const drawBase = (cx: CanvasRenderingContext2D, area: { width: number; height: number }) => {
    const p = parse(props.map);
    const f = fitOf(p, area);
    fit = f;
    const top = max();
    const values = props.values;
    const sel = props.selected ?? null;
    // Colors are read through `token()`, so the drawing follows the appearance (it is reactive).
    const brand = token("brand");
    const empty = token("hover");
    const edge = token("background");
    cx.save();
    cx.translate(f.ox, f.oy);
    cx.scale(f.s, f.s);
    cx.lineJoin = "round";
    cx.strokeStyle = edge;
    cx.lineWidth = 0.6 / f.s;
    for (const sh of p.shapes) {
      const a = choroplethAlpha(values[sh.code] ?? 0, top);
      if (a === 0) {
        cx.globalAlpha = 1;
        cx.fillStyle = empty;
      } else {
        cx.globalAlpha = a;
        cx.fillStyle = brand;
      }
      cx.fill(sh.path);
      cx.globalAlpha = 1;
      cx.stroke(sh.path);
    }
    // The selection outline last, so neighbors never paint over it.
    const selected = sel ? p.byCode.get(sel) : undefined;
    if (selected) {
      cx.strokeStyle = token("brand-strong");
      cx.lineWidth = 1.75 / f.s;
      cx.stroke(selected.path);
    }
    cx.restore();
  };

  /** The overlay: only the hovered outline, cheap to redraw on every pointer move. */
  const drawHover = (cx: CanvasRenderingContext2D, area: { width: number; height: number }) => {
    hitCtx = cx;
    const p = parse(props.map);
    const f = fitOf(p, area);
    fit = f;
    const hot = hovered();
    const shape = hot && hot !== (props.selected ?? null) ? p.byCode.get(hot) : undefined;
    if (!shape) return;
    cx.save();
    cx.translate(f.ox, f.oy);
    cx.scale(f.s, f.s);
    cx.lineJoin = "round";
    cx.strokeStyle = token("foreground");
    cx.lineWidth = 1.25 / f.s;
    cx.stroke(shape.path);
    cx.restore();
  };

  const aspect = () => {
    const [x0, y0, x1, y1] = parse(props.map).bounds;
    return Math.max(1, x1 - x0) / Math.max(1, y1 - y0);
  };

  const caption = () => {
    const c = hovered() ?? props.selected ?? null;
    if (!c) return props.hint ?? "";
    return `${props.name(c)} · ${props.format(props.values[c] ?? 0)}`;
  };

  return (
    <View testID={props.testID} class="gap-2">
      <View class="w-full" style={{ aspectRatio: aspect() }}>
        <Canvas class="flex-1" draw={drawBase} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        <Canvas
          testID={props.testID ? `${props.testID}-canvas` : undefined}
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
          role="image"
          accessibilityLabel={props.accessibilityLabel}
          draw={drawHover}
          onMouseMove={(e) => hover(hit(e.position.x, e.position.y))}
          onMouseLeave={() => hover(null)}
          onPress={(e) => {
            const c = hit(e.position.x, e.position.y);
            if (c) props.onSelect?.(c);
          }}
        />
      </View>
      <View class="flex-row items-center gap-3" style={{ minHeight: size.tag }}>
        <View class="flex-1">
          <Txt size="caption" tone={hovered() || props.selected ? "soft" : "faint"} truncate numeric>{caption()}</Txt>
        </View>
        <MapLegend />
      </View>
    </View>
  );
}

/** "Fewer ▮▮▮▮ More": the fill ramp the map uses, in the same alphas. */
function MapLegend() {
  const steps = [0.25, 0.5, 0.75, 1];
  return (
    <View class="flex-row items-center gap-1.5" accessibilityLabel="Fewer to more visitors">
      <Txt size="micro" tone="faint">Fewer</Txt>
      <View class="flex-row gap-0.5">
        <Each of={steps}>
          {(t) => <View class="h-2 w-3 rounded-(--radius-sm) bg-brand" style={{ opacity: choroplethAlpha(t(), 1) }} />}
        </Each>
      </View>
      <Txt size="micro" tone="faint">More</Txt>
    </View>
  );
}
