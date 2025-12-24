/**
 * Mock backend for testing
 */

import { vi } from 'vitest';
import type { Backend, RawResults, RawState, RawStepResult, RawCycleState } from '../../src/backends/types.js';

export class MockBackend implements Backend {
  readonly type = 'napi' as const;

  loadProgram = vi.fn<[Uint8Array], Promise<void>>().mockResolvedValue(undefined);

  run = vi.fn<[number?], Promise<RawResults>>().mockResolvedValue({
    cyclesExecuted: 100,
    instructionsExecuted: 500,
    tilesUsed: 4,
    memoryBytesAccessed: 1024,
    exitReason: 'complete',
  });

  step = vi.fn<[], Promise<RawStepResult>>().mockResolvedValue({
    cycle: 1,
    activeTiles: [0],
    instructionsExecuted: 1,
  });

  getState = vi.fn<[], RawState>().mockReturnValue({
    programLoaded: false,
    currentCycle: 0,
    tiles: [],
  });

  reset = vi.fn<[], void>();

  onCycle = vi.fn<[(cycle: number, state: RawCycleState) => void], void>();

  dispose = vi.fn<[], void>();

  // Test helpers
  private cycleHandlers: ((cycle: number, state: RawCycleState) => void)[] = [];
  private completeHandlers: (() => void)[] = [];

  constructor() {
    this.onCycle.mockImplementation((handler) => {
      this.cycleHandlers.push(handler);
    });
  }

  triggerCycleEvent(cycle: number, state?: RawCycleState): void {
    const defaultState: RawCycleState = { activeTiles: 1, instructionsExecuted: 1 };
    this.cycleHandlers.forEach((h) => h(cycle, state ?? defaultState));
  }

  triggerComplete(): void {
    this.completeHandlers.forEach((h) => h());
  }

  onComplete(handler: () => void): void {
    this.completeHandlers.push(handler);
  }
}
