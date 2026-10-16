import React, { useMemo } from 'react';
import type { BenchmarkRun } from './benchmarkApi';

interface Props {
  runs: BenchmarkRun[];
}

interface ChartPoint {
  users: number;
  val: number;
}

interface Series {
  label: string;
  color: string;
  points: ChartPoint[];
  isDashed?: boolean;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function LineChart({ title, series, unit, formatValue, logScale }: { title: string, series: Series[], unit: string, formatValue?: (v: number) => string, logScale?: boolean }) {
  const W = 360;
  const H = 220;
  const PAD = { top: 20, right: 20, bottom: 40, left: 50 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const s of series) {
    for (const p of s.points) {
      if (p.users < minX) minX = p.users;
      if (p.users > maxX) maxX = p.users;
      if (p.val < minY) minY = p.val;
      if (p.val > maxY) maxY = p.val;
    }
  }

  if (minX === Infinity || minY === Infinity) {
    return (
      <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 flex items-center justify-center text-zinc-500 text-xs h-full min-h-[220px]">
        Insufficient valid data for chart
      </div>
    );
  }
  
  if (minX === maxX) minX = 0;
  if (minY === maxY) minY = 0;

  // Use log scale if requested and data span is large
  const useLog = logScale && maxY > 0 && maxY / Math.max(0.1, minY) > 10;
  let getX = (u: number) => PAD.left + ((u - minX) / (maxX - minX)) * innerW;
  let getY: (v: number) => number;
  let renderYGrid: () => React.ReactNode;

  const fmt = formatValue ?? ((v: number) => v.toFixed(1));

  if (useLog) {
    const logMin = Math.max(0.1, minY * 0.5);
    const logMax = maxY * 1.5;
    const logMinLog = Math.log10(logMin);
    const logMaxLog = Math.log10(logMax);
    
    getY = (v: number) => {
      const logV = Math.log10(Math.max(logMin, v));
      return PAD.top + innerH - ((logV - logMinLog) / (logMaxLog - logMinLog)) * innerH;
    };

    // Calculate ticks for log scale: 0.1, 1, 10, 100, 1000
    const ticks: number[] = [];
    let currentPower = Math.floor(Math.log10(logMin));
    const maxPower = Math.ceil(Math.log10(logMax));
    while (currentPower <= maxPower) {
      const val = Math.pow(10, currentPower);
      if (val >= logMin && val <= logMax) {
        ticks.push(val);
      }
      currentPower++;
    }

    renderYGrid = () => (
      <>
        {ticks.map((val, i) => {
          const y = getY(val);
          return (
            <g key={`y-${i}`}>
              <line x1={PAD.left} y1={y} x2={PAD.left + innerW} y2={y} stroke="#3f3f46" strokeDasharray="2 2" />
              <text x={PAD.left - 8} y={y} textAnchor="end" dominantBaseline="middle" fill="#71717a" fontSize={10}>
                {val < 1 ? val.toFixed(1) : Math.round(val)}
              </text>
            </g>
          );
        })}
      </>
    );

  } else {
    const adjustedMaxY = maxY * 1.1;
    getY = (v: number) => PAD.top + innerH - (v / adjustedMaxY) * innerH;
    
    const yTicks = 4;
    const yStep = adjustedMaxY / yTicks;
    renderYGrid = () => (
      <>
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const y = PAD.top + innerH - (i / yTicks) * innerH;
          const val = yStep * i;
          return (
            <g key={i}>
              <line x1={PAD.left} y1={y} x2={PAD.left + innerW} y2={y} stroke="#3f3f46" strokeDasharray="2 2" />
              <text x={PAD.left - 8} y={y} textAnchor="end" dominantBaseline="middle" fill="#71717a" fontSize={10}>
                {fmt(val)}
              </text>
            </g>
          );
        })}
      </>
    );
  }

  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-zinc-300">{title}</h4>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="overflow-visible">
        {renderYGrid()}

        {/* Lines and points */}
        {series.map((s, i) => {
          const sorted = [...s.points].sort((a, b) => a.users - b.users);
          const pathD = sorted.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${getX(p.users)} ${getY(p.val)}`).join(' ');
          return (
            <g key={s.label}>
              <path d={pathD} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.isDashed ? "4 4" : "none"} />
              {sorted.map(p => (
                <g key={p.users}>
                  <circle cx={getX(p.users)} cy={getY(p.val)} r={3} fill={s.color} />
                  <title>{`${s.label} | ${p.users} users: ${fmt(p.val)}${unit}`}</title>
                </g>
              ))}
            </g>
          );
        })}

        {/* Axes */}
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + innerH} stroke="#52525b" />
        <line x1={PAD.left} y1={PAD.top + innerH} x2={PAD.left + innerW} y2={PAD.top + innerH} stroke="#52525b" />

        {/* X-axis labels */}
        {(() => {
          const allXs = Array.from(new Set(series.flatMap(s => s.points.map(p => p.users)))).sort((a,b)=>a-b);
          return allXs.map(u => (
            <text key={u} x={getX(u)} y={PAD.top + innerH + 16} textAnchor="middle" fill="#a1a1aa" fontSize={10}>
              {u}
            </text>
          ));
        })()}

        <text x={PAD.left + innerW / 2} y={H - 5} textAnchor="middle" fill="#71717a" fontSize={10}>
          Concurrent Users
        </text>

        <text x={12} y={PAD.top + innerH / 2} textAnchor="middle" fill="#71717a" fontSize={10} transform={`rotate(-90, 12, ${PAD.top + innerH / 2})`}>
          {unit}{useLog ? " (log)" : ""}
        </text>
      </svg>
      {/* Legend */}
      <div className="flex flex-wrap items-center justify-center gap-4 mt-2">
        {series.map(s => (
          <div key={s.label} className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color }}></span>
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PerformanceEvaluation({ runs }: Props) {
  // STRICT VALIDATION
  const isValidRun = (r: BenchmarkRun) => {
    if (r.status !== 'completed' || !r.results) return false;
    const res = r.results;
    if (res.opsGenerated !== res.opsTracked || res.opsTracked !== res.opsVerified) return false;
    if (res.peerDeliveriesExpected !== res.peerDeliveriesActual) return false;
    if (res.missingDeliveries !== 0) return false;
    if (res.peerDeliveriesExpected > 0 && (res.peerDeliveriesActual / res.peerDeliveriesExpected) < 1) return false;
    if (!res.convergenceAchieved) return false;
    if (res.peerLatency?.p50Ms == null || res.peerLatency.sampleCount === 0) return false;
    return true;
  };

  const validRuns = runs.filter(isValidRun);
  const validRunsSorted = [...validRuns].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const latestValidRun = validRunsSorted[validRunsSorted.length - 1];

  // AGGREGATION: Group by (users, typingRate) -> Median
  const aggMap = new Map<string, BenchmarkRun[]>();
  for (const r of validRuns) {
    const key = `${r.config.userCount}-${r.config.typingSpeed || 2}`;
    if (!aggMap.has(key)) aggMap.set(key, []);
    aggMap.get(key)!.push(r);
  }

  interface AggPoint {
    users: number;
    rate: number;
    p50: number;
    p95: number;
    p99: number;
    throughput: number;
  }

  const aggregatedPoints: AggPoint[] = [];
  for (const [key, group] of aggMap.entries()) {
    const [uStr, rStr] = key.split('-');
    const users = parseInt(uStr, 10);
    const rate = parseInt(rStr, 10);
    const p50s = group.map(r => r.results!.peerLatency!.p50Ms);
    const p95s = group.map(r => r.results!.peerLatency!.p95Ms);
    const p99s = group.map(r => r.results!.peerLatency!.p99Ms);
    const throughs = group.map(r => r.results!.opsVerified / (r.results!.measurementDurationMs / 1000));
    
    aggregatedPoints.push({
      users,
      rate,
      p50: median(p50s),
      p95: median(p95s),
      p99: median(p99s),
      throughput: median(throughs)
    });
  }

  // Chart 1: Edit Propagation Latency vs Users (Typing Rate Analysis)
  const typingRates = Array.from(new Set(aggregatedPoints.map(p => p.rate))).sort((a,b)=>a-b);
  const colors = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171'];
  
  const typingSeries: Series[] = typingRates.map((rate, i) => {
    const points = aggregatedPoints
      .filter(p => p.rate === rate)
      .map(p => ({ users: p.users, val: p.p50 }));
    return {
      label: `${rate} char/s`,
      color: colors[i % colors.length],
      points
    };
  }).filter(s => s.points.length > 0);

  // Chart 2: Latency Distribution (P50, P95, P99)
  const defaultRate = latestValidRun?.config.typingSpeed || 2;
  const defaultRatePoints = aggregatedPoints.filter(p => p.rate === defaultRate);
  
  const distSeries: Series[] = [];
  if (defaultRatePoints.length > 0) {
    distSeries.push({
      label: 'P50', color: '#60a5fa',
      points: defaultRatePoints.map(p => ({ users: p.users, val: p.p50 }))
    });
    distSeries.push({
      label: 'P95', color: '#fbbf24',
      points: defaultRatePoints.map(p => ({ users: p.users, val: p.p95 }))
    });
    distSeries.push({
      label: 'P99', color: '#f87171',
      points: defaultRatePoints.map(p => ({ users: p.users, val: p.p99 }))
    });
  }

  // Chart 3: Throughput vs Users
  const throughputSeries: Series[] = typingRates.map((rate, i) => {
    const points = aggregatedPoints
      .filter(p => p.rate === rate)
      .map(p => ({ users: p.users, val: p.throughput }));
    return { label: `${rate} char/s`, color: colors[i % colors.length], points };
  }).filter(s => s.points.length > 0);


  // Export CSV (Uses ALL completed runs, not just valid, so researchers can see failures)
  const exportCSV = () => {
    const completed = runs.filter(r => r.status === 'completed' && r.results);
    const rows = [
      ['Run ID', 'Timestamp', 'Users', 'Typing Rate', 'Duration (ms)', 'Ops Generated', 'Ops Tracked', 'Ops Verified', 'Expected Deliveries', 'Actual Deliveries', 'Missing Deliveries', 'Delivery Rate', 'P50 (ms)', 'P95 (ms)', 'P99 (ms)', 'Throughput (ops/s)', 'Convergence']
    ];
    for (const r of completed) {
      const res = r.results!;
      const expected = res.peerDeliveriesExpected ?? 0;
      const actual = res.peerDeliveriesActual ?? 0;
      const missing = expected - actual;
      const rate = expected > 0 ? (actual / expected * 100).toFixed(1) + '%' : '-';
      const throughput = (res.opsVerified / Math.max(1, (res.measurementDurationMs || 1000) / 1000)).toFixed(2);
      
      rows.push([
        r.id,
        new Date(r.created_at).toISOString(),
        r.config.userCount.toString(),
        (r.config.typingSpeed || 2).toString(),
        (res.measurementDurationMs || 0).toString(),
        (res.opsGenerated || 0).toString(),
        (res.opsTracked || 0).toString(),
        (res.opsVerified || 0).toString(),
        expected.toString(),
        actual.toString(),
        missing.toString(),
        rate,
        res.peerLatency?.p50Ms?.toFixed(2) ?? '',
        res.peerLatency?.p95Ms?.toFixed(2) ?? '',
        res.peerLatency?.p99Ms?.toFixed(2) ?? '',
        throughput,
        res.convergenceAchieved ? 'PASS' : 'FAIL'
      ]);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'peergrid_research_dataset.csv';
    a.click();
  };

  const exportJSON = () => {
    const completed = runs.filter(r => r.status === 'completed' && r.results);
    const blob = new Blob([JSON.stringify(completed, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'peergrid_research_dataset.json';
    a.click();
  };

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-2xl shadow-xl overflow-hidden mt-12">
      {/* Header */}
      <div className="bg-zinc-900 border-b border-zinc-800 px-8 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-zinc-100 uppercase tracking-widest">Performance Evaluation</h2>
            <p className="text-zinc-400 mt-1">Edit propagation latency under concurrent collaborative workloads</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={exportCSV} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono rounded-lg border border-zinc-700 transition-colors">
              EXPORT CSV
            </button>
            <button onClick={exportJSON} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono rounded-lg border border-zinc-700 transition-colors">
              EXPORT JSON
            </button>
          </div>
        </div>
        <p className="text-xs text-zinc-500 mt-4 max-w-4xl leading-relaxed border-l-2 border-zinc-700 pl-3">
          PeerGrid was evaluated using simulated concurrent editors. Workload was varied by concurrent user count and typing rate. 
          Latency represents the time from benchmark edit transmission to successful application of the corresponding incremental Yjs update at an expected peer.
        </p>
      </div>

      <div className="p-8 space-y-10">
        
        <div className="flex justify-between items-center text-xs text-zinc-500 border-b border-zinc-800 pb-2">
          <span>Displaying <strong>{validRuns.length}</strong> valid experimental runs (aggregated by median)</span>
          {latestValidRun && (
            <span>Latest: {new Date(latestValidRun.created_at).toLocaleString()} ({latestValidRun.config.userCount} users)</span>
          )}
        </div>

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          <LineChart 
            title="Edit Propagation Latency vs Concurrent Users" 
            series={typingSeries} 
            unit="ms" 
            logScale={true}
          />
          <LineChart 
            title={`Latency Distribution vs Concurrent Users (${defaultRate} char/s)`} 
            series={distSeries} 
            unit="ms" 
            logScale={true}
          />
          <LineChart 
            title="Throughput vs Concurrent Users" 
            series={throughputSeries} 
            unit="ops/s" 
          />
        </div>

        {/* Key Findings */}
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-zinc-200 mb-4 uppercase tracking-wider">Latest Valid Run</h3>
          <ul className="space-y-2 text-sm text-zinc-400 list-disc list-inside">
            {latestValidRun && latestValidRun.results?.peerLatency ? (
              <>
                <li>
                  <strong className="text-zinc-200">{latestValidRun.config.userCount} users</strong> / {latestValidRun.config.typingSpeed || 2} chars/sec test completed successfully.
                </li>
                <li>
                  Propagation latencies: P50 <strong className="text-blue-400">{latestValidRun.results.peerLatency.p50Ms.toFixed(1)} ms</strong>, 
                  P95 <strong className="text-amber-400">{latestValidRun.results.peerLatency.p95Ms.toFixed(1)} ms</strong>, 
                  P99 <strong className="text-red-400">{latestValidRun.results.peerLatency.p99Ms.toFixed(1)} ms</strong>.
                </li>
                <li>
                  Sustained system throughput: <strong className="text-zinc-200">{(latestValidRun.results.opsVerified / (latestValidRun.results.measurementDurationMs / 1000)).toFixed(1)} ops/sec</strong>.
                </li>
                <li>
                  <strong className="text-emerald-400">100% Swarm Delivery Verified</strong> with {latestValidRun.results.peerDeliveriesActual.toLocaleString()} total actual deliveries (0 missing).
                </li>
                <li>
                  <strong className="text-emerald-400">CRDT Convergence PASS</strong>.
                </li>
              </>
            ) : (
              <li>No valid benchmark runs available to report.</li>
            )}
          </ul>
        </div>

        {/* Data Integrity Table */}
        <div>
          <h3 className="text-sm font-semibold text-zinc-200 mb-4 uppercase tracking-wider">Historical Runs Integrity</h3>
          <div className="overflow-x-auto bg-zinc-900/50 border border-zinc-800 rounded-xl">
            <table className="w-full text-xs text-left">
              <thead className="text-zinc-500 bg-zinc-900 border-b border-zinc-800 uppercase">
                <tr>
                  <th className="px-4 py-3 font-medium">Valid</th>
                  <th className="px-4 py-3 font-medium">Users</th>
                  <th className="px-4 py-3 font-medium">Rate</th>
                  <th className="px-4 py-3 font-medium text-right">Generated</th>
                  <th className="px-4 py-3 font-medium text-right">Tracked</th>
                  <th className="px-4 py-3 font-medium text-right">Verified</th>
                  <th className="px-4 py-3 font-medium text-right">Expected</th>
                  <th className="px-4 py-3 font-medium text-right">Actual</th>
                  <th className="px-4 py-3 font-medium text-right">Missing</th>
                  <th className="px-4 py-3 font-medium text-right">Delivery</th>
                  <th className="px-4 py-3 font-medium text-center">CRDT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {[...runs.filter(r => r.status === 'completed' && r.results)].sort((a,b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map(r => {
                  const res = r.results!;
                  const expected = res.peerDeliveriesExpected ?? 0;
                  const actual = res.peerDeliveriesActual ?? 0;
                  const missing = expected - actual;
                  const rate = expected > 0 ? (actual / expected * 100).toFixed(1) + '%' : '-';
                  const valid = isValidRun(r);
                  return (
                    <tr key={r.id} className="hover:bg-zinc-800/30 transition-colors text-zinc-300">
                      <td className="px-4 py-3 font-mono text-center">{valid ? <span className="text-emerald-400">✓</span> : <span className="text-red-400">✗</span>}</td>
                      <td className="px-4 py-3 font-mono">{r.config.userCount}</td>
                      <td className="px-4 py-3 font-mono">{r.config.typingSpeed || 2}/s</td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-400">{res.opsGenerated ?? '-'}</td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-400">{res.opsTracked ?? '-'}</td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-400">{res.opsVerified ?? '-'}</td>
                      <td className="px-4 py-3 text-right font-mono text-blue-400">{expected}</td>
                      <td className="px-4 py-3 text-right font-mono text-blue-400">{actual}</td>
                      <td className={`px-4 py-3 text-right font-mono ${missing > 0 ? 'text-red-400' : 'text-zinc-500'}`}>{missing}</td>
                      <td className="px-4 py-3 text-right font-mono">{rate}</td>
                      <td className="px-4 py-3 text-center">
                        {res.convergenceAchieved ? <span className="text-emerald-400">✓</span> : <span className="text-red-400">✗</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </div>
  );
}
