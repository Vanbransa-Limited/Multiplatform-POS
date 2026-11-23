"use strict";
const { assertSafeEmulatorTarget, parseLoopbackEndpoint } = require('./emulator-safety.cjs');

/** Validate every target before importing a scenario or initializing an SDK. */
function emulatorTestTarget(environment = process.env) {
  const target = assertSafeEmulatorTarget(environment);
  const functionsHost = parseLoopbackEndpoint('FIREBASE_FUNCTIONS_EMULATOR_HOST', environment);
  const region = 'europe-west1';
  return { ...target, functionsHost, region, authBase: `http://${target.authHost}`,
    functionsBase: `http://${functionsHost}/${target.projectId}/${region}` };
}
module.exports = { emulatorTestTarget };
