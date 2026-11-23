/** Mutation smoke test: only the explicitly configured local demo emulators. */
import { emulatorTestTarget } from './lib/test-target.cjs';

try {
  const target = emulatorTestTarget();
  console.log(`[smoke] Local demo target: ${target.projectId}`);
  await import('../backend/functions/e2e/scenario.mjs');
} catch (error) {
  console.error(`[smoke] ${error.message}`);
  process.exitCode = 1;
}
