// Charts. Every response-time chart is drawn the same way: a blue line with a light fill under it,
// broken where a check was missed, on a scale sized to the usual values so a rare slow reply doesn't
// flatten it. Hovering any chart shows the value under the pointer.
import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { hideTip, showTip } from './ui';

const N = 90;  // samples on a response-time axis (a sample every 2-4 s)

type Series = (number | null)[];
type Pt = [number, number];

/** Width and height of an element, kept up to date (charts draw in real pixels for crisp lines). */
export function useSize<T extends Element>(): [RefObject<T>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]));
    ro.observe(el);
    setSize([el.clientWidth, el.clientHeight]);
    return () => ro.disconnect();
  }, []);
  return [ref, size[0], size[1]];
}

/** Top of a response-time scale: the usual values (90th percentile) with room above. */
export function latTop(data: Series, steps = [25, 50, 100, 200, 500, 1000, 2000, 5000]): number {
  const vals = data.filter((v): v is number => v != null).sort((a, b) => a - b);
  const p90 = vals.length ? vals[Math.floor(vals.length * .9)] : 1;
  return steps.find(x => x >= p90 * 1.4) || steps[steps.length - 1];
}

/** A device that misses one or two checks is still on, just slow to answer (Wi-Fi power saving does this):
 *  draw those as a spike to the top rather than a break. Longer gaps stay gaps: the device was gone. */
function blipsAsSpikes(data: Series, top: number): Series {
  const out = data.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) continue;
    let j = i;
    while (j < out.length && out[j] == null) j++;
    if (i > 0 && j < out.length && j - i <= 2) for (let k = i; k < j; k++) out[k] = top;
    i = j;
  }
  return out;
}

/** Splits a series into runs without gaps, as points. */
function segmentsOf(data: Series, xy: (v: number, i: number) => Pt): Pt[][] {
  const segs: Pt[][] = [[]];
  data.forEach((v, i) => { if (v == null) { if (segs[segs.length - 1].length) segs.push([]); } else segs[segs.length - 1].push(xy(v, i)); });
  return segs.filter(s => s.length);
}

function LineWithFill({ segs, base, col }: { segs: Pt[][]; base: number; col: string }) {
  return <>{segs.map((seg, k) => {
    const d = seg.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join('');
    return <g key={k}>
      <path d={`${d} L${seg[seg.length - 1][0].toFixed(1)} ${base} L${seg[0][0].toFixed(1)} ${base}Z`} fill={col} opacity=".12" />
      <path d={d} fill="none" stroke={col} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </g>;
  })}</>;
}

/** Index of the sample under the mouse on a right-aligned axis (the series grows in from the right). */
function hoverIndex(e: MouseEvent, len: number, inset = 0): number {
  const r = (e.currentTarget as SVGElement).getBoundingClientRect();
  const right = r.width - inset, step = (right - inset) / (N - 1), off = right - (len - 1) * step;
  return Math.round((e.clientX - r.left - off) / step);
}

function hoverProps(data: Series, label: string, unit: string, inset = 0): JSX.SVGAttributes<SVGSVGElement> {
  return {
    onMouseMove: (e: MouseEvent) => {
      const i = hoverIndex(e, data.length, inset);
      const v = data[i];
      if (i < 0 || i >= data.length) hideTip();
      else if (v != null) showTip(e, `${label}: ${Math.round(v)}${unit}`);
      else if (data.slice(0, i).some(x => x != null)) showTip(e, `${label}: no answer`);  // not before the history starts
      else hideTip();
    },
    onMouseLeave: hideTip,
  };
}

/** The card's response-time line: the big chart in miniature (no scale). */
export function Spark({ data }: { data: Series }) {
  const [ref, w, h] = useSize<SVGSVGElement>();
  const pad = 3, top = latTop(data), step = w / (N - 1), off = w - (data.length - 1) * step;
  return (
    <svg ref={ref} class="spark" viewBox={`0 0 ${w || 300} ${h || 30}`} preserveAspectRatio="none" aria-label="Response time, last 3 minutes"
         {...hoverProps(data, 'Response', ' ms')}>
      {w > 0 && <LineWithFill segs={segmentsOf(blipsAsSpikes(data, top), (v, i) => [off + i * step, h - pad - Math.min(v, top) / top * (h - 2 * pad)])} base={h} col="var(--blue)" />}
    </svg>
  );
}

