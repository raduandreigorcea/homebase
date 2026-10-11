// The speed test's dial: an ECharts gauge. The server's reading goes in as a position on the 0 · 1 · 2 · 5 ·
// 10 · 25 · 50 · 100 MB/s scale; ECharts animates the needle and the arc together.
import { useEffect, useRef } from 'preact/hooks';
import type { SpeedRun } from '../api';
import { loadCharts, palette } from '../echarts';

const TICKS = [0, 1, 2, 5, 10, 25, 50, 100];
const DEG_PER_STEP = 240 / (TICKS.length - 1);
const SWING = 150;  // degrees per second the needle may travel, so a far-off first reading is a climb, not a jump

/** MB/s to a position 0..7 along the scale (each tick one step apart). */
function pos(v: number): number {
  const top = TICKS[TICKS.length - 1];
  v = Math.max(0, Math.min(top, v));
  const i = Math.max(0, TICKS.findIndex(t => t >= v) - 1), a = TICKS[i], b = TICKS[i + 1] ?? top;
  return i + (b > a ? (v - a) / (b - a) : 0);
}

export function SpeedGauge({ run, big }: { run: SpeedRun; big: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<any>(null);
  const shown = useRef({ at: 0, phase: run.phase });

  const value = run.phase === 'download' || run.phase === 'upload' ? run.live : run.phase === 'done' ? run.down ?? 0 : 0;  // Mbit/s
  const at = pos((value ?? 0) / 8);  // the server measures Mbit/s; the dial is in MB/s
  const colour = run.phase === 'upload' ? 'violet' : 'blue';

  const draw = () => {
    const c = chart.current; if (!c) return;
    const p = palette(), prev = shown.current;
    const fresh = prev.phase !== run.phase && (run.phase === 'download' || run.phase === 'upload');  // a new direction starts from zero
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ms = fresh || reduced ? 0 : Math.max(250, Math.min(1800, Math.abs(at - prev.at) * DEG_PER_STEP / SWING * 1000));
    shown.current = { at, phase: run.phase };
    c.setOption({ series: [{ animationDurationUpdate: ms, animationEasingUpdate: 'cubicOut', data: [{ value: at }],
      progress: { itemStyle: { color: p[colour] } }, detail: { formatter: () => big } }] });
  };

  useEffect(() => {
    let dead = false, ro: ResizeObserver | undefined;
    loadCharts().then(ec => {
      if (dead || !box.current) return;
      const p = palette(), c = ec.init(box.current, undefined, { renderer: 'canvas' });
      chart.current = c;
      c.setOption({
        animation: true,
        series: [{
          type: 'gauge', startAngle: 210, endAngle: -30, min: 0, max: TICKS.length - 1, splitNumber: TICKS.length - 1,
          center: ['50%', '57%'], radius: '108%',
          axisLine: { roundCap: true, lineStyle: { width: 18, color: [[1, p.track]] } },
          progress: { show: true, roundCap: true, width: 18, itemStyle: { color: p.blue } },
          pointer: { show: true, length: '58%', width: 4, itemStyle: { color: p.text } },
          anchor: { show: true, size: 13, itemStyle: { color: p.text } },
          axisTick: { show: false }, splitLine: { show: false },
          axisLabel: { distance: 14, color: p.dim, fontSize: 12, fontFamily: p.mono, formatter: (v: number) => String(TICKS[Math.round(v)] ?? '') },
          title: { show: false },
          detail: { offsetCenter: [0, '48%'], color: p.text, fontSize: 34, fontWeight: 700, fontFamily: p.mono, formatter: () => big },
          data: [{ value: 0 }],
        }],
      });
      ro = new ResizeObserver(() => c.resize()); ro.observe(box.current);
      shown.current = { at: 0, phase: 'idle' };
      draw();
    });
    return () => { dead = true; ro?.disconnect(); chart.current?.dispose(); chart.current = null; };
  }, []);

  useEffect(draw, [at, run.phase, big]);
  return <div class="st-gauge" ref={box} role="img" aria-label={`Speed ${big} MB/s`} />;
}
