/**
 * Unit tests for EventEmitter
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../../src/events.js';

describe('EventEmitter', () => {
  it('should register and call handlers', () => {
    const emitter = new EventEmitter<{ cycle: number }>();
    const handler = vi.fn();

    emitter.on('cycle', handler);
    emitter.emit('cycle', 42);

    expect(handler).toHaveBeenCalledWith(42);
  });

  it('should support multiple handlers', () => {
    const emitter = new EventEmitter<{ cycle: number }>();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    emitter.on('cycle', handler1);
    emitter.on('cycle', handler2);
    emitter.emit('cycle', 42);

    expect(handler1).toHaveBeenCalledWith(42);
    expect(handler2).toHaveBeenCalledWith(42);
  });

  it('should return unsubscribe function', () => {
    const emitter = new EventEmitter<{ cycle: number }>();
    const handler = vi.fn();

    const unsubscribe = emitter.on('cycle', handler);
    unsubscribe();
    emitter.emit('cycle', 42);

    expect(handler).not.toHaveBeenCalled();
  });

  it('should clear all handlers', () => {
    const emitter = new EventEmitter<{ cycle: number; complete: string }>();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    emitter.on('cycle', handler1);
    emitter.on('complete', handler2);
    emitter.clear();
    emitter.emit('cycle', 42);
    emitter.emit('complete', 'done');

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });

  it('should clear handlers for specific event', () => {
    const emitter = new EventEmitter<{ cycle: number; complete: string }>();
    const cycleHandler = vi.fn();
    const completeHandler = vi.fn();

    emitter.on('cycle', cycleHandler);
    emitter.on('complete', completeHandler);
    emitter.clearEvent('cycle');
    emitter.emit('cycle', 42);
    emitter.emit('complete', 'done');

    expect(cycleHandler).not.toHaveBeenCalled();
    expect(completeHandler).toHaveBeenCalledWith('done');
  });

  it('should handle errors in handlers gracefully', () => {
    const emitter = new EventEmitter<{ cycle: number }>();
    const errorHandler = vi.fn(() => {
      throw new Error('Handler error');
    });
    const normalHandler = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    emitter.on('cycle', errorHandler);
    emitter.on('cycle', normalHandler);
    emitter.emit('cycle', 42);

    expect(errorHandler).toHaveBeenCalled();
    expect(normalHandler).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
