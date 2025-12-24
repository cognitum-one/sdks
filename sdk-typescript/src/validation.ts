/**
 * Input validation utilities
 */

import { ProgramError, ConfigurationError } from './errors.js';

/**
 * Validate program data
 */
export function validateProgram(program: Uint8Array): void {
  if (!(program instanceof Uint8Array)) {
    throw new ProgramError('Program must be a Uint8Array');
  }

  if (program.length === 0) {
    throw new ProgramError('Empty program');
  }

  // Basic format validation (actual validation happens in backend)
  if (program.length < 4) {
    throw new ProgramError('Invalid program format');
  }
}

/**
 * Validate cycle count
 */
export function validateCycleCount(cycles: number): void {
  if (!Number.isInteger(cycles) || cycles <= 0) {
    throw new ConfigurationError('Invalid cycle count: must be a positive integer');
  }

  if (cycles > Number.MAX_SAFE_INTEGER) {
    throw new ConfigurationError('Cycle count too large');
  }
}

/**
 * Validate SDK options
 */
export function validateSDKOptions(options: any): void {
  if (options.tiles !== undefined) {
    if (!Number.isInteger(options.tiles) || options.tiles <= 0 || options.tiles > 256) {
      throw new ConfigurationError('Tiles must be between 1 and 256');
    }
  }

  if (options.memoryPerTile !== undefined) {
    if (!Number.isInteger(options.memoryPerTile) || options.memoryPerTile <= 0) {
      throw new ConfigurationError('Memory per tile must be positive');
    }
  }

  if (options.backend !== undefined) {
    const validBackends = ['auto', 'wasm', 'napi'];
    if (!validBackends.includes(options.backend)) {
      throw new ConfigurationError(`Backend must be one of: ${validBackends.join(', ')}`);
    }
  }
}
