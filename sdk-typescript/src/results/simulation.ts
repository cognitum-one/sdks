/**
 * Simulation results transformation
 */

import type { SimulationResults } from '../types.js';
import { ExitReason } from '../types.js';
import type { RawResults } from '../backends/types.js';

/**
 * Transform raw results to typed results
 */
export function transformResults(raw: RawResults): SimulationResults {
  return {
    cyclesExecuted: raw.cyclesExecuted,
    instructionsExecuted: raw.instructionsExecuted,
    tilesUsed: raw.tilesUsed,
    memoryBytesAccessed: raw.memoryBytesAccessed,
    exitReason: parseExitReason(raw.exitReason),
  };
}

/**
 * Parse exit reason string to enum
 */
function parseExitReason(reason: string): ExitReason {
  switch (reason) {
    case 'program_complete':
    case 'complete':
      return ExitReason.ProgramComplete;
    case 'cycle_limit':
      return ExitReason.CycleLimit;
    case 'user_halt':
      return ExitReason.UserHalt;
    case 'error':
      return ExitReason.Error;
    default:
      console.warn(`Unknown exit reason: ${reason}, defaulting to Error`);
      return ExitReason.Error;
  }
}
