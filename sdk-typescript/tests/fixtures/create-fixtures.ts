/**
 * Create test fixture files
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

// Simple valid program (placeholder)
const validProgram = new Uint8Array([
  0x43, 0x4F, 0x47, 0x4E, // Magic: "COGN"
  0x01, 0x00, 0x00, 0x00, // Version
  0x10, 0x00, 0x00, 0x00, // Instructions: 16
  // Simple instructions
  0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08,
]);

const simpleProgram = new Uint8Array([
  0x43, 0x4F, 0x47, 0x4E,
  0x01, 0x00, 0x00, 0x00,
  0x08, 0x00, 0x00, 0x00,
  0x01, 0x02, 0x03, 0x04,
]);

const fixturesDir = __dirname;

writeFileSync(join(fixturesDir, 'valid_program.bin'), validProgram);
writeFileSync(join(fixturesDir, 'simple_program.bin'), simpleProgram);

console.log('Test fixtures created successfully');
