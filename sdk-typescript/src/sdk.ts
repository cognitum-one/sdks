/**
 * Main SDK class
 */

import { Observable } from 'rxjs';
import type { Backend } from './backends/types.js';
import type {
  SDKOptions,
  SimulationResults,
  StepResult,
  SimulatorState,
  CycleEvent,
  SDKEvents,
  Unsubscribe,
} from './types.js';
import { EventEmitter } from './events.js';
import { createCycleStream } from './stream.js';
import { validateProgram, validateCycleCount, validateSDKOptions } from './validation.js';
import { transformResults, transformStepResult } from './results/index.js';
import { createBackend } from './backends/index.js';
import { SimulationError } from './errors.js';

/**
 * Main Cognitum SDK class
 */
export class CognitumSDK {
  private backend: Backend;
  private events: EventEmitter<SDKEvents>;
  private stream$?: Observable<CycleEvent>;

  private constructor(backend: Backend) {
    this.backend = backend;
    this.events = new EventEmitter();

    // Setup cycle event forwarding
    this.backend.onCycle((cycle, state) => {
      const event: CycleEvent = {
        cycle,
        activeTiles: state.activeTiles ? [state.activeTiles] : [],
        instructionsExecuted: state.instructionsExecuted ?? 0,
        timestamp: Date.now(),
      };
      this.events.emit('cycle', event);
    });
  }

  /**
   * Create SDK instance
   */
  static async create(options: SDKOptions = {}): Promise<CognitumSDK> {
    validateSDKOptions(options);
    const backend = await createBackend(options);
    return new CognitumSDK(backend);
  }

  /**
   * Get backend type
   */
  get backendType(): 'wasm' | 'napi' {
    return this.backend.type;
  }

  /**
   * Load program into simulator
   */
  async loadProgram(program: Uint8Array | string): Promise<void> {
    // Handle file path loading in Node.js
    if (typeof program === 'string') {
      if (typeof require === 'undefined') {
        throw new SimulationError('File loading only supported in Node.js');
      }
      const fs = require('fs').promises;
      const data = await fs.readFile(program);
      program = new Uint8Array(data);
    }

    validateProgram(program);
    await this.backend.loadProgram(program);
  }

  /**
   * Run simulation until completion
   */
  async run(options?: { maxCycles?: number }): Promise<SimulationResults> {
    const state = this.getState();
    if (!state.programLoaded) {
      throw new SimulationError('No program loaded');
    }

    const rawResults = await this.backend.run(options?.maxCycles);
    const results = transformResults(rawResults);

    this.events.emit('complete', results);
    return results;
  }

  /**
   * Run for specific number of cycles
   */
  async runFor(cycles: number): Promise<SimulationResults> {
    validateCycleCount(cycles);

    const state = this.getState();
    if (!state.programLoaded) {
      throw new SimulationError('No program loaded');
    }

    const rawResults = await this.backend.run(cycles);
    const results = transformResults(rawResults);

    this.events.emit('complete', results);
    return results;
  }

  /**
   * Execute single cycle
   */
  async step(): Promise<StepResult> {
    const state = this.getState();
    if (!state.programLoaded) {
      throw new SimulationError('No program loaded');
    }

    const rawStep = await this.backend.step();
    return transformStepResult(rawStep);
  }

  /**
   * Get current simulator state
   */
  getState(): SimulatorState {
    return this.backend.getState();
  }

  /**
   * Reset simulator
   */
  reset(): void {
    this.backend.reset();
    this.events.clear();
    this.stream$ = undefined;
  }

  /**
   * Register event handler
   */
  on<K extends keyof SDKEvents>(
    event: K,
    handler: (data: SDKEvents[K]) => void
  ): Unsubscribe {
    return this.events.on(event, handler);
  }

  /**
   * Get RxJS Observable stream of cycle events
   */
  stream(): Observable<CycleEvent> {
    if (!this.stream$) {
      this.stream$ = createCycleStream(this.backend);
    }
    return this.stream$;
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.backend.dispose();
    this.events.clear();
    this.stream$ = undefined;
  }
}
