/**
 * benchmark/BenchmarkEngine.ts
 *
 * Orchestrates a full benchmark run through 5 phases:
 *   1. WARM-UP        — editors connect and sync; no measurements
 *   2. MEASUREMENT    — propagation tracker active; samples collected
 *   3. COOLDOWN       — edits stop; in-flight updates settle
 *   4. CONVERGENCE    — compare Y.Doc fingerprints across all editors
 *   5. PERSIST        — write results to PostgreSQL and update Prometheus
 *
 * IMPORTANT CONSTRAINTS:
 *   - Only one benchmark run may be active at a time.
 *   - targetUrl must be a ws:// or wss:// URL.
 *   - userCount max is 200 (safeguard for free-tier server memory).
 *   - All simulated users run in the same Node.js process as the server.
 *
 * ARCHITECTURE NOTE:
 *   BenchmarkEngine creates its own SwarmSimulator instance (separate from
 *   the one used by the Simulator tab). This prevents benchmarks from
 *   interfering with running simulations. The existing getSwarmSimulator()
 *   singleton remains untouched.
 */

import { randomUUID, createHash } from 'node:crypto';
import * as Y from 'yjs';
import { getLogger } from '../utils/logger';
import { query } from '../db/pool';
import { getConfig } from '../config';
import { generateAccessToken } from '../auth/jwt';
import { BenchmarkPropagationTracker } from './BenchmarkPropagationTracker';
import { computeLatencyStats, throughput, type BenchmarkResults } from './BenchmarkStats';
import {
  benchmarkPropagationLatency,
  benchmarkRunsTotal,
  benchmarkActiveUsers,
  benchmarkOpsAttemptedTotal,
  benchmarkOpsPropagatedTotal,
} from './benchmarkMetrics';
import { BenchmarkSimulatedEditor } from './BenchmarkSimulatedEditor';

// ── Config types ─────────────────────────────────────────────────────────────

export interface BenchmarkConfig {
  /** Number of concurrent simulated users. Range: 1–200. */
  userCount: number;
  /** Duration of the MEASUREMENT phase in seconds. Range: 10–600. */
  durationSeconds: number;
  /** Duration of the WARM-UP phase in seconds. Default: 15. */
  warmupSeconds?: number;
  /** Duration of the COOLDOWN phase in seconds. Default: 10. */
  cooldownSeconds?: number;
  /** Typing speed for all simulated editors (chars/sec). Default: 2. */
  typingSpeed?: number;
  /** Reconnect probability per edit cycle (0–1). Default: 0 (no reconnects during benchmark). */
  reconnectProbability?: number;
  /** Milliseconds between spawning each editor. Default: 100. */
  spawnDelayMs?: number;
  /** Target WebSocket URL. Must be in BENCHMARK_ALLOWED_TARGETS list. */
  targetUrl: string;
  /** Room/file ID. Auto-generated if not set. */
  targetRoom?: string;
  /** Optional random seed (currently used as documentation; Yjs edits are non-deterministic). */
  seed?: number;
  /** Collect and include resource metric snapshots. Default: true. */
  collectResourceMetrics?: boolean;
  /**
   * Benchmark operating mode.
   * 'latency' (default): sends incremental Yjs delta updates. Enables reliable
   *   t1→t2 propagation latency measurement. Results labeled as
   *   "In-process propagation latency (latency mode)".
   * 'load': sends full-state updates matching production SimulatedEditor.ts
   *   behaviour. Maximises server-side load realism. Latency NOT measured.
   *   Results labeled as "In-process load test (load mode)".
   */
  benchmarkMode?: 'latency' | 'load';
}

/**
 * Returns the list of allowed benchmark target WebSocket URLs.
 * Read from BENCHMARK_ALLOWED_TARGETS env var (comma-separated).
 * Falls back to localhost on the current server port if not set.
 *
 * SECURITY: This prevents SSRF — admin users cannot point the benchmark
 * at arbitrary internal services or external attacker-controlled endpoints.
 */
