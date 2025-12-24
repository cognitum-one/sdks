/**
 * @ruv/cognitum-sdk - TypeScript SDK for Cognitum chip simulator
 *
 * @packageDocumentation
 */

// Main SDK class
export { CognitumSDK } from './sdk.js';

// Configuration
export { ConfigBuilder } from './config.js';

// Types
export type {
  SDKOptions,
  SimulationResults,
  StepResult,
  SimulatorState,
  TileState,
  CycleEvent,
  SDKEvents,
  Unsubscribe,
} from './types.js';

export { ExitReason } from './types.js';

// Errors
export {
  CognitumError,
  ProgramError,
  ConfigurationError,
  BackendError,
  SimulationError,
} from './errors.js';

// Backend utilities (advanced usage)
export type { Backend } from './backends/index.js';
export { detectBackend, selectBackend } from './backends/index.js';
