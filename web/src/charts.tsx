// Charts. Every response-time chart is drawn the same way: a blue line with a light fill under it,
// broken where a check was missed, on a scale sized to the usual values so a rare slow reply doesn't
// flatten it. Hovering any chart shows the value under the pointer.
import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { NetPoint, Outage } from './api';
import { hhmm } from './format';
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

/** A stretch where nothing answered (internet down, device gone): red dots over the whole height,
 *  from the last answer to the next. Not a line at some height: low on these charts means fast,
 *  and there's no value to show. */
function DownZone({ a, b, top, bottom }: { a: number; b: number; top: number; bottom: number }) {
  const rows = [];
  for (let yy = top + 3; yy <= bottom - 1; yy += 6) rows.push(yy);
  return <g>{rows.map((yy, k) => <line key={k} x1={(a + (k % 2) * 2.5).toFixed(1)} x2={b.toFixed(1)} y1={yy} y2={yy}
    stroke="var(--red)" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="0 5" opacity=".75" />)}</g>;
}

/** Every stretch of missed answers after the history starts, as a DownZone. isDown can narrow which
 *  gaps count (the internet history: not the time the laptop was asleep). */
function DownMarks({ vals, x, right, top, bottom, isDown = () => true }:
  { vals: Series; x: (i: number) => number; right: number; top: number; bottom: number; isDown?: (i: number) => boolean }) {
  const first = vals.findIndex(v => v != null);
  if (first < 0) return null;
  const out = [];
  for (let i = first; i < vals.length; i++) {
    if (vals[i] != null || !isDown(i)) continue;
    let j = i;
    while (j < vals.length && vals[j] == null && isDown(j)) j++;
    const a = vals[i - 1] != null ? x(i - 1) : x(i);
    const b = j < vals.length && vals[j] != null ? x(j) : j < vals.length ? x(j - 1) : right;
    out.push(<DownZone key={i} a={a} b={Math.max(b, a + 3)} top={top} bottom={bottom} />);
    i = j;
  }
  return <>{out}</>;
}

