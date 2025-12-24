/**
 * Acceptance tests for simulation execution
 */

import { describe, it, expect, vi } from 'vitest';
import { CognitumSDK, ExitReason } from '../../src/index.js';
import { MockBackend } from '../mocks/backend.js';

// Mock the backend creation
vi.mock('../../src/backends/index.js', async () => {
  const actual = await vi.importActual('../../src/backends/index.js');
  return {
    ...actual,
    createBackend: vi.fn().mockResolvedValue(new MockBackend()),
  };
});

describe('Simulation Execution (Acceptance)', () => {
  /**
   * Acceptance Criteria:
   * - Run simulation to completion
   * - Run for specific number of cycles
   * - Step through cycles one at a time
   * - Return detailed results
   */

  it('should run simulation to completion', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    // Setup loaded program
    mockBackend.getState.mockReturnValue({
      programLoaded: true,
      currentCycle: 0,
      tiles: [],
    });

    mockBackend.run.mockResolvedValue({
      cyclesExecuted: 150,
      instructionsExecuted: 750,
      tilesUsed: 8,
      memoryBytesAccessed: 2048,
      exitReason: 'program_complete',
    });

    const program = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    await sdk.loadProgram(program);

    const results = await sdk.run();

    expect(results.cyclesExecuted).toBe(150);
    expect(results.instructionsExecuted).toBe(750);
    expect(results.exitReason).toBe(ExitReason.ProgramComplete);
  });

  it('should run for specified cycles', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    mockBackend.getState.mockReturnValue({
      programLoaded: true,
      currentCycle: 0,
      tiles: [],
    });

    mockBackend.run.mockResolvedValue({
      cyclesExecuted: 1000,
      instructionsExecuted: 5000,
      tilesUsed: 16,
      memoryBytesAccessed: 8192,
      exitReason: 'cycle_limit',
    });

    await sdk.loadProgram(new Uint8Array([0x01, 0x02, 0x03, 0x04]));

    const results = await sdk.runFor(1000);

    expect(results.cyclesExecuted).toBe(1000);
    expect(results.exitReason).toBe(ExitReason.CycleLimit);
  });

  it('should step through cycles', async () => {
    const sdk = await CognitumSDK.create();
    const mockBackend = (sdk as any).backend as MockBackend;

    mockBackend.getState.mockReturnValue({
      programLoaded: true,
      currentCycle: 0,
      tiles: [],
    });

    let cycleCount = 0;
    mockBackend.step.mockImplementation(async () => ({
      cycle: ++cycleCount,
      activeTiles: [0, 1],
      instructionsExecuted: 2,
    }));

    await sdk.loadProgram(new Uint8Array([0x01, 0x02, 0x03, 0x04]));

    const step1 = await sdk.step();
    const step2 = await sdk.step();
    const step3 = await sdk.step();

    expect(step1.cycle).toBe(1);
    expect(step2.cycle).toBe(2);
    expect(step3.cycle).toBe(3);
  });

  it('should fail to run without loaded program', async () => {
    const sdk = await CognitumSDK.create();

    await expect(sdk.run())
      .rejects
      .toThrow('No program loaded');
  });

  it('should validate cycle count', async () => {
    const sdk = await CognitumSDK.create();

    await expect(sdk.runFor(0))
      .rejects
      .toThrow('Invalid cycle count');

    await expect(sdk.runFor(-10))
      .rejects
      .toThrow('Invalid cycle count');
  });
});