/** Internet response time in the top bar: hover shows the value with a marker. */
export function NetChart({ data, ok }: { data: Series; ok: boolean }) {
  const [ref, w, h] = useSize<SVGSVGElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = 7, right = w - pad;
  const top = latTop(data, [20, 50, 100, 200, 500, 1000, 2000]);
  const step = (right - pad) / (N - 1), off = right - (data.length - 1) * step;
  const y = (v: number) => h - pad - Math.min(v, top) / top * (h - 2 * pad);
  const col = ok ? 'var(--blue)' : 'var(--red)';
  const segs = segmentsOf(data, (v, i) => [off + i * step, y(v)]);
  const lastPt = segs.length ? segs[segs.length - 1][segs[segs.length - 1].length - 1] : null;
  // Until the history fills up, the empty left part is a faint dotted line, so the chart spans the bar.
  const first = data.findIndex(v => v != null);
  const startX = first < 0 ? right : off + first * step;
  const hv = hover != null ? data[hover] : null;
  return (
    <svg ref={ref} class="net-chart" viewBox={`0 0 ${w || 300} ${h || 38}`} preserveAspectRatio="none" role="img" aria-label="Response time to the internet"
         onMouseMove={e => { const i = hoverIndex(e, data.length, pad); setHover(i >= 0 && i < data.length && data[i] != null ? i : null); }}
         onMouseLeave={() => setHover(null)}>
      {w > 0 && <>
        {startX - pad > 2 && <line x1={pad} x2={startX.toFixed(1)} y1={(first < 0 ? h / 2 : y(data[first]!)).toFixed(1)} y2={(first < 0 ? h / 2 : y(data[first]!)).toFixed(1)}
                                   stroke="var(--dim)" stroke-width="1.5" stroke-dasharray="2 5" stroke-linecap="round" />}
        <LineWithFill segs={segs} base={h - pad} col={col} />
        {hv != null ? (() => {
          const hx = off + hover! * step, flip = hx > w - 60;
          return <>
            <text x={flip ? hx - 8 : hx + 8} y="11" text-anchor={flip ? 'end' : 'start'} fill="var(--text)" font-size="11" font-weight="600">{Math.round(hv)} ms</text>
            <line x1={hx} x2={hx} y1="0" y2={h} stroke="var(--muted)" stroke-width="1" />
            <circle cx={hx} cy={y(hv)} r="4" fill={col} stroke="var(--bg)" stroke-width="2" />
          </>;
        })() : lastPt && <circle cx={lastPt[0]} cy={lastPt[1]} r="4" fill={col} stroke="var(--bg)" stroke-width="2" />}
      </>}
    </svg>
  );
}

/** Response time with a readable scale: ms gridlines (labelled on the left, away from the newest data),
 *  rare spikes clipped and marked. */
export function BigLatChart({ data }: { data: Series }) {
  const [ref, w, h] = useSize<SVGSVGElement>();
  const pad = 3, top = latTop(data), step = w / (N - 1), off = w - (data.length - 1) * step;
  const y = (v: number) => h - pad - Math.min(v, top) / top * (h - 2 * pad);
  const first = data.findIndex(v => v != null);
  const startX = first < 0 ? w : off + first * step;
  return (
    <svg ref={ref} viewBox={`0 0 ${w || 600} ${h || 150}`} preserveAspectRatio="none" aria-label="Response time, last 3 minutes"
         {...hoverProps(data, 'Response', ' ms')}>
      {w > 0 && <>
        {[0, .5, 1].map(f => {
          const gy = pad + (1 - f) * (h - 2 * pad);
          return <g key={f}><line x1="0" x2={w} y1={gy} y2={gy} stroke="#1b2430" /><text x="2" y={gy - 4} fill="var(--dim)" font-size="10">{Math.round(top * f)} ms</text></g>;
        })}
        {startX > 4 && <line x1="0" x2={startX.toFixed(1)} y1={h - pad} y2={h - pad} stroke="var(--dim)" stroke-width="1.5" stroke-dasharray="2 5" />}
        <LineWithFill segs={segmentsOf(blipsAsSpikes(data, top), (v, i) => [off + i * step, y(v)])} base={h - pad} col="var(--blue)" />
        {data.map((v, i) => v != null && v > top &&
          <text key={i} x={(off + i * step).toFixed(1)} y="10" text-anchor="middle" fill="var(--amber)" font-size="10">↑{Math.round(v)}</text>)}
      </>}
    </svg>
  );
}

/** A tile's small history line. base: where the scale starts (temperature from 25°, so changes show). */
export function MiniSpark({ data, col, top, label, unit, base = 0 }: { data?: Series; col: string; top: number; label: string; unit: string; base?: number }) {
  const v = (data || []).filter((x): x is number => x != null);
  if (v.length < 2) return <svg aria-hidden="true" />;
  const w = 200, h = 26, step = w / (v.length - 1);
  const d = v.map((x, i) => (i ? 'L' : 'M') + (i * step).toFixed(1) + ' ' + (h - 2 - Math.max(0, Math.min(x - base, top)) / top * (h - 4)).toFixed(1)).join('');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"
         onMouseMove={e => {
           const r = (e.currentTarget as SVGElement).getBoundingClientRect();
           const i = Math.round((e.clientX - r.left) / r.width * (v.length - 1));
           if (i >= 0 && i < v.length) showTip(e, `${label}: ${Math.round(v[i])}${unit}`); else hideTip();
         }} onMouseLeave={hideTip}>
      <path d={`${d} L${w} ${h} L0 ${h}Z`} fill={col} opacity=".12" />
      <path d={d} fill="none" stroke={col} stroke-width="1.6" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

/** The laptop's half-circle gauges (CPU, memory, temperature). */
export function Gauge({ pct, text, col }: { pct: number; text: string; col: string }) {
  const r = 46, cx = 60, cy = 62, len = Math.PI * r;
  const p = Math.max(0, Math.min(100, pct || 0)) / 100;
  return (
    <svg viewBox="0 0 120 80">
      <path d={`M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#232d39" stroke-width="9" stroke-linecap="round" />
      <path d={`M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={col} stroke-width="9" stroke-linecap="round"
            stroke-dasharray={len} stroke-dashoffset={len * (1 - p)} style="transition:stroke-dashoffset .6s" />
      <text x={cx} y={cy - 4} text-anchor="middle" fill="#e6edf3" font-size="20" font-weight="600">{text}</text>
    </svg>
  );
}
