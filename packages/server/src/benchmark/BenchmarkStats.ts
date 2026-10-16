/**
 * benchmark/BenchmarkStats.ts
 *
 * Pure statistics functions for benchmark result computation.
 *
 * Percentile method: linear interpolation between adjacent sorted values.
 */

export interface LatencyStats {
  sampleCount: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  stddevMs: number;
}

export interface BenchmarkResults {
  measurementDurationMs: number;
  opsGenerated: number;
  opsTracked: number;
  opsVerified: number;
  peerDeliveriesExpected: number;
  peerDeliveriesActual: number;
  missingDeliveries: number;
  successRate: number;
  peerLatency: LatencyStats;
  completionLatency: LatencyStats;
  convergenceAchieved: boolean;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const fraction = index - lower;

  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + fraction * (sorted[upper]! - sorted[lower]!);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

export function stddev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function computeLatencyStats(latencySamples: readonly number[]): LatencyStats {
  if (latencySamples.length === 0) {
    return {
      sampleCount: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      stddevMs: 0,
    };
  }

  const sorted = [...latencySamples].sort((a, b) => a - b);

  return {
    sampleCount: sorted.length,
    minMs: round2(sorted[0]!),
    maxMs: round2(sorted[sorted.length - 1]!),
    meanMs: round2(mean(sorted)),
    p50Ms: round2(percentile(sorted, 50)),
    p90Ms: round2(percentile(sorted, 90)),
    p95Ms: round2(percentile(sorted, 95)),
    p99Ms: round2(percentile(sorted, 99)),
    stddevMs: round2(stddev(sorted)),
  };
}

export function throughput(ops: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return round2((ops / durationMs) * 1000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
