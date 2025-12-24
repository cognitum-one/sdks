/**
 * Step result transformation
 */

import type { StepResult } from '../types.js';
import type { RawStepResult } from '../backends/types.js';

/**
 * Transform raw step result to typed result
 */
export function transformStepResult(raw: RawStepResult): StepResult {
  return {
    cycle: raw.cycle,
    activeTiles: raw.activeTiles || [],
    instructionsExecuted: raw.instructionsExecuted || 0,
  };
}
