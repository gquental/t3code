import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { pairConnection, withClient } from "./client.ts";
import { listConnections, readConnection, saveConnection } from "./storage.ts";

const installFetch = Effect.fnUntraced(function* (fetchFn: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", fetchFn);
  yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
});

function fakeRemote(
  options: {
    readonly environmentId?: string;
    readonly protocolVersion?: number;
    readonly invalidTicket?: boolean;
  } = {},
) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/.well-known/t3/environment")) {
      return Promise.resolve(
        Response.json({
          environmentId: options.environmentId ?? "environment-work",
          label: "Work environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: options.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        }),
      );
    }
    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(
        Response.json({
          access_token: "saved-private-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: AuthStandardClientScopes.join(" "),
        }),
      );
    }
    if (url.endsWith("/api/auth/websocket-ticket") && options.invalidTicket) {
      return Promise.resolve(
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "test-trace",
          },
          { status: 401 },
        ),
      );
    }
    return Promise.reject(new Error(`Unexpected test request: ${url}`));
  }) satisfies typeof globalThis.fetch;
  return { calls, fetchFn };
}

function registration() {
  const environmentId = EnvironmentId.make("environment-work");
  const connectionId = `bearer:${environmentId}`;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, connectionId, label: "Work" }),
    profile: new BearerConnectionProfile({
      environmentId,
      connectionId,
      label: "Work",
      httpBaseUrl: "https://remote.example.test/",
      wsBaseUrl: "wss://remote.example.test/",
    }),
    credential: new BearerConnectionCredential({ token: "saved-private-token" }),
  });
}

describe("CLI pairing and connection", () => {
  it.effect(
    "pairs an existing tunnel URL through shared auth and saves a reusable credential",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped();
        const remote = fakeRemote();
        yield* installFetch(remote.fetchFn);
        const connection = yield* pairConnection({
          configDir,
          name: "work",
          pairingUrl: "https://managed-tunnel.example.test/pair?token=pairing-secret",
        });
        expect(connection).toMatchObject({
          name: "work",
          active: true,
          environmentId: "environment-work",
          httpBaseUrl: "https://managed-tunnel.example.test/",
          wsBaseUrl: "wss://managed-tunnel.example.test/",
        });
        expect(connection).not.toHaveProperty("bearerToken");
        expect((yield* readConnection(configDir)).bearerToken).toBe("saved-private-token");
        expect(remote.calls.map((call) => call.url)).toEqual([
          "https://managed-tunnel.example.test/.well-known/t3/environment",
          "https://managed-tunnel.example.test/oauth/token",
        ]);
        const body = remote.calls[1]?.init.body;
        const params = new URLSearchParams(
          body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body),
        );
        expect(params.get("subject_token")).toBe("pairing-secret");
        expect(params.get("client_label")).toBe("T3 Control CLI");
        expect(params.get("scope")).toBe(AuthStandardClientScopes.join(" "));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects incompatible pairing before consuming its token", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped();
      const remote = fakeRemote({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 });
      yield* installFetch(remote.fetchFn);
      const error = yield* pairConnection({
        configDir,
        name: "work",
        pairingUrl: "https://remote.example.test/?token=pairing-secret",
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "unsupported" });
      expect(remote.calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
      expect(yield* listConnections(configDir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("validates local settings and pairing URLs before requesting a credential", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped();
      const remote = fakeRemote();
      yield* installFetch(remote.fetchFn);
      const options = {
        configDir,
        name: "work",
        pairingUrl: "https://remote.example.test/?token=pairing-secret",
      };
      expect(
        (yield* pairConnection({ ...options, name: "../invalid" }).pipe(Effect.flip))._tag,
      ).toBe("ConnectionStorageError");
      expect(
        (yield* pairConnection({ ...options, pairingUrl: "https://remote.example.test/" }).pipe(
          Effect.flip,
        ))._tag,
      ).toBe("ConnectionBlockedError");
      yield* fs.writeFileString(path.join(configDir, "connections.json"), "{invalid");
      expect((yield* pairConnection(options).pipe(Effect.flip))._tag).toBe(
        "ConnectionStorageError",
      );
      expect(remote.calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects a changed environment identity before running the command or minting a socket ticket",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped();
        yield* saveConnection(configDir, "work", registration());
        const remote = fakeRemote({ environmentId: "different-environment" });
        yield* installFetch(remote.fetchFn);
        let ranCommand = false;
        const error = yield* withClient(
          { configDir, timeoutSeconds: 5 },
          Effect.sync(() => {
            ranCommand = true;
          }),
        ).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
        expect(ranCommand).toBe(false);
        expect(remote.calls.map((call) => call.url)).toEqual([
          "https://remote.example.test/.well-known/t3/environment",
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns an invalid credential failure before running a command", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped();
      yield* saveConnection(configDir, "work", registration());
      const remote = fakeRemote({ invalidTicket: true });
      yield* installFetch(remote.fetchFn);
      let ranCommand = false;
      const error = yield* withClient(
        { configDir, timeoutSeconds: 5 },
        Effect.sync(() => {
          ranCommand = true;
        }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        detail: "The environment credential is invalid.",
      });
      expect(ranCommand).toBe(false);
      expect(remote.calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/api/auth/websocket-ticket",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const operation of ["pair", "connect"] as const) {
    it.effect(`aborts an unfinished ${operation} request at the configured timeout`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped();
        yield* saveConnection(configDir, "work", registration());
        const requested = Promise.withResolvers<void>();
        const aborted = Promise.withResolvers<void>();
        const fetchFn = ((_input, init) => {
          requested.resolve();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                reject(new Error("Test request aborted"));
              },
              { once: true },
            );
          });
        }) satisfies typeof globalThis.fetch;
        yield* installFetch(fetchFn);
        const effect =
          operation === "pair"
            ? pairConnection({
                configDir,
                name: "new",
                pairingUrl: "https://remote.example.test/?token=pairing-secret",
                timeoutSeconds: 2,
              })
            : withClient(
                { configDir, timeoutSeconds: 2 },
                Effect.die("Command ran before initialization."),
              );
        const fiber = yield* effect.pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.promise(() => requested.promise);
        yield* TestClock.adjust("2 seconds");
        const error = yield* Fiber.join(fiber);
        expect(error).toMatchObject({ _tag: "ConnectionTransientError", reason: "timeout" });
        yield* Effect.promise(() => aborted.promise);
        expect((yield* listConnections(configDir)).map((connection) => connection.name)).toEqual([
          "work",
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
