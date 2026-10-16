/**
 * admin/BenchmarkRunDetail.tsx
 */

import React from 'react';
import type { BenchmarkRun } from './benchmarkApi';
import { benchmarkApi } from './benchmarkApi';

interface Props {
  run: BenchmarkRun;
  onClose: () => void;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return `${ms.toFixed(1)}ms`;
}

function fmtPct(p: number | null | undefined): string {
  if (p == null) return '—';
  return `${(p * 100).toFixed(2)}%`;
}

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

export function BenchmarkRunDetail({ run, onClose }: Props) {
  const runId = run.id;
  const cfg = run.config;
  const res = run.results;

  return (
    <div className="bg-zinc-800/60 border border-blue-700/40 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-700 bg-zinc-800">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">
            Run <code className="text-blue-300">{runId.slice(0, 8)}</code>
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {new Date(run.created_at).toLocaleString()} | {run.status} | {cfg.userCount} users
          </p>
        </div>
        <div className="flex items-center gap-2">
          {res && (
            <>
              <a
                href={benchmarkApi.getExportUrl(runId, 'csv')}
                className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
                download
              >
                ↓ CSV
              </a>
              <a
                href={benchmarkApi.getExportUrl(runId, 'json')}
                className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
                download
              >
                ↓ JSON
              </a>
            </>
          )}
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 text-sm px-2">✕</button>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Error */}
        {run.error_message && (
          <div className="bg-red-900/20 border border-red-800 rounded p-3 text-xs text-red-300">
            {run.error_message}
          </div>
        )}

        {/* No results yet */}
        {!res && run.status !== 'failed' && (
          <p className="text-xs text-zinc-500 italic">Results not yet available (run may still be in progress).</p>
        )}

        {res && (
          <>
            {/* Primary latency stats */}
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                Peer Propagation Latency
                <span className="ml-1.5 text-zinc-600 normal-case">(n={(res.peerLatency?.sampleCount ?? 0).toLocaleString()} deliveries)</span>
              </h4>
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                {[
                  ['Min', fmtMs(res.peerLatency?.minMs), 'text-zinc-300'],
                  ['Mean', fmtMs(res.peerLatency?.meanMs), 'text-zinc-300'],
                  ['p50', fmtMs(res.peerLatency?.p50Ms), 'text-blue-300'],
                  ['p90', fmtMs(res.peerLatency?.p90Ms), 'text-indigo-300'],
                  ['p95', fmtMs(res.peerLatency?.p95Ms), 'text-violet-300'],
                  ['p99', fmtMs(res.peerLatency?.p99Ms), 'text-rose-300'],
                  ['Max', fmtMs(res.peerLatency?.maxMs), 'text-zinc-400'],
                  ['Std Dev', fmtMs(res.peerLatency?.stddevMs), 'text-zinc-400'],
                ].map(([label, value, cls]) => (
                  <div key={label as string} className="bg-zinc-900/60 rounded p-2">
                    <p className="text-[10px] text-zinc-500">{label}</p>
                    <p className={`text-sm font-mono font-semibold ${cls}`}>{value}</p>
                  </div>
                ))}
              </div>
            </section>
            
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                Operation Completion Latency
                <span className="ml-1.5 text-zinc-600 normal-case">(Time until ALL peers received, n={(res.completionLatency?.sampleCount ?? 0).toLocaleString()} ops)</span>
              </h4>
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                {[
                  ['Min', fmtMs(res.completionLatency?.minMs), 'text-zinc-300'],
                  ['Mean', fmtMs(res.completionLatency?.meanMs), 'text-zinc-300'],
                  ['p50', fmtMs(res.completionLatency?.p50Ms), 'text-blue-300'],
                  ['p90', fmtMs(res.completionLatency?.p90Ms), 'text-indigo-300'],
                  ['p95', fmtMs(res.completionLatency?.p95Ms), 'text-violet-300'],
                  ['p99', fmtMs(res.completionLatency?.p99Ms), 'text-rose-300'],
                  ['Max', fmtMs(res.completionLatency?.maxMs), 'text-zinc-400'],
                  ['Std Dev', fmtMs(res.completionLatency?.stddevMs), 'text-zinc-400'],
                ].map(([label, value, cls]) => (
                  <div key={label as string} className="bg-zinc-900/60 rounded p-2">
                    <p className="text-[10px] text-zinc-500">{label}</p>
                    <p className={`text-sm font-mono font-semibold ${cls}`}>{value}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Operations */}
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Operations</h4>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {[
                  ['Ops Generated', (res.opsGenerated ?? 0).toLocaleString(), 'text-zinc-300'],
                  ['Ops Tracked', (res.opsTracked ?? 0).toLocaleString(), 'text-green-400'],
                  ['Ops Verified', (res.opsVerified ?? 0).toLocaleString(), 'text-green-400'],
                  ['Expected Deliveries', (res.peerDeliveriesExpected ?? 0).toLocaleString(), 'text-zinc-300'],
                  ['Actual Deliveries', (res.peerDeliveriesActual ?? 0).toLocaleString(), 'text-green-400'],
                  ['Success Rate', fmtPct(res.successRate), 'text-green-400'],
                ].map(([label, value, cls]) => (
                  <div key={label as string} className="bg-zinc-900/60 rounded p-2">
                    <p className="text-[10px] text-zinc-500">{label}</p>
                    <p className={`text-sm font-mono font-semibold ${cls}`}>{value}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Convergence */}
            <section>
              <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Convergence</h4>
              <div className="flex items-center gap-3">
                <span className={`text-sm font-semibold ${res.convergenceAchieved ? 'text-green-400' : 'text-red-400'}`}>
                  {res.convergenceAchieved ? '✓ 100% SWARM DELIVERY VERIFIED' : '✕ FAILED'}
                </span>
              </div>
              <p className="text-xs text-zinc-600 mt-1">
                All {cfg.userCount} editors' Y.Doc SHA-256 hashes{' '}
                {res.convergenceAchieved ? 'matched.' : 'DID NOT match.'}
              </p>
            </section>

          </>
        )}

        {/* Config */}
        <section>
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Config</h4>
          <div className="bg-zinc-900/60 rounded p-3 text-xs font-mono text-zinc-400 whitespace-pre overflow-x-auto">
            {JSON.stringify(cfg, null, 2)}
          </div>
        </section>
      </div>
    </div>
  );
}
