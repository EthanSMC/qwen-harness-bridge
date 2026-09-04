import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type {
  HarnessContext,
  HarnessSessionEventHandler,
  OwnedSession,
} from "./types.js";

export const registerSessionListener = (
  ctx: HarnessContext,
  ownedSessions: ReadonlyMap<string, OwnedSession>,
  handler: HarnessSessionEventHandler,
): (() => void) => {
  const unregister = ctx.on(
    "session/event",
    (session: Session, event: SessionEvent) => {
      const owner = ownedSessions.get(String(session.id));
      if (owner === undefined) return;
      handler(owner, session, event);
    },
  );

  return () => {
    unregister();
  };
};
