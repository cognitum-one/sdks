/**
 * Acceptance tests for program loading
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

describe('Program Loading (Acceptance)', () => {
  /**
   * Acceptance Criteria:
   * - Load program from Uint8Array
   * - Validate program format
   * - Report loading errors
   */

  it('should load program from Uint8Array', async () => {
    const sdk = await CognitumSDK.create();
    const program = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

    // Mock backend to return loaded state
    const mockBackend = (sdk as any).backend as MockBackend;
    mockBackend.getState.mockReturnValue({
      programLoaded: true,
      currentCycle: 0,
      tiles: [],
    });

    await sdk.loadProgram(program);

    expect(sdk.getState().programLoaded).toBe(true);
  });

  it('should reject invalid program', async () => {
    const sdk = await CognitumSDK.create();
    const invalidProgram = new Uint8Array([0xFF]);

    await expect(sdk.loadProgram(invalidProgram))
      .rejects
      .toThrow('Invalid program format');
  });

  it('should reject empty program', async () => {
    const sdk = await CognitumSDK.create();

    await expect(sdk.loadProgram(new Uint8Array(0)))
      .rejects
      .toThrow('Empty program');
  });

  it('should validate program type', async () => {
    const sdk = await CognitumSDK.create();

    await expect(sdk.loadProgram([] as any))
      .rejects
      .toThrow('must be a Uint8Array');
  });
});
