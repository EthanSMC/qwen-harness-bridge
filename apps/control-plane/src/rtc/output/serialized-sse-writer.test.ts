import { describe, expect, it, vi } from "vitest";
import type { RtcSseWriter } from "../session/rtc-session.js";
import {
  createSerializedSseOutput,
  SPEAK_FRAGMENT_MAX_CHARACTERS,
} from "./serialized-sse-writer.js";

type Frame = { raw: string };

const createWriter = (options: { failOnWrite?: number } = {}) => {
  const frames: Frame[] = [];
  let ended = 0;
  let writes = 0;
  const writer: RtcSseWriter = {
    get closed() {
      return ended > 0;
    },
    write(frame: string) {
      writes += 1;
      if (options.failOnWrite !== undefined && writes === options.failOnWrite) {
        throw new Error("socket closed");
      }
      frames.push({ raw: frame });
    },
    end() {
      ended += 1;
    },
  };
  return { writer, frames, ended: () => ended };
};

const parseFrame = (frame: string) => {
  expect(frame.endsWith("\n\n")).toBe(true);
  const [header, ...rest] = frame.slice(0, -2).split("\n");
  expect(header === undefined ? "" : header).toMatch(
    /^(?:event: [a-z_]+|: [a-z-]+)$/u,
  );
  const data = rest.find((line) => line.startsWith("data: "));
  return {
    event:
      header === undefined
        ? ""
        : header.startsWith(":")
          ? "comment"
          : header.replace("event: ", ""),
    data:
      data === undefined
        ? undefined
        : (JSON.parse(data.slice("data: ".length)) as Record<string, unknown>),
  };
};

const allFramesComplete = (frames: readonly Frame[]): void => {
  for (const frame of frames) expect(() => parseFrame(frame.raw)).not.toThrow();
};

