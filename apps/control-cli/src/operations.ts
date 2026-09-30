import * as Commands from "@t3tools/client-runtime/operations";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { request, subscribe } from "@t3tools/client-runtime/rpc";
import {
  MessageId,
  ModelSelection,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  isProviderAvailable,
  type OrchestrationProjectShell,
  type ServerConfig,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import { createModelSelection, resolveSelectableModel } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CliClient } from "./client.ts";

export class CliInputError extends Schema.TaggedError<CliInputError>()("CliInputError", {
  message: Schema.String,
}) {}

const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const decodeSelectionFields = Schema.decodeEffect(ModelSelection);
const decodeNonEmpty = Schema.decodeUnknownEffect(Schema.Trimmed.check(Schema.isNonEmpty()));

export const nonEmpty = (value: string, label: string) =>
  decodeNonEmpty(value).pipe(
    Effect.mapError(() => new CliInputError({ message: `${label} cannot be empty.` })),
  );

export const shellSnapshot = subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}).pipe(
  Stream.filter((item) => item.kind === "snapshot"),
  Stream.map((item) => item.snapshot),
  Stream.runHead,
  Effect.flatMap((snapshot) =>
    Effect.fromOption(
      snapshot,
      () =>
        new CliInputError({
          message: "The environment closed the shell subscription before sending a snapshot.",
        }),
    ),
  ),
);

export const threadEvents = (threadId: ThreadId, all = false) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { config } = yield* CliClient;
      return subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, {
        threadId,
        ...(config.reasoningMessages ? { reasoningMessages: true } : {}),
        ...(!all && config.threadSnapshotPagination ? { turnLimit: 10 } : {}),
      });
    }),
  );

export const threadSnapshot = (threadId: ThreadId, all = false) =>
  threadEvents(threadId, all).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.map((item) => item.snapshot),
    Stream.runHead,
    Effect.flatMap((snapshot) =>
      Effect.fromOption(
        snapshot,
        () =>
          new CliInputError({
            message: "The environment closed the thread subscription before sending a snapshot.",
          }),
      ),
    ),
  );

export const findProject = Effect.fn("t3ctl.findProject")(function* (id: ProjectId) {
  const snapshot = yield* shellSnapshot;
  const project = snapshot.projects.find((candidate) => candidate.id === id);
  if (project === undefined)
    return yield* new CliInputError({ message: `Project '${id}' does not exist.` });
  return project;
});

export interface ModelInput {
  readonly instance?: string | undefined;
  readonly model?: string | undefined;
  readonly selection?: string | undefined;
}

export const selectModel = Effect.fn("t3ctl.selectModel")(function* (
  config: ServerConfig,
  project: OrchestrationProjectShell,
  input: ModelInput,
) {
  if (
    input.selection !== undefined &&
    (input.instance !== undefined || input.model !== undefined)
  ) {
    return yield* new CliInputError({ message: "Use --selection or --instance/--model." });
  }
  if ((input.instance === undefined) !== (input.model === undefined)) {
    return yield* new CliInputError({
      message: "--instance and --model must be supplied together.",
    });
  }
  const defaults = resolveProjectSettings(config.settings, project.id, project).settings;
  const selection =
    input.selection !== undefined
      ? yield* decodeModelSelection(input.selection).pipe(
          Effect.mapError(
            () =>
              new CliInputError({
                message:
                  "--selection must be a ModelSelection JSON object with instanceId, model, and optional options.",
              }),
          ),
        )
      : input.instance !== undefined && input.model !== undefined
        ? yield* decodeSelectionFields({ instanceId: input.instance, model: input.model }).pipe(
            Effect.mapError(() => new CliInputError({ message: "Invalid instance or model." })),
          )
        : defaults.defaultModelSelection;
  if (selection === null) {
    return yield* new CliInputError({
      message: "No model default is configured. Supply --instance and --model, or --selection.",
    });
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (provider === undefined || !provider.enabled || !isProviderAvailable(provider)) {
    return yield* new CliInputError({
      message: "The selected provider instance is unavailable. Run 't3ctl models'.",
    });
  }
  const model = resolveSelectableModel(provider.driver, selection.model, provider.models);
  if (model === null) {
    return yield* new CliInputError({
      message: "The selected model is absent from the environment's catalogue. Run 't3ctl models'.",
    });
  }
  return createModelSelection(selection.instanceId, model, selection.options);
});

export const listModels = Effect.fn("t3ctl.listModels")(function* (projectId?: ProjectId) {
  const { config } = yield* CliClient;
  const project = projectId === undefined ? null : yield* findProject(projectId);
  const resolved = resolveProjectSettings(config.settings, project?.id ?? null, project);
  return {
    environmentId: config.environment.environmentId,
    defaultModelSelection: resolved.settings.defaultModelSelection,
    defaultSource: resolved.sources.defaultModelSelection,
    providers: config.providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName,
      enabled: provider.enabled,
      installed: provider.installed,
      status: provider.status,
      availability: provider.availability,
      message: provider.message,
      models: provider.models,
    })),
  };
});

