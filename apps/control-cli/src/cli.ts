import * as Commands from "@t3tools/client-runtime/operations";
import { request } from "@t3tools/client-runtime/rpc";
import {
  ApprovalRequestId,
  ProjectId,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { clearProjectSettingsOverrides } from "@t3tools/shared/projectSettings";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { CliClient, pairConnection, withClient } from "./client.ts";
import * as Operations from "./operations.ts";
import * as Storage from "./storage.ts";

const json = (value: unknown) => Console.log(JSON.stringify(value));
const decodeAnswers = Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderUserInputAnswers));
const optionalString = (name: string) => Flag.String(name).pipe(Flag.optional);
const projectId = Argument.String("project-id").pipe(Argument.withSchema(ProjectId));
const threadId = Argument.String("thread-id").pipe(Argument.withSchema(ThreadId));
const requestId = Argument.String("request-id").pipe(Argument.withSchema(ApprovalRequestId));
const projectFlag = Flag.String("project").pipe(Flag.withSchema(ProjectId), Flag.optional);

const modelFlags = {
  instance: optionalString("instance").pipe(
    Flag.withDescription("Provider instance ID from 'models'."),
  ),
  model: optionalString("model"),
  selection: optionalString("selection").pipe(
    Flag.withDescription("ModelSelection JSON, including provider options."),
  ),
};
const modelInput = (flags: {
  readonly instance: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly selection: Option.Option<string>;
}) => ({
  instance: Option.getOrUndefined(flags.instance),
  model: Option.getOrUndefined(flags.model),
  selection: Option.getOrUndefined(flags.selection),
});

const root = Command.make("t3ctl").pipe(
  Command.withDescription("Control a paired T3 Code environment. Successful commands print JSON."),
  Command.withSharedFlags({
    configDir: Flag.String("config-dir").pipe(
      Flag.withDefault(Storage.defaultConfigDir()),
      Flag.withDescription("Independent CLI connection storage directory."),
    ),
    connection: optionalString("connection").pipe(
      Flag.withDescription("Saved connection name; defaults to the active connection."),
    ),
    timeoutSeconds: Flag.Int("timeout").pipe(
      Flag.withDefault(30),
      Flag.withDescription(
        "Command deadline in seconds, including connection setup. Increase for watch.",
      ),
    ),
  }),
);

const remote = <A, E, R>(action: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const flags = yield* root;
    return yield* withClient(
      {
        configDir: flags.configDir,
        timeoutSeconds: flags.timeoutSeconds,
        ...(Option.isSome(flags.connection) ? { connection: flags.connection.value } : {}),
      },
      action,
    );
  });

const pair = Command.make(
  "pair",
  {
    url: Argument.String("pairing-url"),
    name: Flag.String("name").pipe(Flag.withDefault("default")),
  },
  (input) =>
    Effect.gen(function* () {
      const flags = yield* root;
      yield* pairConnection({
        ...input,
        pairingUrl: input.url,
        configDir: flags.configDir,
        timeoutSeconds: flags.timeoutSeconds,
      }).pipe(Effect.flatMap(json));
    }),
).pipe(
  Command.withDescription("Save a connection using a fresh pairing URL from the host's 't3 pair'."),
);

const connections = Command.make("connections").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      Effect.gen(function* () {
        const { configDir } = yield* root;
        yield* Storage.listConnections(configDir).pipe(Effect.flatMap(json));
      }),
    ),
    Command.make("use", { name: Argument.String("name") }, ({ name }) =>
      Effect.gen(function* () {
        const { configDir } = yield* root;
        yield* Storage.useConnection(configDir, name).pipe(Effect.flatMap(json));
      }),
    ),
    Command.make("remove", { name: Argument.String("name") }, ({ name }) =>
      Effect.gen(function* () {
        const { configDir } = yield* root;
        yield* Storage.removeConnection(configDir, name);
        yield* json({ removed: name });
      }),
    ),
    Command.make("status", {}, () =>
      remote(
        Effect.gen(function* () {
          const { config, connection } = yield* CliClient;
          yield* json({
            connection: connection.name,
            environment: config.environment,
            connected: true,
          });
        }),
      ),
    ),
  ]),
);

