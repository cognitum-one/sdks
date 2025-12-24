/**
 * Unit tests for backend detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectBackend, selectBackend } from '../../src/backends/detection.js';

describe('Backend Detection', () => {
  let originalProcess: any;
  let originalWindow: any;

  beforeEach(() => {
    originalProcess = global.process;
    originalWindow = (global as any).window;
  });

  afterEach(() => {
    global.process = originalProcess;
    (global as any).window = originalWindow;
  });

  describe('detectBackend', () => {
    it('should detect NAPI in Node.js environment', () => {
      // Mock Node.js environment
      (global as any).process = {
        versions: { node: '18.0.0' },
      };

      // Mock require.resolve to simulate NAPI availability
      const originalRequire = global.require;
      (global as any).require = {
        resolve: vi.fn().mockReturnValue('/path/to/module'),
      };

      const backend = detectBackend();

      (global as any).require = originalRequire;
      expect(backend).toBe('napi');
    });

    it('should detect WASM in browser environment', () => {
      // Mock browser environment
      delete (global as any).process;
      (global as any).window = {};

      const backend = detectBackend();

      expect(backend).toBe('wasm');
    });

    it('should fallback to WASM when NAPI unavailable', () => {
      // Mock Node.js but NAPI not available
      (global as any).process = {
        versions: { node: '18.0.0' },
      };

      const originalRequire = global.require;
      (global as any).require = {
        resolve: vi.fn().mockImplementation(() => {
          throw new Error('Module not found');
        }),
      };

      const backend = detectBackend();

      (global as any).require = originalRequire;
      expect(backend).toBe('wasm');
    });
  });

  describe('selectBackend', () => {
    it('should use auto-detection by default', () => {
      (global as any).process = {
        versions: { node: '18.0.0' },
      };

      const backend = selectBackend({});

      expect(backend).toBe('wasm'); // Fallback in test environment
    });

    it('should respect explicit backend choice', () => {
      const backend = selectBackend({ backend: 'wasm' });

      expect(backend).toBe('wasm');
    });

    it('should handle explicit NAPI selection', () => {
      const backend = selectBackend({ backend: 'napi' });

      expect(backend).toBe('napi');
    });
  });
});
