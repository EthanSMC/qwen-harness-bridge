import { type RtcMedia, RtcWireError } from "./qwen-rtc-schema.js";

export type RtcOutputCommand =
  | { type: "SPEAK"; text: string; appendHighlight?: string }
  | { type: "STOP_OUTPUT" }
  | { type: "APPEND_HIGHLIGHT"; text: string };

export type WireSpeakAction = Readonly<{
  type: "SPEAK";
  payload: Readonly<{
    speechId: string;
    index: number;
    hasNext: boolean;
    text: string;
    textDisplayMode?: "NONE" | "APPEND_HIGHLIGHT";
  }>;
}>;

export type WireStopOutputAction = Readonly<{
  type: "STOP_OUTPUT";
  payload: Readonly<{ scope: "SPEAK"; reason?: string }>;
}>;

export type WireAction = WireSpeakAction | WireStopOutputAction;

export type OutputFrame = Readonly<{
  sessionId: string;
  actions: readonly WireAction[];
  final: boolean;
}>;

export type WireActionOptions = Readonly<{
  speechId: string;
  startIndex: number;
  hasNext: boolean;
  reason?: string;
}>;

export const RTC_SPEC_VERSION = "1.0";
export const KEEPALIVE_FRAME = ": keep-alive\n\n";

const fail = (
  code: "UNKNOWN_ACTION" | "UNKNOWN_FRAME" | "UNKNOWN_COMMAND",
  message: string,
): never => {
  throw new RtcWireError(code, `${code}: ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    fail("UNKNOWN_ACTION", `${label} is required`);
  }
  return value as string;
};

const normalizeSpeak = (payload: Record<string, unknown>): WireSpeakAction => {
  const speechId = requireString(payload.speechId, "payload.speechId");
  const index = payload.index;
  if (!Number.isSafeInteger(index) || (index as number) < 1) {
    fail("UNKNOWN_ACTION", "payload.index must be a positive integer");
  }
  const hasNext = payload.hasNext;
  if (typeof hasNext !== "boolean") {
    fail("UNKNOWN_ACTION", "payload.hasNext must be a boolean");
  }
  const text = requireString(payload.text, "payload.text");
  const mode = payload.textDisplayMode;
  if (mode !== undefined && mode !== "NONE" && mode !== "APPEND_HIGHLIGHT") {
    fail("UNKNOWN_ACTION", "payload.textDisplayMode is not supported");
  }
  return {
    type: "SPEAK",
    payload: {
      speechId,
      index: index as number,
      hasNext: hasNext as boolean,
      text,
      ...(mode === undefined
        ? {}
        : { textDisplayMode: mode as "NONE" | "APPEND_HIGHLIGHT" }),
    },
  };
};

const normalizeStop = (
  payload: Record<string, unknown>,
): WireStopOutputAction => {
  if (payload.scope !== "SPEAK") {
    fail("UNKNOWN_ACTION", "payload.scope must be SPEAK");
  }
  const reason = payload.reason;
  if (reason !== undefined && typeof reason !== "string") {
    fail("UNKNOWN_ACTION", "payload.reason must be a string");
  }
  return {
    type: "STOP_OUTPUT",
    payload: {
      scope: "SPEAK",
      ...(reason === undefined ? {} : { reason: reason as string }),
    },
  };
};

export const normalizeWireAction = (value: unknown): WireAction => {
  if (!isRecord(value)) fail("UNKNOWN_ACTION", "action must be an object");
  const action = value as Record<string, unknown>;
  if (!isRecord(action.payload)) {
    fail("UNKNOWN_ACTION", "action payload must be an object");
  }
  const payload = action.payload as Record<string, unknown>;
  if (action.type === "SPEAK") {
    return normalizeSpeak(payload);
  }
  if (action.type === "STOP_OUTPUT") {
    return normalizeStop(payload);
  }
  return fail("UNKNOWN_ACTION", "action type is not supported");
};

export const encodeOutputFrame = (frame: OutputFrame): string => {
  const actions = frame.actions.map((action) => normalizeWireAction(action));
  return (
    "event: output\ndata: " +
    JSON.stringify({
      specVersion: RTC_SPEC_VERSION,
      sessionId: frame.sessionId,
      actions,
      final: frame.final,
    }) +
    "\n\n"
  );
};

export const parseOutputFrame = (text: string): OutputFrame => {
  const match = /^event: output\ndata: (.+)\n\n$/u.exec(text);
  if (match === null) {
    return fail(
      "UNKNOWN_FRAME",
      "SSE frame must be one output event ending with a blank line",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(match[1] as string);
  } catch {
    fail("UNKNOWN_FRAME", "SSE data must be valid JSON");
  }
  if (!isRecord(value)) fail("UNKNOWN_FRAME", "SSE data must be an object");
  const frame = value as Record<string, unknown>;
  if (frame.specVersion !== RTC_SPEC_VERSION) {
    fail("UNKNOWN_FRAME", "specVersion must be 1.0");
  }
  const sessionId = requireString(frame.sessionId, "sessionId");
  if (!Array.isArray(frame.actions)) {
    fail("UNKNOWN_FRAME", "actions must be an array");
  }
  if (typeof frame.final !== "boolean") {
    fail("UNKNOWN_FRAME", "final must be a boolean");
  }
  return {
    sessionId,
    actions: (frame.actions as unknown[]).map((action) =>
      normalizeWireAction(action),
    ),
    final: frame.final as boolean,
  };
};

export const toWireActions = (
  commands: readonly RtcOutputCommand[],
  options: WireActionOptions,
): readonly WireAction[] =>
  commands.map((command) => {
    if (command.type === "SPEAK") {
      return {
        type: "SPEAK",
        payload: {
          speechId: options.speechId,
          index: options.startIndex,
          hasNext: options.hasNext,
          text: command.text,
          ...(command.appendHighlight === undefined
            ? {}
            : { textDisplayMode: "APPEND_HIGHLIGHT" as const }),
        },
      };
    }
    if (command.type === "APPEND_HIGHLIGHT") {
      return {
        type: "SPEAK",
        payload: {
          speechId: options.speechId,
          index: options.startIndex,
          hasNext: options.hasNext,
          text: command.text,
          textDisplayMode: "APPEND_HIGHLIGHT" as const,
        },
      };
    }
    if (command.type === "STOP_OUTPUT") {
      return {
        type: "STOP_OUTPUT",
        payload: {
          scope: "SPEAK",
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        },
      };
    }
    return fail("UNKNOWN_COMMAND", "output command type is not supported");
  });

export type { RtcMedia };
