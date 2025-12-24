/**
 * Event emitter implementation
 */

import type { Unsubscribe } from './types.js';

/**
 * Simple type-safe event emitter
 */
export class EventEmitter<TEvents extends Record<string, any>> {
  private handlers: Map<keyof TEvents, Set<Function>> = new Map();

  /**
   * Register event handler
   */
  on<K extends keyof TEvents>(
    event: K,
    handler: (data: TEvents[K]) => void
  ): Unsubscribe {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }

    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      const eventHandlers = this.handlers.get(event);
      if (eventHandlers) {
        eventHandlers.delete(handler);
      }
    };
  }

  /**
   * Emit event to all handlers
   */
  emit<K extends keyof TEvents>(event: K, data: TEvents[K]): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      eventHandlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in event handler for ${String(event)}:`, error);
        }
      });
    }
  }

  /**
   * Clear all handlers
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Clear handlers for specific event
   */
  clearEvent<K extends keyof TEvents>(event: K): void {
    this.handlers.delete(event);
  }
}
