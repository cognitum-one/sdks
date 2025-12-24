/**
 * Backend exports and factory
 */

export type { Backend, RawResults, RawState, RawStepResult } from './types.js';
export { WasmBackend } from './wasm.js';
export { NapiBackend } from './napi.js';
export { detectBackend, selectBackend, validateBackendAvailability } from './detection.js';

import type { Backend } from './types.js';
import type { SDKOptions } from '../types.js';
import { WasmBackend } from './wasm.js';
import { NapiBackend } from './napi.js';
import { selectBackend, validateBackendAvailability } from './detection.js';

/**
 * Create backend instance based on options
 */
export async function createBackend(options: SDKOptions = {}): Promise<Backend> {
  const backendType = selectBackend(options);

  await validateBackendAvailability(backendType);

  if (backendType === 'napi') {
    return NapiBackend.create(options);
  }

  // WASM backend
  if (backendType === 'wasm') {
    // In a real implementation, this would load the WASM module
    // For now, this is a placeholder
    throw new Error('WASM backend implementation pending - requires WASM bindings');
  }

  throw new Error(`Unsupported backend: ${backendType}`);
}
