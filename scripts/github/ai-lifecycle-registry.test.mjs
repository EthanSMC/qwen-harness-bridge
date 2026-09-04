import assert from "node:assert/strict";
import test from "node:test";

import {
  validateLifecycleMutationMode,
  validateLifecycleValidationMode,
} from "./ai-lifecycle-registry.mjs";

const NOW = "2026-09-04T12:00:00.000Z";
const ACTIVATION = "a".repeat(40);

const registry = (overrides = {}) => ({
  schema_version: 3,
  activation_commit: null,
  mutation_acceptance: {
    reason: "Bounded live acceptance",
    approved_by: "maintainer",
    approved_at: "2026-09-04T00:00:00.000Z",
    expires_at: "2026-09-11T00:00:00.000Z",
  },
  entries: [],
  ...overrides,
});

test("allows mutation enforcement only during acceptance or after activation", () => {
  assert.equal(
    validateLifecycleMutationMode(registry(), {
      mode: "enforce",
      now: NOW,
    }).phase,
    "acceptance",
  );
  assert.throws(
    () =>
      validateLifecycleMutationMode(
        registry({
          mutation_acceptance: {
            ...registry().mutation_acceptance,
            expires_at: NOW,
          },
        }),
        { mode: "enforce", now: NOW },
      ),
    /unexpired acceptance/i,
  );
  assert.throws(
    () =>
      validateLifecycleMutationMode(
        registry({
          mutation_acceptance: {
            ...registry().mutation_acceptance,
            expires_at: "2026-10-04T12:00:00.000Z",
          },
        }),
        { mode: "enforce", now: NOW },
      ),
    /acceptance window/i,
  );
  assert.equal(
    validateLifecycleMutationMode(
      registry({ activation_commit: ACTIVATION, mutation_acceptance: null }),
      { mode: "enforce", now: NOW },
    ).phase,
    "activated",
  );
});

test("never honors migrations after activation, including in report mode", () => {
  const entry = {
    pull_request: 51,
    issue: 46,
    reason: "Legacy pull request",
    approved_by: "maintainer",
    expires_at: "2026-09-11T00:00:00.000Z",
  };
  assert.throws(
    () =>
      validateLifecycleValidationMode(
        registry({
          activation_commit: ACTIVATION,
          mutation_acceptance: null,
          entries: [entry],
        }),
        {
          mode: "report",
          pullRequestNumber: 51,
          issueNumber: 46,
          now: NOW,
        },
      ),
    /activated.*forbids/i,
  );
});

test("acceptance approval cannot be future-dated or exceed seven days", () => {
  assert.throws(
    () =>
      validateLifecycleMutationMode(
        registry({
          mutation_acceptance: {
            ...registry().mutation_acceptance,
            approved_at: "2030-01-01T00:00:00.000Z",
            expires_at: "2030-01-07T00:00:00.000Z",
          },
        }),
        { mode: "report", now: NOW },
      ),
    /approval.*future/i,
  );
  assert.throws(
    () =>
      validateLifecycleMutationMode(
        registry({
          mutation_acceptance: {
            ...registry().mutation_acceptance,
            expires_at: "2026-09-12T00:00:00.000Z",
          },
        }),
        { mode: "report", now: NOW },
      ),
    /seven days|acceptance window/i,
  );
});

test("rejects malformed registries before selecting a rollout mode", () => {
  const malformed = registry();
  delete malformed.mutation_acceptance;
  assert.throws(
    () =>
      validateLifecycleMutationMode(malformed, { mode: "report", now: NOW }),
    /missing fields/i,
  );
});
