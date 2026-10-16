/**
 * benchmark/BenchmarkPropagationTracker.ts
 *
 * Implements a strict Multi-Peer Delivery Matrix based on cryptographic
 * payload identity (SHA-256) rather than fragile Yjs struct parsing.
 *
 * INVARIANTS:
 * - measuredOperationsGenerated === measuredOperationsTracked === measuredOperationsFullyVerified
 * - peerDeliveriesExpected === peerDeliveriesActual
 */

import { getLogger } from '../utils/logger';

const log = getLogger().child({ component: 'BenchTracker' });

export type OperationId = string;

export interface TrackedOperation {
  operationId: string;
  senderEditorId: string;
  expectedRecipients: Set<string>; // immutable snapshot
  receivedBy: Set<string>;
  t1: number;
  latencies: Map<string, number>; // receiverEditorId -> (t2 - t1)
}

export class BenchmarkPropagationTracker {
  private _active = false;

  private _measuredOperationsGenerated = 0;
  private _measuredOperationsTracked = 0;
  private _unexpectedErrors = 0;

  private readonly matrix = new Map<OperationId, TrackedOperation>();

  activate(): void {
    this._active = true;
  }

  deactivate(): void {
    this._active = false;
  }

  incrementGenerated(): void {
    if (this._active) {
      this._measuredOperationsGenerated++;
    }
  }

  /**
   * Called by the sender immediately before dispatching the payload.
   * snapshot is the immutable array of eligible peer IDs at T_gen.
   */
  recordSend(operationId: string, senderEditorId: string, expectedRecipients: string[], t1: number): void {
    if (!this._active) return;
    
    if (this.matrix.has(operationId)) {
      log.warn({ operationId }, 'Duplicate recordSend for operationId');
      this._unexpectedErrors++;
      return;
    }

    this.matrix.set(operationId, {
      operationId,
      senderEditorId,
      expectedRecipients: new Set(expectedRecipients),
      receivedBy: new Set(),
      t1,
      latencies: new Map(),
    });
    this._measuredOperationsTracked++;
  }

  /**
   * Called by the receiver AFTER successful Y.applyUpdate().
   */
  recordAck(operationId: string, receiverEditorId: string, t2: number): void {
    const op = this.matrix.get(operationId);
    if (!op) {
      // Could be a Warmup/Cooldown edit, or delayed beyond tracker reset. Not inherently an error if not tracking.
      return; 
    }

    if (!op.expectedRecipients.has(receiverEditorId)) {
      log.warn({ operationId, receiverEditorId }, 'ACK from unexpected recipient');
      this._unexpectedErrors++;
      return;
    }

    if (op.receivedBy.has(receiverEditorId)) {
      // Duplicate ACK, strictly ignored for metrics
      return;
    }

    const latencyMs = t2 - op.t1;
    op.receivedBy.add(receiverEditorId);
    op.latencies.set(receiverEditorId, latencyMs);

    // LIVE AUDIT LOG FOR FACULTY DEMO (Samples ~1% of deliveries)
    if (Math.random() < 0.01) {
      console.log(`\x1b[36m[LATENCY AUDIT]\x1b[0m op: ${operationId.substring(0, 6)}... | T1: ${op.t1.toFixed(2)}ms | T2: ${t2.toFixed(2)}ms | Latency: ${latencyMs.toFixed(2)}ms`);
    }
  }

  // --- Assessment & Accessors ---

  get measuredOperationsGenerated(): number { return this._measuredOperationsGenerated; }
  get measuredOperationsTracked(): number { return this._measuredOperationsTracked; }
  
  get measuredOperationsFullyVerified(): number {
    let count = 0;
    for (const op of this.matrix.values()) {
      if (op.receivedBy.size === op.expectedRecipients.size) {
        count++;
      }
    }
    return count;
  }

  get peerDeliveriesExpected(): number {
    let count = 0;
    for (const op of this.matrix.values()) {
      count += op.expectedRecipients.size;
    }
    return count;
  }

  get peerDeliveriesActual(): number {
    let count = 0;
    for (const op of this.matrix.values()) {
      count += op.receivedBy.size;
    }
    return count;
  }

  get unexpectedErrors(): number { return this._unexpectedErrors; }
  get trackedOperations(): TrackedOperation[] { return Array.from(this.matrix.values()); }

  get isFullyVerified(): boolean {
    return (
      this._measuredOperationsGenerated > 0 &&
      this._measuredOperationsGenerated === this._measuredOperationsTracked &&
      this._measuredOperationsTracked === this.measuredOperationsFullyVerified &&
      this.peerDeliveriesExpected === this.peerDeliveriesActual &&
      this._unexpectedErrors === 0
    );
  }

  /** P50/P95/P99 over ALL individual peer deliveries. */
  get peerLatencySamples(): number[] {
    const samples: number[] = [];
    for (const op of this.matrix.values()) {
      for (const latency of op.latencies.values()) {
        samples.push(latency);
      }
    }
    return samples;
  }

  /** P50/P95/P99 of the swarm convergence time (MAX peer latency per operation). */
  get completionLatencySamples(): number[] {
    const samples: number[] = [];
    for (const op of this.matrix.values()) {
      if (op.receivedBy.size === op.expectedRecipients.size && op.expectedRecipients.size > 0) {
        let maxL = -1;
        for (const latency of op.latencies.values()) {
          if (latency > maxL) maxL = latency;
        }
        samples.push(maxL);
      }
    }
    return samples;
  }

  dispose(): void {
    this.matrix.clear();
  }

  reset(): void {
    this._active = false;
    this._measuredOperationsGenerated = 0;
    this._measuredOperationsTracked = 0;
    this._unexpectedErrors = 0;
    this.matrix.clear();
  }
}
