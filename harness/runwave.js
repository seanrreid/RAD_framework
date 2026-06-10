/**
 * DEPRECATED shim — the SDK wave runner now lives in
 * ./adapters/agent/sdk.js. This re-export keeps cli.js working until Wave 3
 * rewires it; new code should import createRunWave from the adapter directly.
 */
export { createRunWave } from './adapters/agent/sdk.js';
