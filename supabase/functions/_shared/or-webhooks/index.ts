/**
 * @orangerails/webhooks
 *
 * Typed signature verification for Orange Rails webhook deliveries.
 */

export {
  constructEvent,
  type ConstructEventOptions,
  type WebhookHeaders,
} from './construct-event.ts';

export {
  SignatureVerificationError,
  TimestampToleranceExceededError,
  MissingSignatureError,
} from './errors.ts';

export type { Event, SyncCompletedEvent, EventType } from './types.ts';

// Low-level primitives, exported for advanced use cases (e.g. signing
// in fixtures/tests). Most consumers should use `constructEvent`.
export { computeHmacSha256Hex, timingSafeEqualHex } from './verify.ts';