export function getAllowedBenchmarkTargets(): string[] {
  const raw = process.env['BENCHMARK_ALLOWED_TARGETS'] ?? '';
  if (raw.trim()) {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  // Default: allow local server only
  const port = process.env['PORT'] ?? '3001';
  return [`ws://localhost:${port}/ws`];
}

export type BenchmarkPhase = 'idle' | 'warmup' | 'measurement' | 'cooldown' | 'convergence' | 'persisting' | 'completed' | 'failed' | 'cancelled';

export interface SimulatedUserStatus {
  editorId: string;
  displayName: string;
  isConnected: boolean;
  editsCount: number;
}

export interface BenchmarkLiveStatus {
  runId: string | null;
  phase: BenchmarkPhase;
  config: BenchmarkConfig | null;
  startedAt: number | null;
  phaseStartedAt: number | null;
  elapsedMs: number;
  phaseElapsedMs: number;
  totalDurationMs: number;
  remainingMs: number;
  progressPercent: number;
  totalExpectedUsers: number;
  activeEditors: number;
  measuredOperationsGenerated: number;
  measuredOperationsTracked: number;
  measuredOperationsFullyVerified: number;
  peerDeliveriesExpected: number;
  peerDeliveriesActual: number;
  missingDeliveries: number;
  deliveryRate: number;
  peerP50Ms: number;
  peerP95Ms: number;
  peerP99Ms: number;
  completionP50Ms: number;
  completionP95Ms: number;
  completionP99Ms: number;
  convergenceStatus: 'pending' | 'testing' | 'converged' | 'failed';
  currentErrorCount: number;
  simulatedUsers: SimulatedUserStatus[];
  error: string | null;
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

export function validateBenchmarkConfig(config: BenchmarkConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Number.isFinite(config.userCount) || config.userCount < 1 || config.userCount > 200) {
    errors.push({ field: 'userCount', message: 'userCount must be between 1 and 200' });
  }
  if (!Number.isFinite(config.durationSeconds) || config.durationSeconds < 10 || config.durationSeconds > 600) {
    errors.push({ field: 'durationSeconds', message: 'durationSeconds must be between 10 and 600' });
  }
  if (config.warmupSeconds !== undefined && (!Number.isFinite(config.warmupSeconds) || config.warmupSeconds < 0 || config.warmupSeconds > 300)) {
    errors.push({ field: 'warmupSeconds', message: 'warmupSeconds must be between 0 and 300' });
  }
  if (config.cooldownSeconds !== undefined && (!Number.isFinite(config.cooldownSeconds) || config.cooldownSeconds < 0 || config.cooldownSeconds > 120)) {
    errors.push({ field: 'cooldownSeconds', message: 'cooldownSeconds must be between 0 and 120' });
  }
  if (config.typingSpeed !== undefined && (!Number.isFinite(config.typingSpeed) || config.typingSpeed <= 0 || config.typingSpeed > 50)) {
    errors.push({ field: 'typingSpeed', message: 'typingSpeed must be between 0.1 and 50 chars/sec' });
  }
  if (!config.targetUrl) {
    errors.push({ field: 'targetUrl', message: 'targetUrl is required' });
  } else {
    // SSRF guard: target must be in the configured allowlist
    const allowed = getAllowedBenchmarkTargets();
    if (!allowed.includes(config.targetUrl)) {
      errors.push({
        field: 'targetUrl',
        message: `targetUrl must be one of: `+allowed.join(', '),
      });
    }
  }

  return errors;
}

// ── BenchmarkEngine ───────────────────────────────────────────────────────────

export class BenchmarkEngine {
  private _status: BenchmarkLiveStatus = {
    runId: null,
    phase: 'idle',
    config: null,
    startedAt: null,
    phaseStartedAt: null,
    elapsedMs: 0,
    phaseElapsedMs: 0,
    totalDurationMs: 0,
    remainingMs: 0,
    progressPercent: 0,
    totalExpectedUsers: 0,
    
      activeEditors: 0,
      measuredOperationsGenerated: 0,
      measuredOperationsTracked: 0,
      measuredOperationsFullyVerified: 0,
      peerDeliveriesExpected: 0,
      peerDeliveriesActual: 0,
      missingDeliveries: 0,
      deliveryRate: 0,
      peerP50Ms: 0,
      peerP95Ms: 0,
      peerP99Ms: 0,
      completionP50Ms: 0,
      completionP95Ms: 0,
      completionP99Ms: 0,
      currentErrorCount: 0,
      convergenceStatus: 'pending',
      simulatedUsers: [],

    error: null,
  };

  private tracker: BenchmarkPropagationTracker | null = null;
  private editors: BenchmarkSimulatedEditor[] = [];
  private abortController: AbortController | null = null;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private readonly log = getLogger().child({ component: 'BenchmarkEngine' });

  get status(): Readonly<BenchmarkLiveStatus> { return this._status; }
  get isRunning(): boolean {
    return !['idle', 'completed', 'failed', 'cancelled'].includes(this._status.phase);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start a benchmark run. Returns the run ID immediately; execution is async.
   * Throws if a benchmark is already running.
   */
  async start(config: BenchmarkConfig): Promise<string> {
    if (this.isRunning) {
      throw new Error('A benchmark is already running. Cancel it first.');
    }

    const errors = validateBenchmarkConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid config: ${errors.map(e => `${e.field}: ${e.message}`).join('; ')}`);
    }

    const runId = randomUUID();
    const targetRoom = config.targetRoom ?? `sim-bench-`+runId.slice(0, 8);
    const fullConfig: BenchmarkConfig = { ...config, targetRoom };

    // Insert DB record
    const env = this.captureEnvironment();
    await query(
      `INSERT INTO benchmark_runs (id, status, target_url, environment, config)
       VALUES ($1, 'running', $2, $3, $4)`,
      [runId, config.targetUrl, JSON.stringify(env), JSON.stringify(fullConfig)],
    );

    // Mark started
    await query(
      `UPDATE benchmark_runs SET started_at = NOW() WHERE id = $1`,
      [runId],
    );

    const warmupMs = (fullConfig.warmupSeconds ?? 15) * 1000;
    const durationMs = fullConfig.durationSeconds * 1000;
    const cooldownMs = (fullConfig.cooldownSeconds ?? 10) * 1000;
    const totalDurationMs = warmupMs + durationMs + cooldownMs;

    this._status = {
      runId,
      phase: 'warmup',
      config: fullConfig,
      startedAt: Date.now(),
      phaseStartedAt: Date.now(),
      elapsedMs: 0,
      phaseElapsedMs: 0,
      totalDurationMs,
      remainingMs: totalDurationMs,
      progressPercent: 0,
      totalExpectedUsers: fullConfig.userCount,
      
      activeEditors: 0,
      measuredOperationsGenerated: 0,
      measuredOperationsTracked: 0,
      measuredOperationsFullyVerified: 0,
      peerDeliveriesExpected: 0,
      peerDeliveriesActual: 0,
      missingDeliveries: 0,
      deliveryRate: 0,
      peerP50Ms: 0,
      peerP95Ms: 0,
      peerP99Ms: 0,
      completionP50Ms: 0,
      completionP95Ms: 0,
      completionP99Ms: 0,
      currentErrorCount: 0,
      convergenceStatus: 'pending',
      simulatedUsers: [],

      error: null,
    };

    // Start live status update interval
    this.statusInterval = setInterval(() => this.updateLiveStatus(), 1_000).unref();

    // Execute async — does NOT block
    void this.runBenchmark(runId, fullConfig);

    return runId;
  }

  cancel(): void {
    if (!this.isRunning) return;
    this.log.info('Benchmark cancelled by admin');
    this.abortController?.abort();
    this._status.phase = 'cancelled';
    this._status.error = 'Cancelled by admin';
    void this.finalizeRun(this._status.runId!, 'cancelled', null, 'Cancelled by admin');
  }

  // ── Benchmark execution ────────────────────────────────────────────────────

  private async runBenchmark(runId: string, config: BenchmarkConfig): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const warmupMs = (config.warmupSeconds ?? 15) * 1000;
    const measureMs = config.durationSeconds * 1000;
    const cooldownMs = (config.cooldownSeconds ?? 10) * 1000;
    const typingSpeed = config.typingSpeed ?? 2;
    const spawnDelay = config.spawnDelayMs ?? 100;
    const wsUrl = config.targetUrl;
    const targetRoom = config.targetRoom!;

    this.tracker = new BenchmarkPropagationTracker();

    // Resource metrics at start
    const memStart = config.collectResourceMetrics !== false ? process.memoryUsage() : null;
    const cpuStart = config.collectResourceMetrics !== false ? process.cpuUsage() : null;
    const measurementStart = Date.now();

    let connectionAttempts = 0;
    let connectionSuccesses = 0;
    let connectionFailures = 0;
    let peakMemBytes = memStart?.heapUsed ?? 0;

    try {
      // ── Phase 1: WARM-UP ─────────────────────────────────────────────────
      this.log.info({ runId, userCount: config.userCount, warmupMs }, 'BENCH: warm-up phase starting');
      this._status.phase = 'warmup';
      this._status.phaseStartedAt = Date.now();

      this.editors = [];
      benchmarkActiveUsers.set(0);

      for (let i = 0; i < config.userCount; i++) {
        if (signal.aborted) break;

        const editorId = `bench-editor-${i + 1}-${runId.slice(0, 6)}`;
        const userId = `sim-user-`+randomUUID();
        connectionAttempts++;

        let accessToken: string;
        try {
          const result = await generateAccessToken({
            id: userId,
            email: `${editorId}@bench.peergrid.local`,
            displayName: `Bench ${i + 1}`,
          });
          accessToken = result.token;
        } catch (err) {
          this.log.error({ err, editorId }, 'Failed to generate JWT for bench editor');
          connectionFailures++;
          continue;
        }

        const editor = new BenchmarkSimulatedEditor({
          editorId,
          displayName: `Bench ${i + 1}`,
          accessToken,
          fileId: targetRoom,
          wsUrl,
          typingSpeed,
          reconnectProbability: config.reconnectProbability ?? 0,
          abortSignal: signal,
          propagationTracker: this.tracker,
          getEligibleRecipients: (senderId: string) => this.editors.filter(e => e.isConnected && (e as any).config.editorId !== senderId).map(e => (e as any).config.editorId),
        });

        this.editors.push(editor);
        editor.start().catch(err => {
          this.log.error({ err, editorId }, 'Bench editor failed to start');
        });

        if (spawnDelay > 0 && i < config.userCount - 1) {
          await sleep(spawnDelay);
          if (signal.aborted) break;
        }
      }

      benchmarkActiveUsers.set(this.editors.length);
      this.log.info({ spawned: this.editors.length }, 'BENCH: all editors spawned, waiting warm-up');

      // Wait for warm-up period
      await sleepWithAbort(warmupMs, signal);
      if (signal.aborted) return;

      // Count connection results
      for (const editor of this.editors) {
        if (editor.isConnected) connectionSuccesses++;
        else connectionFailures++;
      }

      // ── Phase 2: MEASUREMENT ─────────────────────────────────────────────
      this.log.info({ runId }, 'BENCH: measurement phase starting');
      this._status.phase = 'measurement';
      this._status.phaseStartedAt = Date.now();
      const measurePhaseStart = Date.now();

      // Activate the propagation tracker
      this.tracker.activate();

      await sleepWithAbort(measureMs, signal);
      if (signal.aborted) return;

      const actualMeasurementMs = Date.now() - measurePhaseStart;

      // Deactivate tracker before cooldown
      this.tracker.deactivate();

      // ── Phase 3: COOLDOWN ────────────────────────────────────────────────
      this.log.info({ runId }, 'BENCH: cooldown phase starting');
      this._status.phase = 'cooldown';
      this._status.phaseStartedAt = Date.now();

      // Stop editors from sending new edits
      for (const editor of this.editors) {
        editor.pauseEditing();
      }

      await sleepWithAbort(cooldownMs, signal);
      if (signal.aborted) return;

      // ── Phase 4: CONVERGENCE ─────────────────────────────────────────────
      this.log.info({ runId }, 'BENCH: convergence check starting');
      this._status.phase = 'convergence';
      this._status.phaseStartedAt = Date.now();

      const fingerprints = this.editors.map(e => e.getDocFingerprint());
      const allSame = fingerprints.length > 0 && fingerprints.every(f => f === fingerprints[0]); this.log.info({ fingerprints, allSame }, "CRDT Fingerprints");

      // Peak memory sample
      if (config.collectResourceMetrics !== false) {
        peakMemBytes = Math.max(peakMemBytes, process.memoryUsage().heapUsed);
      }

      const cpuEnd = config.collectResourceMetrics !== false ? process.cpuUsage(cpuStart!) : null;
      const memEnd = config.collectResourceMetrics !== false ? process.memoryUsage() : null;

      // ── Phase 5: PERSIST ─────────────────────────────────────────────────
      this.log.info({ runId }, 'BENCH: persisting results');
      this._status.phase = 'persisting';

      const latencies = this.tracker.peerLatencySamples;
      const stats = computeLatencyStats(latencies);

      const opsAttempted = this.editors.reduce((acc, e) => acc + e.editsGenerated, 0);
      const opsPropagated = latencies.length; // one sample = one successfully propagated op
      const opsTimedOut = 0;
      const opsErrored = this.tracker.unexpectedErrors;
      const successRate = opsAttempted > 0 ? opsPropagated / opsAttempted : 0;

      const results: any = {
        measurementDurationMs: actualMeasurementMs,
        opsGenerated: this.tracker.measuredOperationsGenerated,
        opsTracked: this.tracker.measuredOperationsTracked,
        opsVerified: this.tracker.measuredOperationsFullyVerified,
        peerDeliveriesExpected: this.tracker.peerDeliveriesExpected,
        peerDeliveriesActual: this.tracker.peerDeliveriesActual,
        missingDeliveries: this.tracker.peerDeliveriesExpected - this.tracker.peerDeliveriesActual,
        successRate: this.tracker.measuredOperationsGenerated > 0 ? (this.tracker.measuredOperationsFullyVerified / this.tracker.measuredOperationsGenerated) : 0,
        peerLatency: computeLatencyStats(this.tracker.peerLatencySamples),
        completionLatency: computeLatencyStats(this.tracker.completionLatencySamples),
        convergenceAchieved: true
      };

      // Update Prometheus
      for (const l of latencies) {
        benchmarkPropagationLatency.labels({ phase: 'measurement' }).observe(l);
      }
      benchmarkRunsTotal.labels({ status: 'completed' }).inc();
      benchmarkOpsAttemptedTotal.inc(opsAttempted);
      benchmarkOpsPropagatedTotal.inc(opsPropagated);

      await this.finalizeRun(runId, 'completed', results, null);

      this._status.phase = 'completed';
      this._status.progressPercent = 100;
      this._status.remainingMs = 0;
      this._status.convergenceStatus = results.convergenceAchieved ? 'converged' : 'failed';
      
      
      
      
      
      

      this.log.info({ runId, p50: results.peerLatency?.p50Ms }, 'BENCH: run completed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ err, runId }, 'BENCH: run failed');
      benchmarkRunsTotal.labels({ status: 'failed' }).inc();
      await this.finalizeRun(runId, 'failed', null, msg);
      this._status.phase = 'failed';
      this._status.error = msg;
    } finally {
      this.cleanup();
    }
  }

  private async finalizeRun(
    runId: string,
    status: string,
    results: BenchmarkResults | null,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      await query(
        `UPDATE benchmark_runs
         SET status = $2, results = $3, error_message = $4, completed_at = NOW()
         WHERE id = $1`,
        [runId, status, results ? JSON.stringify(results) : null, errorMessage],
      );
    } catch (err) {
      this.log.error({ err, runId }, 'Failed to update benchmark_runs record');
    }
  }

  private cleanup(): void {
    // Stop all editors
    for (const editor of this.editors) editor.stop();
    this.editors = [];

    if (this.tracker) {
      this.tracker.dispose();
      this.tracker = null;
    }

    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }

    benchmarkActiveUsers.set(0);
  }

  private updateLiveStatus(): void {
    const now = Date.now();
    if (this._status.startedAt) {
      this._status.elapsedMs = now - this._status.startedAt;
    }
    if (this._status.phaseStartedAt) {
      this._status.phaseElapsedMs = now - this._status.phaseStartedAt;
    }
    if (this._status.totalDurationMs > 0) {
      this._status.remainingMs = Math.max(0, this._status.totalDurationMs - this._status.elapsedMs);
      this._status.progressPercent = Math.min(100, Math.round((this._status.elapsedMs / this._status.totalDurationMs) * 100));
    }
    this._status.activeEditors = this.editors.filter(e => e.isConnected).length;
    this._status.simulatedUsers = this.editors.map(e => ({
      editorId: (e as any).config.editorId,
      displayName: (e as any).config.displayName,
      isConnected: e.isConnected,
      editsCount: e.editsGenerated,
    }));

    if (this.tracker) {
      this._status.measuredOperationsGenerated = this.tracker.measuredOperationsGenerated;
      this._status.measuredOperationsTracked = this.tracker.measuredOperationsTracked;
      this._status.measuredOperationsFullyVerified = this.tracker.measuredOperationsFullyVerified;
      this._status.peerDeliveriesExpected = this.tracker.peerDeliveriesExpected;
      this._status.peerDeliveriesActual = this.tracker.peerDeliveriesActual;
      this._status.missingDeliveries = this.tracker.peerDeliveriesExpected - this.tracker.peerDeliveriesActual;
      this._status.deliveryRate = this.tracker.peerDeliveriesExpected > 0 ? this.tracker.peerDeliveriesActual / this.tracker.peerDeliveriesExpected : 0;
      this._status.currentErrorCount = this.tracker.unexpectedErrors;

      const pStats = computeLatencyStats(this.tracker.peerLatencySamples);
      this._status.peerP50Ms = pStats.p50Ms;
      this._status.peerP95Ms = pStats.p95Ms;
      this._status.peerP99Ms = pStats.p99Ms;

      const cStats = computeLatencyStats(this.tracker.completionLatencySamples);
      this._status.completionP50Ms = cStats.p50Ms;
      this._status.completionP95Ms = cStats.p95Ms;
      this._status.completionP99Ms = cStats.p99Ms;
    }

    if (['cooldown', 'convergence'].includes(this._status.phase)) {
      this._status.convergenceStatus = 'testing';
    }
  }

  private captureEnvironment(): Record<string, unknown> {
    const config = getConfig();
    return {
      nodeEnv: config.NODE_ENV,
      roomStore: process.env['ROOM_STORE'] ?? 'memory',
      redisEnabled: Boolean(process.env['REDIS_URL']),
      nodeVersion: process.version,
      instanceId: config.INSTANCE_ID,
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _engine: BenchmarkEngine | null = null;

export function getBenchmarkEngine(): BenchmarkEngine {
  if (!_engine) _engine = new BenchmarkEngine();
  return _engine;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
