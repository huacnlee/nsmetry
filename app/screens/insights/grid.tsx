/**
 * A responsive grid of panels by the width the screen actually has (not the window: the sidebar
 * takes its share), so two panels sit side by side on a desktop and stack on a phone. Columns are
 * as many as fit `min` points each; a cell may `span` the whole row.
 *
 * Built on measured widths because flex-wrap with percentage widths and a gap overflows by the gap.
 */
import type { JSX } from "nsh";
import { context, signal, View } from "nsh";

const GAP = 16;
const Width = context<() => { cols: number; col: number | undefined; full: number | undefined }>(() => ({ cols: 1, col: undefined, full: undefined }));

export function Grid(props: { min: number; children?: JSX.Element; testID?: string }) {
  const w = signal(0);
  const geometry = () => {
    const width = w();
    if (width <= 0) return { cols: 1, col: undefined, full: undefined };
    const cols = Math.max(1, Math.floor((width + GAP) / (props.min + GAP)));
    return { cols, col: (width - GAP * (cols - 1)) / cols, full: width };
  };
  return (
    <Width.Provider value={geometry}>
      <View testID={props.testID} class="flex-row flex-wrap gap-4" onLayout={(e) => w.set(Math.floor(e.bounds.size.width))}>
        {props.children}
      </View>
    </Width.Provider>
  );
}

export function Cell(props: { span?: boolean; children?: JSX.Element }) {
  const g = Width();
  const width = () => {
    const x = g();
    return (props.span ? x.full : x.col) ?? "100%";
  };
  return <View style={{ width: width() }}>{props.children}</View>;
}

/** The number of columns the nearest grid has now (tiles use it to choose their own wrap). */
export function useColumns(): () => number {
  const g = Width();
  return () => g().cols;
}
