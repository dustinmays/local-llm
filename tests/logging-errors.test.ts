import { describe, expect, it } from "vitest";
import { Logger } from "../src/logging.js";
import { asInternalError, stableError } from "../src/errors.js";

describe("safe logging and errors", () => {
  it("writes one allowlisted JSON record without arbitrary secrets or paths", () => {
    const lines: string[] = [];
    const logger = new Logger("debug", (line) => lines.push(line));
    logger.log({
      level: "info",
      event: "request complete with spaces",
      requestId: "00000000-0000-4000-8000-000000000000",
      command: "status",
      backend: "controller",
      model: "model/name",
      durationMs: 1.6,
      outcome: "ready",
      errorCode: null,
      secret: "password",
      path: "/Users/private/workspace",
      body: "raw upstream body",
    } as Parameters<Logger["log"]>[0]);
    expect(lines).toHaveLength(1);
    const text = lines.at(0);
    if (text === undefined) throw new Error("Expected one log line");
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(text) as unknown;
    }).not.toThrow();
    expect(text).not.toContain("password");
    expect(text).not.toContain("/Users/private");
    expect(text).not.toContain("raw upstream body");
    expect(parsed).toMatchObject({
      event: "request_complete_with_spaces",
      duration_ms: 2,
      backend: "controller",
    });
  });

  it("respects log levels and creates safe default errors", () => {
    const lines: string[] = [];
    const logger = new Logger("warn", (line) => lines.push(line));
    logger.log({ level: "info", event: "ignored" });
    logger.log({ level: "error", event: "kept", errorCode: "INTERNAL_ERROR" });
    expect(lines).toHaveLength(1);
    expect(stableError("UPSTREAM_TIMEOUT").retryable).toBe(true);
    expect(asInternalError()).toEqual(
      expect.objectContaining({ code: "INTERNAL_ERROR", retryable: false, backend: null }),
    );
  });
});
