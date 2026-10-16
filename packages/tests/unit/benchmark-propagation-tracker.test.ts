import { describe, it, expect, beforeEach } from 'vitest';
import { BenchmarkPropagationTracker } from '@collab/server/src/benchmark/BenchmarkPropagationTracker';

describe('BenchmarkPropagationTracker', () => {
  let tracker: BenchmarkPropagationTracker;

  beforeEach(() => {
    tracker = new BenchmarkPropagationTracker();
  });

  it('starts with empty samples', () => {
    expect(tracker.peerLatencySamples).toEqual([]);
    expect(tracker.completionLatencySamples).toEqual([]);
  });

  it('records a latency sample', () => {
    tracker.activate();
    tracker.recordSend('op1', 'editor1', ['editor2'], 100);
    tracker.recordAck('op1', 'editor2', 200);
    expect(tracker.peerLatencySamples).toEqual([100]);
    expect(tracker.completionLatencySamples).toEqual([100]);
    expect(tracker.measuredOperationsGenerated).toBe(1);
    expect(tracker.measuredOperationsTracked).toBe(1);
    expect(tracker.measuredOperationsFullyVerified).toBe(1);
    expect(tracker.peerDeliveriesExpected).toBe(1);
    expect(tracker.peerDeliveriesActual).toBe(1);
    expect(tracker.isFullyVerified).toBe(true);
  });

  it('reset() clears all state', () => {
    tracker.activate();
    tracker.recordSend('op1', 'editor1', ['editor2'], 100);
    tracker.reset();
    expect(tracker.peerLatencySamples).toEqual([]);
  });
});
