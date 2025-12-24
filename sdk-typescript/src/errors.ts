/**
 * Custom error types for Cognitum SDK
 */

/**
 * Base error for SDK operations
 */
export class CognitumError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'CognitumError';
  }
}

/**
 * Error for invalid program data
 */
export class ProgramError extends CognitumError {
  constructor(message: string) {
    super(message, 'PROGRAM_ERROR');
    this.name = 'ProgramError';
  }
}

/**
 * Error for invalid configuration
 */
export class ConfigurationError extends CognitumError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigurationError';
  }
}

/**
 * Error for backend initialization failures
 */
export class BackendError extends CognitumError {
  constructor(message: string, public originalError?: unknown) {
    super(message, 'BACKEND_ERROR');
    this.name = 'BackendError';
  }
}

/**
 * Error for simulation execution failures
 */
export class SimulationError extends CognitumError {
  constructor(message: string) {
    super(message, 'SIMULATION_ERROR');
    this.name = 'SimulationError';
  }
}
