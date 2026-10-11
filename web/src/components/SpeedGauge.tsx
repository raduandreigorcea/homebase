// The speed test's dial, built from ordinary page elements: an SVG arc and a div for the needle. Only CSS
// animates them, so nothing is redrawn from script on every frame and the page stays free. The script sets
// one number, --deg; the browser animates that number, and the needle and the arc both read it, so they
// can't drift apart.
import { useRef } from 'preact/hooks';
import type { SpeedRun } from '../api';

// Scale in MB/s: speeds people actually have, spread evenly (0 · 1 · 2 · 5 · 10 · 25 · 50 · 100).
const TICKS = [0, 1, 2, 5, 10, 25, 50, 100];
const SWEEP = 240;  // degrees: from -120 (0) to +120 (100); 0 is straight up, clockwise is positive
const SWING = 150;  // degrees per second the needle may travel: a far-off first reading is a climb, not a jump
const R = 160, CX = 190, CY = 190;  // the dial's arc and centre, in the SVG's own units

function angle(v: number): number {
  const top = TICKS[TICKS.length - 1];
  v = Math.max(0, Math.min(top, v));
  const i = Math.max(0, TICKS.findIndex(t => t >= v) - 1), a = TICKS[i], b = TICKS[i + 1] ?? top;
  return -SWEEP / 2 + (i + (b > a ? (v - a) / (b - a) : 0)) * SWEEP / (TICKS.length - 1);
}
function point(deg: number, r: number): [number, number] {
  const rad = (deg - 90) * Math.PI / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}
// One fixed arc for the track and for the fill. The fill is the same path shown in part (stroke-dashoffset),
// so its shape never changes: no arc flips between its short and long form near half a circle.
const [x1, y1] = point(-SWEEP / 2, R), [x2, y2] = point(SWEEP / 2, R);
const ARC = `M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 1 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;

export function SpeedGauge({ run, big }: { run: SpeedRun; big: string }) {
  const live = run.phase === 'download' || run.phase === 'upload' ? run.live : run.phase === 'done' ? run.down ?? 0 : 0;  // Mbit/s
  const deg = angle((live ?? 0) / 8);  // the server measures Mbit/s; the dial is in MB/s
  const prev = useRef({ deg: -SWEEP / 2, phase: run.phase });
  const fresh = prev.current.phase !== run.phase && (run.phase === 'download' || run.phase === 'upload');  // a new direction starts from zero
  const jump = Math.abs(deg - prev.current.deg);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  // How long the move takes: as long as it needs at the allowed speed, never less than a reading interval.
  const ms = fresh || reduced ? 0 : Math.max(300, Math.min(1800, jump / SWING * 1000));
  prev.current = { deg, phase: run.phase };
  const style = { '--deg': String(deg), '--ms': `${ms}ms`, '--ease': jump > 25 ? 'cubic-bezier(.2,.6,.3,1)' : 'linear' } as Record<string, string>;
  return (
    <div class="st-gauge" style={style} role="img" aria-label={`Speed ${big} MB/s`}>
      <svg viewBox="0 0 380 300" aria-hidden="true">
        <path class="trk" d={ARC} pathLength="100" />
        <path class="fil" d={ARC} pathLength="100" style={{ stroke: run.phase === 'upload' ? 'var(--violet)' : 'var(--blue)' }} />
        {TICKS.map((t, i) => {
          const [x, y] = point(-SWEEP / 2 + i * SWEEP / (TICKS.length - 1), 130);
          return <text key={t} x={x.toFixed(1)} y={(y + 4).toFixed(1)} text-anchor="middle">{t}</text>;
        })}
      </svg>
      <i class="needle" />
      <i class="hub" />
      <b class="num">{big}</b>
    </div>
  );
}
