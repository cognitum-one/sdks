/**
 * WebAssembly backend implementation
 */

import type {
  Backend,
  RawResults,
  RawState,
  RawStepResult,
  RawCycleState,
} from './types.js';
import { BackendError } from '../errors.js';

/**
 * WASM backend for browser and Node.js
 */
export class WasmBackend implements Backend {
  readonly type = 'wasm' as const;
  private instance: any;
  private cycleCallback?: (cycle: number, state: RawCycleState) => void;

  private constructor(instance: any) {
    this.instance = instance;
  }

  /**
   * Create and initialize WASM backend
   */
  static async create(wasmModule: any, config?: any): Promise<WasmBackend> {
    try {
      const instance = new wasmModule.Cognitum(
        config?.tiles ?? 16,
        config?.memoryPerTile ?? 156000
      );

      return new WasmBackend(instance);
    } catch (error) {
      throw new BackendError('Failed to initialize WASM backend', error);
    }
  }

  async loadProgram(program: Uint8Array): Promise<void> {
    try {
      this.instance.load_program(program);
    } catch (error: any) {
      throw new BackendError(`Failed to load program: ${error.message}`, error);
    }
  }

  async run(cycles?: number): Promise<RawResults> {
    try {
      const rawResults = this.instance.run(cycles);

      return {
        cyclesExecuted: rawResults.cycles_executed,
        instructionsExecuted: rawResults.instructions_executed,
        tilesUsed: rawResults.tiles_used,
        memoryBytesAccessed: rawResults.memory_bytes_accessed,
        exitReason: rawResults.exit_reason,
      };
    } catch (error: any) {
      throw new BackendError(`Simulation failed: ${error.message}`, error);
    }
  }

  async step(): Promise<RawStepResult> {
    try {
      const rawStep = this.instance.step();

      const result: RawStepResult = {
        cycle: rawStep.cycle,
        activeTiles: rawStep.active_tiles || [],
        instructionsExecuted: rawStep.instructions_executed || 0,
      };

      // Emit cycle event if handler registered
      if (this.cycleCallback) {
        this.cycleCallback(result.cycle, {
          activeTiles: result.activeTiles.length,
          instructionsExecuted: result.instructionsExecuted,
        });
      }

      return result;
    } catch (error: any) {
      throw new BackendError(`Step failed: ${error.message}`, error);
    }
  }

  getState(): RawState {
    try {
      const rawState = this.instance.get_state();

      return {
        programLoaded: rawState.program_loaded,
        currentCycle: rawState.current_cycle,
        tiles: rawState.tiles.map((t: any) => ({
          id: t.id,
          programCounter: t.program_counter,
          stackPointer: t.stack_pointer,
          registers: t.registers || [],
        })),
      };
    } catch (error: any) {
      throw new BackendError(`Failed to get state: ${error.message}`, error);
    }
  }

  reset(): void {
    try {
      this.instance.reset();
      this.cycleCallback = undefined;
    } catch (error: any) {
      throw new BackendError(`Reset failed: ${error.message}`, error);
    }
  }

  onCycle(callback: (cycle: number, state: RawCycleState) => void): void {
    this.cycleCallback = callback;
  }

  dispose(): void {
    try {
      if (this.instance?.free) {
        this.instance.free();
      }
      this.instance = null;
      this.cycleCallback = undefined;
    } catch (error) {
      console.error('Error disposing WASM backend:', error);
    }
  }
}