export const addProject = Effect.fn("t3ctl.addProject")(function* (input: {
  readonly path: string;
  readonly title: string;
  readonly mkdir: boolean;
}) {
  const workspaceRoot = yield* nonEmpty(input.path, "Server workspace path");
  const title = yield* nonEmpty(input.title, "Project title");
  const crypto = yield* Crypto.Crypto;
  const projectId = ProjectId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const receipt = yield* Commands.createProject({
    projectId,
    title,
    workspaceRoot,
    createWorkspaceRootIfMissing: input.mkdir,
  });
  return { projectId, ...receipt };
});

export const setProjectModel = Effect.fn("t3ctl.setProjectModel")(function* (
  projectId: ProjectId,
  input: ModelInput,
) {
  const { config } = yield* CliClient;
  const project = yield* findProject(projectId);
  const defaultModelSelection = yield* selectModel(config, project, input);
  yield* request(WS_METHODS.serverUpdateSettings, {
    patch: {
      projectSettingsOverrides: {
        [projectId]: {
          ...config.settings.projectSettingsOverrides[projectId],
          defaultModelSelection,
        },
      },
    },
  });
  return { projectId, defaultModelSelection };
});

export const createThread = Effect.fn("t3ctl.createThread")(function* (
  input: ModelInput & {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode: ProviderInteractionMode;
  },
) {
  const { config } = yield* CliClient;
  const project = yield* findProject(input.projectId);
  const modelSelection = yield* selectModel(config, project, input);
  const title = yield* nonEmpty(input.title, "Thread title");
  const settings = resolveProjectSettings(config.settings, project.id, project).settings;
  const crypto = yield* Crypto.Crypto;
  const threadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const receipt = yield* Commands.createThread({
    threadId,
    projectId: input.projectId,
    title,
    modelSelection,
    runtimeMode: input.runtimeMode ?? settings.defaultRuntimeMode,
    interactionMode: input.interactionMode,
    branch: null,
    worktreePath: null,
  });
  return { threadId, modelSelection, ...receipt };
});

export const sendMessage = Effect.fn("t3ctl.sendMessage")(function* (
  threadId: ThreadId,
  text: string,
) {
  yield* nonEmpty(text, "Prompt");
  const { thread } = yield* threadSnapshot(threadId);
  const crypto = yield* Crypto.Crypto;
  const messageId = MessageId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const receipt = yield* Commands.startThreadTurn({
    threadId,
    message: { messageId, role: "user", text, attachments: [] },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
  });
  return { threadId, messageId, ...receipt };
});

export const pendingRequests = Effect.fn("t3ctl.pendingRequests")(function* (threadId: ThreadId) {
  const { thread } = yield* threadSnapshot(threadId);
  return { threadId, ...derivePendingRequests(thread.activities) };
});
