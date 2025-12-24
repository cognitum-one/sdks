/**
 * Unit tests for validation utilities
 */

import { describe, it, expect } from 'vitest';
import { validateProgram, validateCycleCount, validateSDKOptions } from '../../src/validation.js';
import { ProgramError, ConfigurationError } from '../../src/errors.js';

describe('Validation', () => {
  describe('validateProgram', () => {
    it('should accept valid program', () => {
      const program = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      expect(() => validateProgram(program)).not.toThrow();
    });

    it('should reject empty program', () => {
      expect(() => validateProgram(new Uint8Array(0)))
        .toThrow(ProgramError);
    });

    it('should reject too short program', () => {
      expect(() => validateProgram(new Uint8Array([0x01])))
        .toThrow(ProgramError);
    });

    it('should reject non-Uint8Array', () => {
      expect(() => validateProgram([] as any))
        .toThrow(ProgramError);
    });
  });

  describe('validateCycleCount', () => {
    it('should accept valid cycle count', () => {
      expect(() => validateCycleCount(100)).not.toThrow();
      expect(() => validateCycleCount(1)).not.toThrow();
    });

    it('should reject zero', () => {
      expect(() => validateCycleCount(0))
        .toThrow(ConfigurationError);
    });

    it('should reject negative', () => {
      expect(() => validateCycleCount(-1))
        .toThrow(ConfigurationError);
    });

    it('should reject non-integer', () => {
      expect(() => validateCycleCount(3.14))
        .toThrow(ConfigurationError);
    });
  });

  describe('validateSDKOptions', () => {
    it('should accept valid options', () => {
      expect(() => validateSDKOptions({
        tiles: 16,
        memoryPerTile: 156000,
        backend: 'auto',
      })).not.toThrow();
    });

    it('should reject invalid tile count', () => {
      expect(() => validateSDKOptions({ tiles: 0 }))
        .toThrow(ConfigurationError);
      expect(() => validateSDKOptions({ tiles: 300 }))
        .toThrow(ConfigurationError);
    });

    it('should reject invalid memory', () => {
      expect(() => validateSDKOptions({ memoryPerTile: -1 }))
        .toThrow(ConfigurationError);
    });

    it('should reject invalid backend', () => {
      expect(() => validateSDKOptions({ backend: 'invalid' as any }))
        .toThrow(ConfigurationError);
    });
  });
});
