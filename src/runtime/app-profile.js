/**
 * App Profile — thin compatibility layer.
 * Real detection logic lives in runtime-orchestrator.js (Preview Engine 2.0).
 */
export { detectAppProfile, detectRuntimeProfile } from './runtime-orchestrator.js';
export { detectAppProfile as default } from './runtime-orchestrator.js';