/** The card's response-time line: the big chart in miniature (no scale). */
export function Spark({ data }: { data: Series }) {
  const [ref, w, h] = useSize<SVGSVGElement>();
  const pad = 3, top = latTop(data), step = w / (N - 1), off = w - (data.length - 1) * step;
  const vals = blipsAsSpikes(data, top);
  const x = (i: number) => off + i * step, y = (v: number) => h - pad - Math.min(v, top) / top * (h - 2 * pad);
  return (
    <svg ref={ref} class="spark" viewBox={`0 0 ${w || 300} ${h || 30}`} preserveAspectRatio="none" aria-label="Response time, last 3 minutes"
         {...hoverProps(data, 'Response', ' ms')}>
      {w > 0 && <>
        <DownMarks vals={vals} x={x} right={w} top={0} bottom={h} />
        <LineWithFill segs={segmentsOf(vals, (v, i) => [x(i), y(v)])} base={h} col="var(--blue)" />
      </>}
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
         onMouseMove={e => {
           const i = hoverIndex(e, data.length, pad);
           setHover(i >= 0 && i < data.length && data[i] != null ? i : null);
           if (i >= 0 && i < data.length && data[i] == null && first >= 0 && i > first) showTip(e, 'Internet down: no answer'); else hideTip();
         }}
         onMouseLeave={() => { setHover(null); hideTip(); }}>
      {w > 0 && <>
        {startX - pad > 2 && <line x1={pad} x2={startX.toFixed(1)} y1={(first < 0 ? h / 2 : y(data[first]!)).toFixed(1)} y2={(first < 0 ? h / 2 : y(data[first]!)).toFixed(1)}
                                   stroke="var(--dim)" stroke-width="1.5" stroke-dasharray="2 5" stroke-linecap="round" />}
        <DownMarks vals={data} x={i => off + i * step} right={right} top={0} bottom={h} />
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
        <DownMarks vals={blipsAsSpikes(data, top)} x={i => off + i * step} right={w} top={pad} bottom={h - pad} />
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

const fmtShort = (s: number) => s < 60 ? `${Math.max(1, Math.round(s))} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

/** The internet over a day, week or month: average response time per point, outages as red bands,
 *  and gaps where the laptop was off or asleep. */
export function HistoryChart({ points, outages, step, range }: { points: NetPoint[]; outages: Outage[]; step: number; range: string }) {
  const [ref, w, h] = useSize<SVGSVGElement>();
  const axis = 18, ch = h - axis, pad = 4;
  const data: Series = points.map(p => p.avg ?? null);
  const top = latTop(data);
  const t0 = points[0]?.t ?? 0, t1 = (points[points.length - 1]?.t ?? 0) + step;
  const x = (t: number) => (t - t0) / Math.max(1, t1 - t0) * w;
  const y = (v: number) => ch - pad - Math.min(v, top) / top * (ch - 2 * pad);
  const colW = w / Math.max(1, points.length);
  // Time labels: every 6 hours over a day, each midnight over a week, every 5 days over a month.
  const ticks: [number, string][] = [];
  const d = new Date(t0 * 1000);
  d.setMinutes(0, 0, 0);
  if (range === 'day') {
    d.setHours(Math.ceil(d.getHours() / 6) * 6);
    for (; d.getTime() / 1000 < t1; d.setHours(d.getHours() + 6)) ticks.push([d.getTime() / 1000, hhmm(d)]);
  } else {
    d.setHours(24);
    const every = range === 'week' ? 1 : 5;
    for (; d.getTime() / 1000 < t1; d.setDate(d.getDate() + every))
      ticks.push([d.getTime() / 1000, d.toLocaleDateString('en-GB', range === 'week' ? { weekday: 'short' } : { day: 'numeric', month: 'short' })]);
  }
  const tipFor = (p: NetPoint) => {
    const out = outages.filter(o => o.start < p.t + step && o.end > p.t);
    const down = out.length ? ` · internet down ${out.map(o => fmtShort(o.end - o.start)).join(', ')}` : '';
    return tipBase(p) + down;
  };
  const tipBase = (p: NetPoint) => {
    const when = new Date(p.t * 1000);
    const label = range === 'day' ? hhmm(when) : when.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + (range === 'week' ? ' ' + hhmm(when) : '');
    if (p.avg == null) return p.loss ? `${label}: down` : `${label}: not measured (laptop off or asleep)`;
    return `${label}: ${Math.round(p.avg)} ms average, worst ${Math.round(p.max ?? p.avg)} ms${p.loss ? `, ${Math.round(p.loss * 100)}% unanswered` : ''}`;
  };
  return (
    <svg ref={ref} class="hist-chart" viewBox={`0 0 ${w || 600} ${h || 190}`} preserveAspectRatio="none" aria-label="Internet response time over time"
         onMouseMove={e => {
           const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
           const i = Math.floor((e.clientX - r.left) / r.width * points.length);
           if (i >= 0 && i < points.length) showTip(e, tipFor(points[i])); else hideTip();
         }}
         onMouseLeave={hideTip}>
      {w > 0 && <>
        {[0, .5, 1].map(f => {
          const gy = pad + (1 - f) * (ch - 2 * pad);
          return <g key={f}><line x1="0" x2={w} y1={gy} y2={gy} stroke="#1b2430" /><text x="2" y={gy - 4} fill="var(--dim)" font-size="10">{Math.round(top * f)} ms</text></g>;
        })}
        <DownMarks vals={data} x={i => i * colW + colW / 2} right={(points.length - 1) * colW + colW / 2} top={pad} bottom={ch - pad}
                   isDown={i => !!points[i].loss} />
        {outages.map((o, i) => {
          // At least 6 px wide, so a 30-second outage in a month still shows.
          let a = Math.max(0, x(o.start)), b = Math.min(w, x(o.end));
          if (b - a < 6) { const c = (a + b) / 2; a = c - 3; b = c + 3; }
          return b > 0 && a < w && <DownZone key={i} a={a} b={b} top={pad} bottom={ch - pad} />;
        })}
        <LineWithFill segs={segmentsOf(data, (v, i) => [i * colW + colW / 2, y(v)])} base={ch - pad} col="var(--blue)" />
        {ticks.map(([t, label]) => {
          const tx = x(t);
          return tx > 14 && tx < w - 14 && <g key={t}>
            <line x1={tx} x2={tx} y1={ch} y2={ch + 4} stroke="var(--line)" />
            <text x={tx} y={h - 2} text-anchor="middle" fill="var(--dim)" font-size="10">{label}</text>
          </g>;
        })}
      </>}
    </svg>
  );
}
