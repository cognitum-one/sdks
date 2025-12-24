# @ruv/cognitum-sdk

TypeScript SDK for the Cognitum chip simulator - a massively parallel tile-based computing architecture.

## Features

- 🚀 **High Performance**: Auto-selects best backend (NAPI for Node.js, WASM for browsers)
- 🎯 **Type-Safe**: Full TypeScript support with comprehensive types
- 📊 **Event Streaming**: RxJS Observable support for real-time monitoring
- 🔧 **Flexible API**: Simple high-level API with advanced control options
- ⚡ **Zero Config**: Works out of the box with sensible defaults

## Installation

```bash
npm install @ruv/cognitum-sdk
```

For Node.js native performance (optional):

```bash
npm install @ruv/cognitum
```

## Quick Start

```typescript
import { CognitumSDK } from '@ruv/cognitum-sdk';

// Create SDK instance
const sdk = await CognitumSDK.create();

// Load program
const program = new Uint8Array([/* your program bytes */]);
await sdk.loadProgram(program);

// Run simulation
const results = await sdk.run();

console.log(`Executed ${results.cyclesExecuted} cycles`);
console.log(`Instructions: ${results.instructionsExecuted}`);
console.log(`Exit reason: ${results.exitReason}`);
```

## API Reference

### Creating SDK Instance

```typescript
import { CognitumSDK, ConfigBuilder } from '@ruv/cognitum-sdk';

// Default configuration
const sdk = await CognitumSDK.create();

// Custom configuration
const sdk = await CognitumSDK.create({
  tiles: 64,
  memoryPerTile: 156000,
  backend: 'auto', // 'auto' | 'wasm' | 'napi'
});

// Using ConfigBuilder
const config = new ConfigBuilder()
  .tiles(32)
  .memoryPerTile(156000)
  .useNapi()
  .build();

const sdk = await CognitumSDK.create(config);
```

### Loading Programs

```typescript
// From Uint8Array
const program = new Uint8Array([0x01, 0x02, 0x03]);
await sdk.loadProgram(program);

// From file (Node.js only)
await sdk.loadProgram('./program.bin');
```

### Running Simulations

```typescript
// Run until completion
const results = await sdk.run();

// Run for specific cycles
const results = await sdk.runFor(1000);

// Step through cycles
for (let i = 0; i < 100; i++) {
  const step = await sdk.step();
  console.log(`Cycle ${step.cycle}: ${step.instructionsExecuted} instructions`);
}
```

### Event Handling

```typescript
// Register event handlers
const unsubscribe = sdk.on('cycle', (event) => {
  console.log(`Cycle ${event.cycle}`);
});

sdk.on('complete', (results) => {
  console.log('Simulation complete!', results);
});

// Unsubscribe
unsubscribe();
```

### RxJS Streams

```typescript
import { take, map } from 'rxjs';

// Get Observable stream
const stream = sdk.stream();

// Monitor first 100 cycles
stream.pipe(
  take(100),
  map(event => event.cycle)
).subscribe({
  next: (cycle) => console.log(`Cycle: ${cycle}`),
  complete: () => console.log('Done monitoring'),
});

// Run simulation
await sdk.runFor(1000);
```

### State Inspection

```typescript
const state = sdk.getState();

console.log(`Program loaded: ${state.programLoaded}`);
console.log(`Current cycle: ${state.currentCycle}`);
console.log(`Number of tiles: ${state.tiles.length}`);

// Inspect individual tiles
state.tiles.forEach(tile => {
  console.log(`Tile ${tile.id}:`);
  console.log(`  PC: ${tile.programCounter}`);
  console.log(`  SP: ${tile.stackPointer}`);
  console.log(`  Registers: ${tile.registers.join(', ')}`);
});
```

### Reset and Cleanup

```typescript
// Reset simulator to initial state
sdk.reset();

// Clean up resources
sdk.dispose();
```

## Types

### SimulationResults

```typescript
interface SimulationResults {
  cyclesExecuted: number;
  instructionsExecuted: number;
  tilesUsed: number;
  memoryBytesAccessed: number;
  exitReason: ExitReason;
}

enum ExitReason {
  ProgramComplete = 'program_complete',
  CycleLimit = 'cycle_limit',
  Error = 'error',
  UserHalt = 'user_halt',
}
```

