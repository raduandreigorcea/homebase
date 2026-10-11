// Only the pieces of ECharts the page uses. Imported by name here so the build leaves the rest out.
import * as core from 'echarts/core';
import { GaugeChart, LineChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

core.use([GaugeChart, LineChart, GridComponent, TooltipComponent, MarkLineComponent, DataZoomInsideComponent, CanvasRenderer]);
export const init = core.init;
