/**
 * RxJS Observable stream implementation
 */

import { Observable } from 'rxjs';
import type { Backend } from './backends/types.js';
import type { CycleEvent } from './types.js';

/**
 * Create Observable stream from backend cycle events
 */
export function createCycleStream(backend: Backend): Observable<CycleEvent> {
  return new Observable<CycleEvent>((subscriber) => {
    // Register cycle handler
    backend.onCycle((cycle, state) => {
      const event: CycleEvent = {
        cycle,
        activeTiles: state.activeTiles ? [state.activeTiles] : [],
        instructionsExecuted: state.instructionsExecuted ?? 0,
        timestamp: Date.now(),
      };

      subscriber.next(event);
    });

    // Cleanup on unsubscribe
    return () => {
      // Reset backend cycle handler
      backend.onCycle(() => {});
    };
  });
}
