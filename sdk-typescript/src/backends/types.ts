/**
 * Backend interface and raw types
 */

/**
 * Backend interface for simulator implementations
 */
export interface Backend {
  /** Backend type identifier */
  readonly type: 'wasm' | 'napi';

  /** Load a program into the simulator */
  loadProgram(program: Uint8Array): Promise<void>;

  /** Run simulation for specified cycles (undefined = until completion) */
  run(cycles?: number): Promise<RawResults>;

  /** Execute a single cycle */
  step(): Promise<RawStepResult>;

  /** Get current simulator state */
  getState(): RawState;

  /** Reset simulator to initial state */
  reset(): void;

  /** Register cycle event handler */
  onCycle(callback: (cycle: number, state: RawCycleState) => void): void;

  /** Cleanup resources */
  dispose(): void;
}

/**
 * Raw results from backend execution
 */
export interface RawResults {
  cyclesExecuted: number;
  instructionsExecuted: number;
  tilesUsed: number;
  memoryBytesAccessed: number;
  exitReason: string;
}

/**
 * Raw state from backend
 */
export interface RawState {
  programLoaded: boolean;
  currentCycle: number;
  tiles: RawTileState[];
}

/**
 * Raw tile state from backend
 */
export interface RawTileState {
  id: number;
  programCounter: number;
  stackPointer: number;
  registers: number[];
}

/**
 * Raw step result from backend
 */
export interface RawStepResult {
  cycle: number;
  activeTiles: number[];
  instructionsExecuted: number;
}

/**
 * Raw cycle state for events
 */
export interface RawCycleState {
  activeTiles: number;
  instructionsExecuted?: number;
}
