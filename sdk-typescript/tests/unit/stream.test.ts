/**
 * Unit tests for Observable stream
 */

import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom, take, toArray } from 'rxjs';
import { createCycleStream } from '../../src/stream.js';
import { MockBackend } from '../mocks/backend.js';

describe('Observable Stream', () => {
  it('should create Observable from backend events', async () => {
    const mockBackend = new MockBackend();
    const stream = createCycleStream(mockBackend);

    const eventPromise = firstValueFrom(stream);

    // Trigger event after a short delay
    setTimeout(() => {
      mockBackend.triggerCycleEvent(1);
    }, 10);

    const event = await eventPromise;
    expect(event.cycle).toBe(1);
    expect(event.activeTiles).toBeDefined();
  });

  it('should emit multiple events', async () => {
    const mockBackend = new MockBackend();
    const stream = createCycleStream(mockBackend);

    const events: any[] = [];
    const subscription = stream.subscribe({
      next: (e) => events.push(e),
    });

    mockBackend.triggerCycleEvent(1);
    mockBackend.triggerCycleEvent(2);
    mockBackend.triggerCycleEvent(3);

    subscription.unsubscribe();

    expect(events).toHaveLength(3);
    expect(events[0].cycle).toBe(1);
    expect(events[1].cycle).toBe(2);
    expect(events[2].cycle).toBe(3);
  });

  it('should support RxJS operators', async () => {
    const mockBackend = new MockBackend();
    const stream = createCycleStream(mockBackend);

    const eventPromise = firstValueFrom(
      stream.pipe(take(3), toArray())
    );

    // Emit events
    setTimeout(() => {
      mockBackend.triggerCycleEvent(1);
      mockBackend.triggerCycleEvent(2);
      mockBackend.triggerCycleEvent(3);
      mockBackend.triggerCycleEvent(4);
    }, 10);

    const events = await eventPromise;
    expect(events).toHaveLength(3);
  });

  it('should cleanup on unsubscribe', () => {
    const mockBackend = new MockBackend();
    const stream = createCycleStream(mockBackend);

    const handler = vi.fn();
    const subscription = stream.subscribe(handler);

    mockBackend.triggerCycleEvent(1);
    expect(handler).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    mockBackend.triggerCycleEvent(2);

    // Should still be 1, as we unsubscribed
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
