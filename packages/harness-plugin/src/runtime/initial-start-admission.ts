import type { JobStatePayload } from "@qhb/protocol";
import type { OwnedIntent } from "../store/owned-intent.js";
import {
  type CoordinationClockSample,
  type CoordinationTiming,
  isCoordinationTimingCurrent,
} from "./coordination-deadlines.js";
import type { JobOfferMessage } from "./job-command-coordinator.js";

export type InitialStartMode = JobStatePayload["mode"];

/** ADR 0005 fresh-state admission for the first native start of a prepared
 * owned attempt. The caller must have consumed the claim ACK and admitted the
 * timing for this exact state exchange; this predicate grants only the recorded
 * mode and never issues authority, mutates the journal or creates an Agent.
 * Every check must hold; a failed admission leaves the prepared intent intact
 * for explicit recovery rather than a second execution. */
export function admitInitialStart(
  input: Readonly<{
    state: JobStatePayload;
    offer: JobOfferMessage;
    intent: OwnedIntent;
    repositoryId: string;
    timing: CoordinationTiming;
    now: CoordinationClockSample;
  }>,
): Readonly<{ mode: InitialStartMode }> | undefined {
  try {
    const { state, offer, intent, repositoryId, timing, now } = input;
    if (
      intent.phase !== "prepared" ||
      intent.mode !== null ||
      intent.unavailable !== null ||
      intent.owner.jobId !== offer.payload.job_id ||
      intent.owner.attempt !== offer.payload.attempt ||
      intent.owner.repositoryId !== offer.payload.repository_id
    )
      return undefined;
    if (
      state.job_id !== offer.payload.job_id ||
      state.repository_id !== repositoryId ||
      state.requested_attempt !== offer.payload.attempt ||
      state.current_attempt !== offer.payload.attempt ||
      state.status !== "running" ||
      state.lease_id === null ||
      state.lease_id !== offer.payload.lease_id ||
      state.lease_expires_at === null
    )
      return undefined;
    if (
      !isCoordinationTimingCurrent(timing, now, {
        snapshot: true,
        lease: true,
      })
    )
      return undefined;
    return Object.freeze({ mode: state.mode });
  } catch {
    return undefined;
  }
}
