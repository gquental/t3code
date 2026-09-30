import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import packageJson from "../package.json" with { type: "json" };
import { cli } from "./cli.ts";
import { errorOutput } from "./errors.ts";

Command.run(cli, { version: packageJson.version, renderErrors: false }).pipe(
  Effect.scoped,
  Effect.tapError((error) => Console.error(JSON.stringify(errorOutput(error)))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
