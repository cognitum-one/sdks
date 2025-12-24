/**
 * Acceptance tests for SDK initialization
 */

import { describe, it, expect, vi } from 'vitest';
import { CognitumSDK, ConfigBuilder } from '../../src/index.js';
import { MockBackend } from '../mocks/backend.js';

// Mock the backend creation for acceptance tests
vi.mock('../../src/backends/index.js', async () => {
  const actual = await vi.importActual('../../src/backends/index.js');
  return {
    ...actual,
    createBackend: vi.fn().mockResolvedValue(new MockBackend()),
  };
});

describe('SDK Initialization (Acceptance)', () => {
  /**
   * Acceptance Criteria:
   * - SDK creates successfully with defaults
   * - SDK auto-detects best backend
   * - SDK respects explicit backend choice
   * - SDK configures tile count and memory
   */

  it('should create SDK with default configuration', async () => {
    const sdk = await CognitumSDK.create();

    expect(sdk).toBeInstanceOf(CognitumSDK);
    expect(sdk.getState().programLoaded).toBe(false);
  });

  it('should detect backend in environment', async () => {
    const sdk = await CognitumSDK.create({ backend: 'auto' });

    expect(sdk.backendType).toBeDefined();
    expect(['wasm', 'napi']).toContain(sdk.backendType);
  });

  it('should configure tiles using builder', async () => {
    const config = new ConfigBuilder()
      .tiles(64)
      .memoryPerTile(156000)
      .build();

    expect(config.tiles).toBe(64);
    expect(config.memoryPerTile).toBe(156000);

    const sdk = await CognitumSDK.create(config);
    expect(sdk).toBeInstanceOf(CognitumSDK);
  });

  it('should support fluent configuration', async () => {
    const config = new ConfigBuilder()
      .tiles(32)
      .memoryPerTile(100000)
      .auto()
      .build();

    expect(config.tiles).toBe(32);
    expect(config.backend).toBe('auto');
  });
});
