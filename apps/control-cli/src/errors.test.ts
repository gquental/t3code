import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";
import { errorOutput } from "./errors.ts";
import { CliInputError } from "./operations.ts";

describe("CLI error output", () => {
  it("keeps remote credentials and transport details out of errors", () => {
    for (const error of [
      new ConnectionBlockedError({ reason: "authentication", detail: "Bearer private-token" }),
      new ConnectionTransientError({
        reason: "transport",
        detail: "wss://host/ws?wsTicket=private-token",
      }),
      new Error("pair?token=private-token"),
    ]) {
      expect(JSON.stringify(errorOutput(error))).not.toContain("private-token");
    }
  });

  it("returns actionable input errors with a stable code", () => {
    expect(
      errorOutput(new CliInputError({ message: "Supply --instance and --model together." })),
    ).toEqual({
      error: { code: "CliInputError", message: "Supply --instance and --model together." },
    });
  });
});
