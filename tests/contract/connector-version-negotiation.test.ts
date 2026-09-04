import {
  ConnectorClientMessageSchema,
  ConnectorServerMessageSchema,
} from "@qhb/protocol";
import { describe, expect, it } from "vitest";
import { buildConnectorHello } from "../../packages/harness-plugin/src/transport/connector-client.js";

describe("connector protocol version negotiation", () => {
  it("builds a protocol 1.0 hello accepted by the shared client schema", () => {
    const hello = buildConnectorHello({
      connectorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sequence: 1,
      lastServerSequence: 0,
      correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      now: new Date("2026-09-05T00:00:00.000Z"),
    });

    expect(ConnectorClientMessageSchema.parse(hello)).toMatchObject({
      protocol_version: "1.0",
      type: "connector.hello",
      payload: {
        connector_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        last_server_sequence: 0,
      },
    });
  });

  it("does not accept a server envelope from a different protocol version", () => {
    expect(() =>
      ConnectorServerMessageSchema.parse({
        protocol_version: "2.0",
        message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sequence: 1,
        sent_at: "2026-09-05T00:00:00.000Z",
        expires_at: "2026-09-05T00:01:00.000Z",
        correlation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        type: "connector.welcome",
        payload: {
          connector_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          server_sequence: 1,
          replay_from: 1,
        },
      }),
    ).toThrow();
  });
});