const projects = Command.make("project").pipe(
  Command.withSubcommands([
    Command.make("list", {}, () =>
      remote(Operations.shellSnapshot.pipe(Effect.flatMap((snapshot) => json(snapshot.projects)))),
    ),
    Command.make(
      "add",
      {
        path: Argument.String("server-path").pipe(
          Argument.withDescription("Workspace directory on the server machine."),
        ),
        title: Flag.String("title"),
        mkdir: Flag.Boolean("mkdir").pipe(Flag.withDefault(false)),
      },
      (input) => remote(Operations.addProject(input).pipe(Effect.flatMap(json))),
    ),
    Command.make("rename", { projectId, title: Argument.String("title") }, (input) =>
      remote(
        Effect.gen(function* () {
          const title = yield* Operations.nonEmpty(input.title, "Project title");
          yield* Commands.updateProject({ projectId: input.projectId, title }).pipe(
            Effect.flatMap(json),
          );
        }),
      ),
    ),
    Command.make("remove", { projectId }, (input) =>
      remote(Commands.deleteProject(input).pipe(Effect.flatMap(json))),
    ).pipe(Command.withDescription("Remove a project record from the environment.")),
    Command.make("set-model", { projectId, ...modelFlags }, (input) =>
      remote(
        Operations.setProjectModel(input.projectId, modelInput(input)).pipe(Effect.flatMap(json)),
      ),
    ),
    Command.make("reset-model", { projectId }, ({ projectId }) =>
      remote(
        Effect.gen(function* () {
          const { config } = yield* CliClient;
          yield* Operations.findProject(projectId);
          yield* request(WS_METHODS.serverUpdateSettings, {
            patch: {
              projectSettingsOverrides: {
                [projectId]: clearProjectSettingsOverrides(config.settings, projectId, [
                  "defaultModelSelection",
                ]),
              },
            },
          });
          yield* json({ projectId, reset: true });
        }),
      ),
    ),
  ]),
);

