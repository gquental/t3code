import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { selectModel } from "./operations.ts";

const instanceId = ProviderInstanceId.make("codex-office");
const projectId = ProjectId.make("project-fixture");
const selection = { instanceId, model: "fixture-model" };
const encodeSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.0.0-test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-30T00:00:00.000Z",
  models: [
    {
      slug: "fixture-model",
      name: "Fixture Model",
      aliases: ["fixture"],
      isCustom: false,
      capabilities: null,
    },
    { slug: "alternate-model", name: "Alternate", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
const config: ServerConfig = {
  environment: {
    environmentId: EnvironmentId.make("environment-fixture"),
    label: "Fixture",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "fixture_session",
  },
  cwd: "/server/workspace",
  keybindingsConfigPath: "/server/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [provider],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/server/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: { [instanceId]: { driver: provider.driver, enabled: true } },
    projectSettingsFolded: true,
    defaultModelSelection: selection,
  },
};
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Fixture",
  workspaceRoot: "/server/workspace",
  defaultModelSelection: { instanceId, model: "obsolete-model" },
  scripts: [],
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
};

describe("model selection for new CLI threads", () => {
  it.effect("uses the environment default after legacy project settings have been folded", () =>
    Effect.gen(function* () {
      expect(yield* selectModel(config, project, {})).toEqual(selection);
    }),
  );

  it.effect("uses project overrides and preserves provider options", () =>
    Effect.gen(function* () {
      const override = {
        ...selection,
        model: "alternate-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      expect(
        yield* selectModel(
          {
            ...config,
            settings: {
              ...config.settings,
              projectSettingsOverrides: { [projectId]: { defaultModelSelection: override } },
            },
          },
          project,
          {},
        ),
      ).toEqual(override);
    }),
  );

  it.effect("honors legacy project defaults before the server migration", () =>
    Effect.gen(function* () {
      expect(
        yield* selectModel(
          { ...config, settings: { ...config.settings, projectSettingsFolded: false } },
          {
            ...project,
            defaultModelSelection: { ...selection, model: "alternate-model" },
          },
          {},
        ),
      ).toEqual({ ...selection, model: "alternate-model" });
    }),
  );

  it.effect("resolves an explicit model alias against the instance's live catalogue", () =>
    Effect.gen(function* () {
      expect(
        yield* selectModel(config, project, { instance: instanceId, model: "fixture" }),
      ).toEqual(selection);
    }),
  );

  it.effect("accepts full model selections without losing boolean or string options", () =>
    Effect.gen(function* () {
      const full = {
        ...selection,
        options: [
          { id: "fast", value: true },
          { id: "effort", value: "low" },
        ],
      };
      expect(yield* selectModel(config, project, { selection: encodeSelection(full) })).toEqual(
        full,
      );
    }),
  );

  it.effect("requires an explicit selection when the environment has no default", () =>
    Effect.gen(function* () {
      const error = yield* selectModel(
        { ...config, settings: { ...config.settings, defaultModelSelection: null } },
        project,
        {},
      ).pipe(Effect.flip);
      expect(error.message).toContain("No model default");
    }),
  );

  it.effect("rejects conflicting, incomplete, malformed, or unavailable model selections", () =>
    Effect.gen(function* () {
      for (const input of [
        { instance: instanceId },
        { instance: instanceId, model: "fixture-model", selection: "{}" },
        { selection: "{malformed" },
        { instance: instanceId, model: "not-in-the-catalogue" },
        { instance: "codex", model: "fixture-model" },
      ]) {
        expect((yield* selectModel(config, project, input).pipe(Effect.flip))._tag).toBe(
          "CliInputError",
        );
      }
      expect(
        (yield* selectModel(
          { ...config, providers: [{ ...provider, enabled: false }] },
          project,
          {},
        ).pipe(Effect.flip)).message,
      ).toContain("unavailable");
    }),
  );
});
