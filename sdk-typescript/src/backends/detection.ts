/**
 * Backend auto-detection
 */

import type { SDKOptions } from '../types.js';
import { BackendError } from '../errors.js';

/**
 * Detect best backend for current environment
 */
export function detectBackend(): 'wasm' | 'napi' {
  // Check if we're in Node.js
  if (typeof process !== 'undefined' && process.versions?.node) {
    // Try to detect NAPI availability
    try {
      // Check if native module is available
      require.resolve('@ruv/cognitum');
      return 'napi';
    } catch {
      // NAPI not available, fallback to WASM
      return 'wasm';
    }
  }

  // Browser environment, use WASM
  return 'wasm';
}

/**
 * Select backend based on options
 */
export function selectBackend(options: SDKOptions): 'wasm' | 'napi' {
  if (!options.backend || options.backend === 'auto') {
    return detectBackend();
  }

  return options.backend;
}

/**
 * Validate backend availability
 */
export async function validateBackendAvailability(
  backend: 'wasm' | 'napi'
): Promise<void> {
  if (backend === 'napi') {
    // Check Node.js environment
    if (typeof process === 'undefined' || !process.versions?.node) {
      throw new BackendError(
        'NAPI backend requires Node.js environment'
      );
    }

    // Check if native module is available
    try {
      require.resolve('@ruv/cognitum');
    } catch (error) {
      throw new BackendError(
        'NAPI backend not available. Install @ruv/cognitum package.',
        error
      );
    }
  }

  if (backend === 'wasm') {
    // Check WebAssembly support
    if (typeof WebAssembly === 'undefined') {
      throw new BackendError(
        'WASM backend requires WebAssembly support'
      );
    }
  }
}
