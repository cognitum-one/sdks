/**
 * Configuration builder for SDK
 */

import type { SDKOptions } from './types.js';

/**
 * Fluent builder for SDK configuration
 */
export class ConfigBuilder {
  private config: SDKOptions = {};

  /**
   * Set number of tiles
   */
  tiles(count: number): this {
    this.config.tiles = count;
    return this;
  }

  /**
   * Set memory per tile
   */
  memoryPerTile(bytes: number): this {
    this.config.memoryPerTile = bytes;
    return this;
  }

  /**
   * Use WASM backend
   */
  useWasm(wasmPath?: string): this {
    this.config.backend = 'wasm';
    if (wasmPath) {
      this.config.wasmPath = wasmPath;
    }
    return this;
  }

  /**
   * Use NAPI backend (Node.js native)
   */
  useNapi(): this {
    this.config.backend = 'napi';
    return this;
  }

  /**
   * Auto-detect best backend
   */
  auto(): this {
    this.config.backend = 'auto';
    return this;
  }

  /**
   * Build configuration
   */
  build(): SDKOptions {
    return { ...this.config };
  }
}
