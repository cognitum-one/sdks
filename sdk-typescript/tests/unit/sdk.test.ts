/**
 * Unit tests for CognitumSDK class
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitumSDK } from '../../src/sdk.js';
import { MockBackend } from '../mocks/backend.js';
import { ExitReason } from '../../src/types.js';

describe('CognitumSDK', () => {
  let mockBackend: MockBackend;
  let sdk: CognitumSDK;

  beforeEach(() => {
    mockBackend = new MockBackend();
    // Create SDK with mock backend (bypassing factory)
    sdk = new (CognitumSDK as any)(mockBackend);
  });

  describe('loadProgram', () => {
    it('should delegate to backend', async () => {
      const program = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

      await sdk.loadProgram(program);

      expect(mockBackend.loadProgram).toHaveBeenCalledWith(program);
    });

    it('should validate program before loading', async () => {
      await expect(sdk.loadProgram(new Uint8Array(0)))
        .rejects
        .toThrow('Empty program');

      expect(mockBackend.loadProgram).not.toHaveBeenCalled();
    });

    it('should update internal state on success', async () => {
      mockBackend.getState.mockReturnValue({
        programLoaded: true,
        currentCycle: 0,
        tiles: [],
      });

      await sdk.loadProgram(new Uint8Array([0x01, 0x02, 0x03, 0x04]));

      expect(sdk.getState().programLoaded).toBe(true);
    });
  });

  describe('run', () => {
    it('should delegate execution to backend', async () => {
      mockBackend.getState.mockReturnValue({
        programLoaded: true,
        currentCycle: 0,
        tiles: [],
      });
      mockBackend.run.mockResolvedValue({
        cyclesExecuted: 100,
        instructionsExecuted: 500,
        tilesUsed: 4,
        memoryBytesAccessed: 1024,
        exitReason: 'complete',
      });

      const results = await sdk.run();

      expect(mockBackend.run).toHaveBeenCalledWith(undefined);
      expect(results.cyclesExecuted).toBe(100);
    });

    it('should transform raw results to typed results', async () => {
      mockBackend.getState.mockReturnValue({
        programLoaded: true,
        currentCycle: 0,
        tiles: [],
      });
      mockBackend.run.mockResolvedValue({
        cyclesExecuted: 100,
        instructionsExecuted: 500,
        tilesUsed: 4,
        memoryBytesAccessed: 1024,
        exitReason: 'cycle_limit',
      });

      const results = await sdk.run();

      expect(results.exitReason).toBe(ExitReason.CycleLimit);
    });

    it('should fail without loaded program', async () => {
      mockBackend.getState.mockReturnValue({
        programLoaded: false,
        currentCycle: 0,
        tiles: [],
      });

      await expect(sdk.run())
        .rejects
        .toThrow('No program loaded');
    });
  });

  describe('runFor', () => {
    it('should pass cycle count to backend', async () => {
      mockBackend.getState.mockReturnValue({
        programLoaded: true,
        currentCycle: 0,
        tiles: [],
      });
      mockBackend.run.mockResolvedValue({
        cyclesExecuted: 1000,
        instructionsExecuted: 5000,
        tilesUsed: 8,
        memoryBytesAccessed: 4096,
        exitReason: 'cycle_limit',
      });

      await sdk.runFor(1000);

      expect(mockBackend.run).toHaveBeenCalledWith(1000);
    });

    it('should reject invalid cycle count', async () => {
      await expect(sdk.runFor(0)).rejects.toThrow('Invalid cycle count');
      await expect(sdk.runFor(-1)).rejects.toThrow('Invalid cycle count');
    });
  });

  describe('step', () => {
    it('should execute single cycle', async () => {
      mockBackend.getState.mockReturnValue({
        programLoaded: true,
        currentCycle: 0,
        tiles: [],
      });
      mockBackend.step.mockResolvedValue({
        cycle: 1,
        activeTiles: [0, 1],
        instructionsExecuted: 2,
      });

      const result = await sdk.step();

      expect(mockBackend.step).toHaveBeenCalled();
      expect(result.cycle).toBe(1);
      expect(result.activeTiles).toEqual([0, 1]);
    });

    it('should emit cycle event', async () => {
      mockBackend.getState.mockReturnValue({
        programLoaded: true,
        currentCycle: 0,
        tiles: [],
      });
      mockBackend.step.mockResolvedValue({
        cycle: 1,
        activeTiles: [0],
        instructionsExecuted: 1,
      });

      const handler = vi.fn();
      sdk.on('cycle', handler);

      await sdk.step();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ cycle: 1 })
      );
    });
  });

  describe('reset', () => {
    it('should delegate to backend', () => {
      sdk.reset();

      expect(mockBackend.reset).toHaveBeenCalled();
    });

    it('should clear event handlers', () => {
      const handler = vi.fn();
      sdk.on('cycle', handler);

      sdk.reset();
      mockBackend.triggerCycleEvent(1);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('should return current state', () => {
      mockBackend.getState.mockReturnValue({
        programLoaded: true,
        currentCycle: 42,
        tiles: [
          { id: 0, programCounter: 10, stackPointer: 20, registers: [1, 2, 3] },
        ],
      });

      const state = sdk.getState();

      expect(state.programLoaded).toBe(true);
      expect(state.currentCycle).toBe(42);
      expect(state.tiles).toHaveLength(1);
    });
  });
});