### StepResult

```typescript
interface StepResult {
  cycle: number;
  activeTiles: number[];
  instructionsExecuted: number;
}
```

### SimulatorState

```typescript
interface SimulatorState {
  programLoaded: boolean;
  currentCycle: number;
  tiles: TileState[];
}

interface TileState {
  id: number;
  programCounter: number;
  stackPointer: number;
  registers: number[];
}
```

## Error Handling

```typescript
import {
  CognitumError,
  ProgramError,
  ConfigurationError,
  BackendError,
  SimulationError,
} from '@ruv/cognitum-sdk';

try {
  await sdk.loadProgram(invalidProgram);
} catch (error) {
  if (error instanceof ProgramError) {
    console.error('Invalid program:', error.message);
  } else if (error instanceof BackendError) {
    console.error('Backend error:', error.message);
  }
}
```

## Advanced Usage

### Backend Selection

```typescript
import { detectBackend } from '@ruv/cognitum-sdk';

// Detect best backend for environment
const backend = detectBackend();
console.log(`Using backend: ${backend}`);

// Force specific backend
const sdk = await CognitumSDK.create({ backend: 'wasm' });
console.log(`Backend type: ${sdk.backendType}`);
```

### Performance Monitoring

```typescript
const startTime = Date.now();

sdk.on('cycle', (event) => {
  const elapsed = Date.now() - startTime;
  const cyclesPerSecond = (event.cycle / elapsed) * 1000;
  console.log(`Performance: ${cyclesPerSecond.toFixed(0)} cycles/sec`);
});

await sdk.runFor(10000);
```

## Examples

### Simple Computation

```typescript
import { CognitumSDK } from '@ruv/cognitum-sdk';

async function runSimpleComputation() {
  const sdk = await CognitumSDK.create();

  // Load your program
  await sdk.loadProgram('./fibonacci.bin');

  // Run simulation
  const results = await sdk.run();

  console.log('Results:', results);
  console.log('Final state:', sdk.getState());
}
```

### Real-time Monitoring

```typescript
import { CognitumSDK } from '@ruv/cognitum-sdk';

async function monitorSimulation() {
  const sdk = await CognitumSDK.create({ tiles: 64 });

  await sdk.loadProgram('./program.bin');

  // Monitor every cycle
  sdk.on('cycle', (event) => {
    console.log(`[${event.cycle}] Active tiles: ${event.activeTiles.length}`);
  });

  // Run for 1000 cycles
  const results = await sdk.runFor(1000);

  console.log('Simulation complete:', results);
}
```

### Debugging with Step Mode

```typescript
import { CognitumSDK } from '@ruv/cognitum-sdk';

async function debugProgram() {
  const sdk = await CognitumSDK.create();

  await sdk.loadProgram('./debug.bin');

  // Step through first 10 cycles
  for (let i = 0; i < 10; i++) {
    const step = await sdk.step();
    const state = sdk.getState();

    console.log(`\n=== Cycle ${step.cycle} ===`);
    console.log(`Active tiles: ${step.activeTiles.join(', ')}`);
    console.log(`Instructions: ${step.instructionsExecuted}`);

    // Inspect first tile
    const tile0 = state.tiles[0];
    console.log(`Tile 0 PC: ${tile0.programCounter}`);
  }
}
```

## Browser Support

The SDK works in all modern browsers with WebAssembly support:

```html
<script type="module">
  import { CognitumSDK } from 'https://esm.sh/@ruv/cognitum-sdk';

  const sdk = await CognitumSDK.create();
  // Use SDK...
</script>
```

## Node.js Compatibility

- Node.js 18+
- ESM and CommonJS support
- Native NAPI bindings for optimal performance

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Build
npm run build

# Type check
npm run typecheck
```

## License

MIT

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](../../CONTRIBUTING.md) for details.

## Support

- Documentation: https://cognitum.ruv.io/sdk
- Issues: https://github.com/ruvnet/cognitum/issues
- Discord: https://discord.gg/cognitum

---

Built with ❤️ by the Cognitum team
