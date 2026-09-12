// @ts-check
// Compile-time canary. This file has no runtime job and is never loaded by the
// extension. It exists so that `tsc --noEmit` fails if the generated protocol types
// are deleted, renamed, or narrowed in a way that stops describing a real envelope --
// until D07 adopts them, nothing else in the tree references protocol.d.ts, so
// without this file a broken artifact would go unnoticed.
//
// It cannot police its own membership in the project: if this file is dropped from
// tsconfig `include`, tsc simply stops checking it and still exits 0. The CI type
// check asserts on `tsc --listFiles` to close that gap.

/** @import { RequestFor, ResponseFor, MessageType } from "../desktop/crates/protocol/js/protocol.d.ts" */

/** @type {MessageType} */
export const writeType = 'job.save';

/** @type {RequestFor<'job.save'>} */
export const request = {
  protocolVersion: 1,
  messageId: '00000000-0000-4000-8000-000000000000',
  clientInstanceId: '11111111-1111-4111-8111-111111111111',
  messageType: 'job.save',
  occurredAt: '2026-01-01T00:00:00Z',
  payload: {
    sourceRestoreEpoch: '22222222-2222-4222-8222-222222222222',
    payloadSha256: '0'.repeat(64),
    company: 'Example',
    title: 'Engineer'
  }
};

/** @type {ResponseFor<'application.queryCandidates'>} */
export const candidates = {
  protocolVersion: 1,
  correlationId: '33333333-3333-4333-8333-333333333333',
  ok: true,
  payload: { exact: [], sameCompany: [] }
};
