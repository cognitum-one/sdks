/**
 * Acceptance tests for state inspection
 */

import { describe, it, expect, vi } from 'vitest';
import { CognitumSDK } from '../../src/index.js';
import { MockBackend } from '../mocks/backend.js';

// Mock the backend creation
vi.mock('../../src/backends/index.js', async () => {
  const actual = await vi.importActual('../../src/backends/index.js');
  return {
    ...actual,
    createBackend: vi.fn().mockResolvedValue(new MockBackend()),
  };
});

describe('State Inspection (Acceptance)', () => {
  /**
   * Acceptance Criteria:
   * - Get current simulator state
   * - Inspect individual tile states
   * - State updates after execution
   */

  it('should return current state', async () => {
    const sdk = await CognitumSDK.create({ tiles: 4 });
    const mockBackend = (sdk as any).backend as MockBackend;

    mockBackend.getState.mockReturnValue({
      programLoaded: false,
      currentCycle: 0,
      tiles: [
        { id: 0, programCounter: 0, stackPointer: 0, registers: [] },
        { id: 1, programCounter: 0, stackPointer: 0, registers: [] },
        { id: 2, programCounter: 0, stackPointer: 0, registers: [] },
        { id: 3, programCounter: 0, stackPointer: 0, registers: [] },
      ],
    });

    const state = sdk.getState();

    expect(state.programLoaded).toBe(false);
    expect(state.currentCycle).toBe(0);
    expect(state.tiles).toHaveLength(4);
  });

  it('should update state after execution', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    // Initial state
    mockBackend.getState.mockReturnValueOnce({
      programLoaded: true,
      currentCycle: 0,
      tiles: [],
    });

    const stateBefore = sdk.getState();

    // State after execution
    mockBackend.getState.mockReturnValueOnce({
      programLoaded: true,
      currentCycle: 100,
      tiles: [],
    });

    const stateAfter = sdk.getState();

    expect(stateBefore.currentCycle).toBe(0);
    expect(stateAfter.currentCycle).toBe(100);
  });

  it('should provide tile-level state', async () => {
    const sdk = await CognitumSDK.create({ tiles: 8 });
    const mockBackend = (sdk as any).backend as MockBackend;

    mockBackend.getState.mockReturnValue({
      programLoaded: true,
      currentCycle: 50,
      tiles: [
        {
          id: 0,
          programCounter: 42,
          stackPointer: 1000,
          registers: [1, 2, 3, 4, 5, 6, 7, 8],
        },
      ],
    });

    const state = sdk.getState();
    const tile0 = state.tiles[0];

    expect(tile0.id).toBe(0);
    expect(tile0.programCounter).toBe(42);
    expect(tile0.stackPointer).toBe(1000);
    expect(tile0.registers).toBeInstanceOf(Array);
    expect(tile0.registers.length).toBe(8);
  });

  it('should reflect program loaded state', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    // Not loaded
    mockBackend.getState.mockReturnValueOnce({
      programLoaded: false,
      currentCycle: 0,
      tiles: [],
    });

    expect(sdk.getState().programLoaded).toBe(false);

    // After loading
    mockBackend.getState.mockReturnValue({
      programLoaded: true,
      currentCycle: 0,
      tiles: [],
    });

    await sdk.loadProgram(new Uint8Array([0x01, 0x02, 0x03, 0x04]));

    expect(sdk.getState().programLoaded).toBe(true);
  });
});
