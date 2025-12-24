/**
 * Acceptance tests for event streaming
 */

import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom, take, toArray } from 'rxjs';
import { CognitumSDK } from '../../src/index.js';
import { MockBackend } from '../mocks/backend.js';
import type { CycleEvent } from '../../src/types.js';

// Mock the backend creation
vi.mock('../../src/backends/index.js', async () => {
  const actual = await vi.importActual('../../src/backends/index.js');
  return {
    ...actual,
    createBackend: vi.fn().mockResolvedValue(new MockBackend()),
  };
});

describe('Event Streaming (Acceptance)', () => {
  /**
   * Acceptance Criteria:
   * - Subscribe to cycle events
   * - Receive events during execution
   * - Unsubscribe to stop receiving
   * - Use RxJS Observable for streaming
   */

  it('should emit cycle events during execution', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    mockBackend.getState.mockReturnValue({
      programLoaded: true,
      currentCycle: 0,
      tiles: [],
    });

    const events: CycleEvent[] = [];
    const unsubscribe = sdk.on('cycle', (event) => {
      events.push(event);
    });

    // Simulate 10 cycle events
    for (let i = 1; i <= 10; i++) {
      mockBackend.triggerCycleEvent(i);
    }

    unsubscribe();

    expect(events.length).toBe(10);
    expect(events[0].cycle).toBe(1);
    expect(events[9].cycle).toBe(10);
  });

  it('should provide RxJS Observable stream', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    const stream = sdk.stream();

    const eventPromise = firstValueFrom(
      stream.pipe(take(5), toArray())
    );

    // Emit events
    setTimeout(() => {
      for (let i = 1; i <= 10; i++) {
        mockBackend.triggerCycleEvent(i);
      }
    }, 10);

    const events = await eventPromise;

    expect(events.length).toBe(5);
    expect(events[0].cycle).toBe(1);
    expect(events[4].cycle).toBe(5);
  });

  it('should emit completion event', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    mockBackend.getState.mockReturnValue({
      programLoaded: true,
      currentCycle: 0,
      tiles: [],
    });

    let completed = false;
    sdk.on('complete', () => {
      completed = true;
    });

    await sdk.loadProgram(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    await sdk.run();

    expect(completed).toBe(true);
  });

  it('should stop receiving events after unsubscribe', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    const events: CycleEvent[] = [];
    const unsubscribe = sdk.on('cycle', (event) => {
      events.push(event);
      if (event.cycle === 5) {
        unsubscribe();
      }
    });

    // Emit 100 events
    for (let i = 1; i <= 100; i++) {
      mockBackend.triggerCycleEvent(i);
    }

    expect(events.length).toBe(5);
  });

  it('should handle multiple subscribers', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    const events1: CycleEvent[] = [];
    const events2: CycleEvent[] = [];

    sdk.on('cycle', (event) => events1.push(event));
    sdk.on('cycle', (event) => events2.push(event));

    for (let i = 1; i <= 5; i++) {
      mockBackend.triggerCycleEvent(i);
    }

    expect(events1.length).toBe(5);
    expect(events2.length).toBe(5);
  });
});
