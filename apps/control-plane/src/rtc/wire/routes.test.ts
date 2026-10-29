import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RtcClock } from "../session/rtc-session.js";
import { createRtcRouteSet, RTC_CALLBACK_PATH } from "./routes.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "tests",
  "contract",
  "fixtures",
  "qwen-rtc",
);
const startBody = readFileSync(join(fixtures, "start-request.json"), "utf8");

const OWNER = "owner-subject-1";
const SECRET = "rtc-adapter-signing-secret-value-0123456789";
const CALLBACK_URL = "https://control-plane.example.com/rtc/session";
const STARTED_AT = "1970-01-01T00:00:00.000Z";

const createFakeClock = () => {
  let now = 0;
  let sequence = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: RtcClock = {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = sequence;
      sequence += 1;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = target;
  };
  return { clock, advance };
};

const signatureFor = (rawBody: string, nonce: string): string =>
  createHmac("sha256", SECRET)
    .update(
      [
        "POST",
        RTC_CALLBACK_PATH,
        STARTED_AT,
        nonce,
        createHash("sha256").update(rawBody, "utf8").digest("hex"),
      ].join("\n"),
    )
    .digest("hex");

const headersFor = (nonce: string) => ({
  "content-type": "application/json",
  "x-qhb-signature": signatureFor(startBody, nonce),
  "x-qhb-timestamp": STARTED_AT,
  "x-qhb-nonce": nonce,
  "x-qhb-owner-subject": OWNER,
});

const openApps: Awaited<ReturnType<typeof Fastify>>[] = [];
afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
});

const readUntil = async (
  response: Response,
  marker: string,
): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("missing response stream");
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !text.includes(marker)) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("stream chunk timeout")), 500);
      }),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value);
  }
  await reader.cancel();
  return text;
};

describe("rtc callback routes over HTTP", () => {
  it("returns the existing SSE stream for a duplicate identical start", async () => {
    const { clock, advance } = createFakeClock();
    const routes = createRtcRouteSet({
      module: {
        ownerSubject: OWNER,
        signingSecret: SECRET,
        callbackUrl: CALLBACK_URL,
        allowedMedia: ["audio"] as const,
        provider: "ALIYUN_RTC",
      },
      clock,
    });
    expect(routes).not.toBeNull();
    if (routes === null) return;

    const app = Fastify();
    openApps.push(app);
    routes.register(app);
    await app.ready();
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `${base}${RTC_CALLBACK_PATH}`;

    const first = await fetch(url, {
      method: "POST",
      headers: headersFor("nonce-http-1"),
      body: startBody,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");

    const duplicate = await fetch(url, {
      method: "POST",
      headers: headersFor("nonce-http-2"),
      body: startBody,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    expect(routes.registry.size).toBe(1);

    advance(30_000);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await readUntil(first, ": keep-alive")).toContain(": keep-alive");
    expect(await readUntil(duplicate, ": keep-alive")).toContain(
      ": keep-alive",
    );
  });
});
