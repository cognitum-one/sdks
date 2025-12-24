/**
 * Node.js NAPI backend implementation
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
 * NAPI backend for Node.js (higher performance)
 */
export class NapiBackend implements Backend {
  readonly type = 'napi' as const;
  private instance: any;
  private cycleCallback?: (cycle: number, state: RawCycleState) => void;

  constructor(napiModule: any, config?: any) {
    try {
      this.instance = new napiModule.Cognitum(
        config?.tiles ?? 16,
        config?.memoryPerTile ?? 156000
      );
    } catch (error) {
      throw new BackendError('Failed to initialize NAPI backend', error);
    }
  }

  /**
   * Create NAPI backend
   */
  static async create(config?: any): Promise<NapiBackend> {
    try {
      // Dynamically import native module
      const napiModule = require('@ruv/cognitum');
      return new NapiBackend(napiModule, config);
    } catch (error) {
      throw new BackendError(
        'Failed to load NAPI module. Ensure @ruv/cognitum is installed.',
        error
      );
    }
  }

  async loadProgram(program: Uint8Array): Promise<void> {
    try {
      // Convert Uint8Array to Buffer for native module
      const buffer = Buffer.from(program);
      await this.instance.loadProgram(buffer);
    } catch (error: any) {
      throw new BackendError(`Failed to load program: ${error.message}`, error);
    }
  }

  async run(cycles?: number): Promise<RawResults> {
    try {
      const results = await this.instance.run(cycles);
      return results;
    } catch (error: any) {
      throw new BackendError(`Simulation failed: ${error.message}`, error);
    }
  }

  async step(): Promise<RawStepResult> {
    try {
      const result = await this.instance.step();

      // Emit cycle event if handler registered
      if (this.cycleCallback) {
        this.cycleCallback(result.cycle, {
          activeTiles: result.activeTiles?.length || 0,
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
      return this.instance.getState();
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
      this.instance = null;
      this.cycleCallback = undefined;
    } catch (error) {
      console.error('Error disposing NAPI backend:', error);
    }
  }
}
