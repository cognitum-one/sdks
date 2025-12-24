/**
 * Type definitions for Cognitum SDK
 */

/**
 * SDK configuration options
 */
export interface SDKOptions {
  /** Number of tiles to initialize (default: 16) */
  tiles?: number;
  /** Memory per tile in bytes (default: 156000) */
  memoryPerTile?: number;
  /** Backend selection strategy */
  backend?: 'auto' | 'wasm' | 'napi';
  /** Custom WASM file path */
  wasmPath?: string;
}

/**
 * Simulation results after execution
 */
export interface SimulationResults {
  /** Number of cycles executed */
  cyclesExecuted: number;
  /** Number of instructions executed */
  instructionsExecuted: number;
  /** Number of tiles used during execution */
  tilesUsed: number;
  /** Memory bytes accessed */
  memoryBytesAccessed: number;
  /** Why the simulation stopped */
  exitReason: ExitReason;
}

/**
 * Exit reasons for simulation completion
 */
export enum ExitReason {
  ProgramComplete = 'program_complete',
  CycleLimit = 'cycle_limit',
  Error = 'error',
  UserHalt = 'user_halt',
}

/**
 * Result from a single simulation step
 */
export interface StepResult {
  /** Current cycle number */
  cycle: number;
  /** Tiles that executed in this cycle */
  activeTiles: number[];
  /** Instructions executed in this cycle */
  instructionsExecuted: number;
}

/**
 * Current simulator state
 */
export interface SimulatorState {
  /** Whether a program is loaded */
  programLoaded: boolean;
  /** Current cycle count */
  currentCycle: number;
  /** State of all tiles */
  tiles: TileState[];
}

/**
 * State of a single tile
 */
export interface TileState {
  /** Tile identifier */
  id: number;
  /** Program counter */
  programCounter: number;
  /** Stack pointer */
  stackPointer: number;
  /** Register values */
  registers: number[];
}

/**
 * Cycle event emitted during execution
 */
export interface CycleEvent {
  /** Cycle number */
  cycle: number;
  /** Active tiles in this cycle */
  activeTiles: number[];
  /** Instructions executed */
  instructionsExecuted: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Event types supported by the SDK
 */
export interface SDKEvents {
  /** Emitted for each simulation cycle */
  cycle: CycleEvent;
  /** Emitted when simulation completes */
  complete: SimulationResults;
  /** Emitted on errors */
  error: Error;
}

/**
 * Unsubscribe function type
 */
export type Unsubscribe = () => void;
