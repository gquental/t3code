import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Command } from "effect/unstable/cli";
import { cli } from "./cli.ts";

const run = Command.runWith(cli, { version: "test", renderErrors: false });

describe("control CLI arguments", () => {
  it.effect("accepts commands without optional booleans and shared flags after subcommands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped();
      for (const args of [
        ["project", "add", "/server/workspace", "--title", "Fixture"],
        ["thread", "list"],
        ["thread", "get", "thread-fixture"],
        ["models", "--project", "project-fixture"],
      ]) {
        const error = yield* run([...args, "--config-dir", configDir]).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ConnectionStorageError" });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("validates identifiers while parsing", () =>
    Effect.gen(function* () {
      const error = yield* run(["thread", "get", ""]).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ShowHelp" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