describe("serialized sse output", () => {
  it("writes only complete, non-interleaved frames", async () => {
    const { writer, frames } = createWriter();
    const output = createSerializedSseOutput({ writer });

    await Promise.all([
      output.speak("第一句。第二句。"),
      output.speak("第三条"),
      output.keepalive(),
      output.progress({
        jobId: "job-1",
        stage: "editing",
        status: "running",
      }),
      output.approval({
        approvalId: "approval-1",
        jobShortId: "QH-AAA1",
        jobRevision: 2,
        summary: "修改两个文件",
      }),
      output.terminal({
        jobId: "job-1",
        status: "succeeded",
        summary: "测试已通过",
      }),
    ]);

    allFramesComplete(frames);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.raw.trimEnd().length > 0)).toBe(true);
  });

  it("keeps keepalive behind earlier command output", async () => {
    const { writer, frames } = createWriter();
    const output = createSerializedSseOutput({ writer });
    await output.speak("先说话。");
    await output.keepalive();

    expect(frames.length).toBe(2);
    expect(parseFrame(frames[0]?.raw ?? "").event).toBe("speak");
    expect(parseFrame(frames[1]?.raw ?? "").event).toBe("comment");
  });

  it("fragments speech at sentence and grapheme boundaries", async () => {
    const { writer, frames } = createWriter();
    const output = createSerializedSseOutput({ writer });
    const long = `第一句话。${"很长的内容".repeat(40)}！短句 😀`;
    await output.speak(long);

    const texts = frames
      .map((frame) => parseFrame(frame.raw))
      .filter((frame) => frame.event === "speak")
      .map((frame) => String(frame.data?.text ?? ""));
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.join("")).toBe(long);
    for (const text of texts) {
      expect(Array.from(text).length).toBeLessThanOrEqual(
        SPEAK_FRAGMENT_MAX_CHARACTERS,
      );
    }
    expect(frames.some((frame) => frame.raw.includes("😀"))).toBe(true);
  });

  it("never splits a task short id across fragments", async () => {
    const { writer, frames } = createWriter();
    const output = createSerializedSseOutput({ writer });
    const text = `${"内容".repeat(58)}QH-ABC1 已完成。`;
    await output.speak(text);

    const texts = frames
      .map((frame) => parseFrame(frame.raw))
      .filter((frame) => frame.event === "speak")
      .map((frame) => String(frame.data?.text ?? ""));
    expect(texts.join("")).toBe(text);
    for (const piece of texts) {
      const partial = /QH-[A-Z0-9]*$/u.exec(piece)?.[0];
      expect(partial === undefined || /QH-[A-Z0-9]{4,}/u.test(partial)).toBe(
        true,
      );
    }
    expect(texts.join("")).toContain("QH-ABC1");
  });

  it("cancels queued speech on stop_output without closing the session", async () => {
    const { writer, frames, ended } = createWriter();
    const output = createSerializedSseOutput({ writer });
    const first = output.speak("第一句。第二句。第三句。");
    const stopped = output.stopOutput();
    await Promise.all([first, stopped]);

    const events = frames.map((frame) => parseFrame(frame.raw).event);
    expect(events).toContain("stop_output");
    expect(events).not.toContain("speak");
    expect(ended()).toBe(0);
    expect(output.closed).toBe(false);
  });

  it("preempts queued progress with urgent approval and terminal frames", async () => {
    const { writer, frames } = createWriter();
    const output = createSerializedSseOutput({ writer });

    const progress = output.progress({ jobId: "job-1", stage: "editing" });
    const approval = output.approval({
      approvalId: "approval-1",
      jobShortId: "QH-AAA1",
      jobRevision: 2,
      summary: "修改两个文件",
    });
    const terminal = output.terminal({
      jobId: "job-1",
      status: "succeeded",
      summary: "测试已通过",
    });
    await Promise.all([progress, approval, terminal]);

    const events = frames.map((frame) => parseFrame(frame.raw).event);
    expect(events).toContain("progress");
    expect(events.indexOf("approval")).toBeLessThan(events.indexOf("progress"));
    expect(events.indexOf("terminal")).toBeLessThan(events.indexOf("progress"));
  });

  it("drops queued progress when the output cancels stale progress", async () => {
    const { writer, frames } = createWriter();
    const output = createSerializedSseOutput({ writer });
    const progress = output.progress({ jobId: "job-1", stage: "editing" });
    output.cancelPendingProgress();
    await progress;

    const events = frames.map((frame) => parseFrame(frame.raw).event);
    expect(events).not.toContain("progress");
  });

  it("pairs the spoken highlight with the same bounded summary", async () => {
    const { writer, frames } = createWriter();
    const output = createSerializedSseOutput({ writer });
    await output.speak("一句话。", { highlight: "同一摘要" });

    const parsed = frames.map((frame) => parseFrame(frame.raw));
    const speaks = parsed.filter((frame) => frame.event === "speak");
    const highlight = parsed.find(
      (frame) => frame.event === "append_highlight",
    );
    expect(speaks.length).toBeGreaterThan(0);
    expect(speaks.every((frame) => frame.data?.highlight === "同一摘要")).toBe(
      true,
    );
    expect(highlight?.data?.summary).toBe("同一摘要");
    expect(parsed.indexOf(highlight as never)).toBeGreaterThan(
      parsed.lastIndexOf(speaks.at(-1) as never),
    );
  });

  it("bounds appended highlights to the same factual summary limit", async () => {
    const { writer, frames } = createWriter();
    const output = createSerializedSseOutput({ writer });
    await output.appendHighlight("事实摘要".repeat(60));

    const frame = parseFrame(frames[0]?.raw ?? "");
    expect(frame.event).toBe("append_highlight");
    expect(
      Array.from(String(frame.data?.summary ?? "")).length,
    ).toBeLessThanOrEqual(SPEAK_FRAGMENT_MAX_CHARACTERS);
  });

  it("rejects writes after close without throwing", async () => {
    const { writer, frames, ended } = createWriter();
    const output = createSerializedSseOutput({ writer });
    await output.close();

    await expect(output.speak("关闭之后")).resolves.toBeUndefined();
    await expect(output.keepalive()).resolves.toBeUndefined();
    await expect(
      output.progress({ jobId: "job-1", stage: "editing" }),
    ).resolves.toBeUndefined();
    expect(frames).toHaveLength(0);
    expect(output.closed).toBe(true);
    expect(ended()).toBe(1);
  });

  it("closes only the rtc session on a socket error", async () => {
    const { writer, ended } = createWriter({ failOnWrite: 1 });
    const onSocketError = vi.fn();
    const output = createSerializedSseOutput({ writer, onSocketError });

    await expect(output.speak("第一句")).resolves.toBeUndefined();
    await expect(output.keepalive()).resolves.toBeUndefined();
    expect(onSocketError).toHaveBeenCalledTimes(1);
    expect(output.closed).toBe(true);
    await expect(output.close()).resolves.toBeUndefined();
    expect(ended()).toBe(1);
  });

  it("refuses writes after the session signal aborts", async () => {
    const { writer, frames } = createWriter();
    const controller = new AbortController();
    const output = createSerializedSseOutput({
      writer,
      signal: controller.signal,
    });
    controller.abort();
    await expect(output.speak("不该写出来")).resolves.toBeUndefined();
    expect(frames).toHaveLength(0);
  });
});