const threads = Command.make("thread").pipe(
  Command.withSubcommands([
    Command.make(
      "list",
      {
        project: projectFlag,
        all: Flag.Boolean("all").pipe(
          Flag.withDefault(false),
          Flag.withDescription("Include archived threads."),
        ),
      },
      (input) =>
        remote(
          Operations.shellSnapshot.pipe(
            Effect.flatMap((snapshot) =>
              json(
                snapshot.threads.filter(
                  (thread) =>
                    (input.all || thread.archivedAt === null) &&
                    (Option.isNone(input.project) || thread.projectId === input.project.value),
                ),
              ),
            ),
          ),
        ),
    ),
    Command.make(
      "create",
      {
        projectId,
        title: Flag.String("title").pipe(Flag.withDefault("New thread")),
        ...modelFlags,
        runtimeMode: Flag.Literals("runtime-mode", RuntimeMode.literals).pipe(Flag.optional),
        interactionMode: Flag.Literals("interaction-mode", ProviderInteractionMode.literals).pipe(
          Flag.withDefault("default"),
        ),
      },
      (input) =>
        remote(
          Operations.createThread({
            ...input,
            ...modelInput(input),
            runtimeMode: Option.getOrUndefined(input.runtimeMode),
          }).pipe(Effect.flatMap(json)),
        ),
    ),
    Command.make(
      "get",
      {
        threadId,
        all: Flag.Boolean("all").pipe(
          Flag.withDefault(false),
          Flag.withDescription("Load the full thread history instead of the latest 10 turns."),
        ),
      },
      ({ threadId, all }) =>
        remote(Operations.threadSnapshot(threadId, all).pipe(Effect.flatMap(json))),
    ),
    Command.make("watch", { threadId }, ({ threadId }) =>
      remote(Operations.threadEvents(threadId).pipe(Stream.runForEach(json))),
    ).pipe(
      Command.withDescription(
        "Print a snapshot and live events as newline-delimited JSON until interrupted or timed out.",
      ),
    ),
    Command.make(
      "send",
      {
        threadId,
        prompt: Argument.String("prompt").pipe(Argument.optional),
        file: Flag.FileText("file").pipe(
          Flag.optional,
          Flag.withDescription("Read the prompt from a local UTF-8 file."),
        ),
      },
      (input) =>
        remote(
          Effect.gen(function* () {
            if (Option.isSome(input.prompt) === Option.isSome(input.file)) {
              return yield* new Operations.CliInputError({
                message: "Supply exactly one prompt argument or --file.",
              });
            }
            const text = Option.getOrElse(input.prompt, () =>
              Option.getOrElse(input.file, () => ""),
            );
            yield* Operations.sendMessage(input.threadId, text).pipe(Effect.flatMap(json));
          }),
        ),
    ).pipe(
      Command.withDescription(
        "Submit a prompt and return its message ID and accepted command sequence. Use get/watch for results.",
      ),
    ),
    Command.make("rename", { threadId, title: Argument.String("title") }, (input) =>
      remote(
        Effect.gen(function* () {
          const title = yield* Operations.nonEmpty(input.title, "Thread title");
          yield* Commands.updateThreadMetadata({ threadId: input.threadId, title }).pipe(
            Effect.flatMap(json),
          );
        }),
      ),
    ),
    Command.make("interrupt", { threadId }, (input) =>
      remote(Commands.interruptThreadTurn(input).pipe(Effect.flatMap(json))),
    ),
    Command.make("archive", { threadId }, (input) =>
      remote(Commands.archiveThread(input).pipe(Effect.flatMap(json))),
    ),
    Command.make("reopen", { threadId }, (input) =>
      remote(Commands.unarchiveThread(input).pipe(Effect.flatMap(json))),
    ),
    Command.make("delete", { threadId }, (input) =>
      remote(Commands.deleteThread(input).pipe(Effect.flatMap(json))),
    ),
    Command.make("stop-session", { threadId }, (input) =>
      remote(Commands.stopThreadSession(input).pipe(Effect.flatMap(json))),
    ),
    Command.make("requests", { threadId }, ({ threadId }) =>
      remote(Operations.pendingRequests(threadId).pipe(Effect.flatMap(json))),
    ),
    Command.make(
      "approve",
      {
        threadId,
        requestId,
        decision: Argument.Literals("decision", ProviderApprovalDecision.literals),
      },
      (input) => remote(Commands.respondToThreadApproval(input).pipe(Effect.flatMap(json))),
    ),
    Command.make(
      "answer",
      {
        threadId,
        requestId,
        answers: Argument.String("answers-json"),
      },
      (input) =>
        remote(
          Effect.gen(function* () {
            const answers = yield* decodeAnswers(input.answers).pipe(
              Effect.mapError(
                () =>
                  new Operations.CliInputError({
                    message: "Answers must be a JSON object keyed by question ID.",
                  }),
              ),
            );
            yield* Commands.respondToThreadUserInput({ ...input, answers }).pipe(
              Effect.flatMap(json),
            );
          }),
        ),
    ),
    Command.make("dismiss-question", { threadId, requestId }, (input) =>
      remote(Commands.dismissThreadUserInput(input).pipe(Effect.flatMap(json))),
    ),
  ]),
);

export const cli = root.pipe(
  Command.withSubcommands([
    pair,
    connections,
    projects,
    threads,
    Command.make("models", { project: projectFlag }, ({ project }) =>
      remote(Operations.listModels(Option.getOrUndefined(project)).pipe(Effect.flatMap(json))),
    ).pipe(
      Command.withDescription(
        "Discover provider instance IDs, models, options, and effective defaults.",
      ),
    ),
  ]),
);
