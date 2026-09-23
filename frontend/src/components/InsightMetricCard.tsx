import { useState } from 'react';
import { ChevronDown, ArrowUp, ArrowDown } from 'lucide-react';
import type { AssetInsightMetric } from '@/services/api';

/** Shared between the per-asset Insights tab (AssetDetailPage) and the
 *  deployment-level Insights page -- same metric shape either way. */

export function formatInsightValue(value: number, unit: string): string {
  if (unit === 'percent') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value.toFixed(0)}ms`;
  if (unit === 'credits') return value.toFixed(1);
  return Math.round(value).toLocaleString();
}

function formatPointDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Metrics where "more" reads as worse (failures/errors) get the delta
// color flipped -- an increase is red, a decrease is green. Rate metrics
// (success rate) go the normal way (increase = green). Everything else
// (volume/cost metrics like materializations, credits, duration) is
// judgment-free: the arrow shows direction, but the color stays neutral
// since "more" isn't inherently good or bad for those.
function deltaTone(metricName: string, pctChange: number): 'good' | 'bad' | 'neutral' {
  const isFailureMetric = /fail|error/i.test(metricName);
  const isRateMetric = /success_rate|pass_rate/i.test(metricName);
  if (isFailureMetric) return pctChange > 0 ? 'bad' : pctChange < 0 ? 'good' : 'neutral';
  if (isRateMetric) return pctChange > 0 ? 'good' : pctChange < 0 ? 'bad' : 'neutral';
  return 'neutral';
}

function DeltaBadge({ metric }: { metric: AssetInsightMetric }) {
  const { aggregate_value: current, previous_aggregate_value: previous, metric_name } = metric;
  if (current === null || previous === null || previous === 0) return null;
  const pctChange = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(pctChange) < 0.5) {
    return <span className="text-[10px] text-gray-400">flat vs prior period</span>;
  }
  const tone = deltaTone(metric_name, pctChange);
  const colorClass = tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-rose-600' : 'text-gray-500';
  const Icon = pctChange > 0 ? ArrowUp : ArrowDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-medium ${colorClass}`} title="vs the prior period of equal length">
      <Icon className="w-2.5 h-2.5" />
      {Math.abs(pctChange).toFixed(0)}% vs prior period
    </span>
  );
}

export function InsightMetricCard({ metric }: { metric: AssetInsightMetric }) {
  const [expanded, setExpanded] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const values = metric.values;
  const previousValues = metric.previous_values || [];
  const hasPrevious = previousValues.length > 1;
  // Shared y-scale across both series -- otherwise "current" and
  // "previous" would each stretch to fill the chart on their own scale,
  // which defeats the point of overlaying them (a flat previous line and
  // a flat current line would look identical even if the values are 10x
  // apart). Same idea the delta badge's % change already assumes.
  const max = Math.max(...values, ...previousValues, 0.0001);
  const min = Math.min(...values, ...previousValues, 0);
  const range = max - min || 1;
  const chartHeight = expanded ? 160 : 44;
  const pointAt = (series: number[], i: number) => {
    const x = series.length > 1 ? (i / (series.length - 1)) * 100 : 50;
    const y = 100 - ((series[i] - min) / range) * 100;
    return { x, y };
  };
  const points = values.map((_, i) => { const p = pointAt(values, i); return `${p.x},${p.y}`; }).join(' ');
  const previousPoints = previousValues.map((_, i) => { const p = pointAt(previousValues, i); return `${p.x},${p.y}`; }).join(' ');
  const areaPoints = values.length > 1 ? `0,100 ${points} 100,100` : '';
  const canExpand = values.length > 1;
  const hovered = hoverIdx !== null ? {
    ts: metric.timestamps[hoverIdx],
    value: values[hoverIdx],
    previousValue: hasPrevious ? previousValues[hoverIdx] : undefined,
  } : null;

  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <button
        onClick={() => canExpand && setExpanded(!expanded)}
        disabled={!canExpand}
        className={`w-full flex items-start justify-between gap-2 text-left ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">{metric.label}</div>
          <div className="text-xl font-bold text-gray-900 mt-1">
            {metric.aggregate_value !== null ? formatInsightValue(metric.aggregate_value, metric.unit) : '—'}
          </div>
          <div className="mt-0.5"><DeltaBadge metric={metric} /></div>
        </div>
        {canExpand && (
          <ChevronDown className={`w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        )}
      </button>
      {values.length > 1 && (
        <div className="relative mt-2">
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{ height: chartHeight }}
            className="w-full transition-[height] duration-150"
            onMouseLeave={() => setHoverIdx(null)}
          >
            {hasPrevious && (
              <polyline
                points={previousPoints}
                fill="none"
                stroke="#9ca3af"
                strokeWidth="1.5"
                strokeDasharray="3,2"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <polyline points={areaPoints} fill="#3b82f6" fillOpacity={0.08} stroke="none" />
            <polyline points={points} fill="none" stroke="#3b82f6" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            {values.map((_, i) => {
              const p = pointAt(values, i);
              return (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={hoverIdx === i ? 3 : 6}
                  fill={hoverIdx === i ? '#3b82f6' : 'transparent'}
                  vectorEffect="non-scaling-stroke"
                  onMouseEnter={() => setHoverIdx(i)}
                  style={{ cursor: 'pointer' }}
                />
              );
            })}
          </svg>
          {hasPrevious && (
            <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
              <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-0.5 bg-blue-500" /> Current</span>
              <span className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-0.5 bg-gray-400" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #9ca3af 0 3px, transparent 3px 5px)' }} /> Prior period</span>
            </div>
          )}
          {hovered && (
            <div className="text-[10px] text-gray-500 mt-1 text-right">
              {formatPointDate(hovered.ts)}: <span className="font-medium text-gray-700">{formatInsightValue(hovered.value, metric.unit)}</span>
              {hovered.previousValue !== undefined && (
                <span className="text-gray-400"> · prior: {formatInsightValue(hovered.previousValue, metric.unit)}</span>
              )}
            </div>
          )}
        </div>
      )}
      {expanded && values.length > 1 && (
        <div className="mt-3 pt-3 border-t border-gray-100 max-h-40 overflow-y-auto">
          <table className="w-full text-[11px]">
            <tbody>
              {values.map((v, i) => (
                <tr key={i} className="border-b border-gray-50 last:border-0">
                  <td className="py-1 text-gray-500">{formatPointDate(metric.timestamps[i])}</td>
                  <td className="py-1 text-right text-gray-700 tabular-nums">{formatInsightValue(v, metric.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
