// The internet's history as an ECharts line: average response time per point, a red line wherever the
// internet was down, gaps where this laptop was off or asleep. Drag or scroll on it to zoom.
import { useEffect, useRef } from 'preact/hooks';
import type { NetPoint, Outage } from '../api';
import { fmtShort, latTop } from '../charts';
import { hhmm } from '../format';
import { loadCharts, palette } from '../echarts';

export function HistoryEChart({ points, outages, step, range }: { points: NetPoint[]; outages: Outage[]; step: number; range: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<any>(null);

  const draw = () => {
    const c = chart.current; if (!c || !points.length) return;
    const p = palette(), top = latTop(points.map(x => x.avg ?? null), [50, 100, 200, 500, 1000, 2000]);
    const by = new Map(points.map(x => [x.t * 1000, x]));
    const label = (ms: number) => {
      const d = new Date(ms);
      return range === 'hour' || range === 'day' ? hhmm(d)
        : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + (range === 'week' ? ' ' + hhmm(d) : '');
    };
    c.setOption({
      animationDuration: 400,
      grid: { left: 52, right: 12, top: 10, bottom: 26 },
      xAxis: { type: 'time', min: points[0].t * 1000, max: (points[points.length - 1].t + step) * 1000,
               axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false }, splitLine: { show: false },
               axisLabel: { color: p.dim, fontSize: 11, fontFamily: p.mono, hideOverlap: true } },
      yAxis: { type: 'value', min: 0, max: top, splitNumber: 2,
               axisLabel: { color: p.dim, fontSize: 11, fontFamily: p.mono, formatter: '{value} ms' },
               axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: p.line } } },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: p.panel, borderColor: p.line, textStyle: { color: p.text, fontFamily: p.mono, fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: p.dim } },
        formatter: (params: any) => {
          const ms = params[0]?.axisValue as number, pt = by.get(ms) ?? [...by.values()].find(x => x.t * 1000 <= ms && ms < (x.t + step) * 1000);
          const hit = outages.filter(o => o.start * 1000 < ms + step * 1000 && o.end * 1000 > ms);
          const down = hit.length ? `<br/><span style="color:${p.red}">internet down ${hit.map(o => fmtShort(o.end - o.start)).join(', ')}</span>` : '';
          if (!pt || pt.avg == null) return `${label(ms)}<br/>${pt ? 'down' : 'not measured (laptop off or asleep)'}${down}`;
          return `${label(ms)}<br/>${Math.round(pt.avg)} ms average, worst ${Math.round(pt.max ?? pt.avg)} ms${pt.loss ? `, ${Math.round(pt.loss * 100)}% unanswered` : ''}${down}`;
        } },
      dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true }],
      series: [{
        type: 'line', showSymbol: false, connectNulls: false, data: points.map(x => [x.t * 1000, x.avg ?? null]),
        lineStyle: { color: p.blue, width: 2 }, itemStyle: { color: p.blue }, areaStyle: { color: p.blue, opacity: 0.12 },
        markLine: { silent: true, symbol: 'none', label: { show: false },
          lineStyle: { color: p.red, width: 2, type: 'solid', opacity: 0.9 },
          data: outages.map(o => ({ xAxis: ((o.start + o.end) / 2) * 1000 })) },
      }],
    }, true);
  };

  useEffect(() => {
    let dead = false, ro: ResizeObserver | undefined;
    loadCharts().then(ec => {
      if (dead || !box.current) return;
      chart.current = ec.init(box.current, undefined, { renderer: 'canvas' });
      ro = new ResizeObserver(() => chart.current?.resize()); ro.observe(box.current);
      draw();
    });
    return () => { dead = true; ro?.disconnect(); chart.current?.dispose(); chart.current = null; };
  }, []);
  useEffect(draw, [points, outages, step, range]);
  return <div class="hist-chart" ref={box} role="img" aria-label="Internet response time over time" />;
}
