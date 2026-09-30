import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  listConnections,
  readConnection,
  removeConnection,
  saveConnection,
  useConnection,
} from "./storage.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function registration(id: string, token = "private-token") {
  const environmentId = EnvironmentId.make(id);
  const connectionId = `bearer:${environmentId}`;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, connectionId, label: id }),
    profile: new BearerConnectionProfile({
      environmentId,
      connectionId,
      label: id,
      httpBaseUrl: "https://remote.example.test/",
      wsBaseUrl: "wss://remote.example.test/",
    }),
    credential: new BearerConnectionCredential({ token }),
  });
}

describe("CLI connection storage", () => {
  it.effect("persists named connections and selects the active alias without exposing tokens", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped();
      expect(yield* listConnections(configDir)).toEqual([]);
      const first = yield* saveConnection(configDir, "work", registration("environment-work"));
      expect(first.active).toBe(true);
      expect(encodeJson(first)).not.toContain("private-token");
      yield* saveConnection(configDir, "home", registration("environment-home", "home-token"));
      expect((yield* readConnection(configDir)).name).toBe("work");
      expect((yield* readConnection(configDir, "home")).bearerToken).toBe("home-token");
      expect(yield* useConnection(configDir, "home")).toMatchObject({ name: "home", active: true });
      expect((yield* readConnection(configDir)).environmentId).toBe("environment-home");
      const listed = yield* listConnections(configDir);
      expect(listed.map(({ name, active }) => ({ name, active }))).toEqual([
        { name: "work", active: false },
        { name: "home", active: true },
      ]);
      expect(encodeJson(listed)).not.toContain("token");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "replaces one alias, preserves other aliases, and clears a removed active selection",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const configDir = yield* fs.makeTempDirectoryScoped();
        yield* saveConnection(configDir, "work", registration("old-environment"));
        yield* saveConnection(configDir, "home", registration("home-environment"));
        yield* saveConnection(configDir, "work", registration("new-environment", "new-token"));
        expect((yield* readConnection(configDir)).environmentId).toBe("new-environment");
        expect((yield* listConnections(configDir)).length).toBe(2);
        yield* removeConnection(configDir, "home");
        expect((yield* readConnection(configDir)).name).toBe("work");
        yield* saveConnection(configDir, "home", registration("home-environment"));
        yield* removeConnection(configDir, "work");
        expect((yield* readConnection(configDir).pipe(Effect.flip)).message).toContain(
          "No active connection",
        );
        expect((yield* readConnection(configDir, "home")).environmentId).toBe("home-environment");
        yield* useConnection(configDir, "home");
        expect((yield* readConnection(configDir)).name).toBe("home");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects corrupt or inconsistent documents without printing their contents or overwriting them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = yield* fs.makeTempDirectoryScoped();
        const filePath = path.join(configDir, "connections.json");
        const validConnection = {
          name: "work",
          environmentId: "environment-work",
          label: "Work",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
          bearerToken: "secret-corrupt-token",
        };
        const invalidDocuments = [
          '{"secret-corrupt-token":',
          encodeJson({ version: 2, activeConnection: null, connections: [] }),
          encodeJson({ version: 1, activeConnection: "missing", connections: [] }),
          encodeJson({
            version: 1,
            activeConnection: "work",
            connections: [validConnection, validConnection],
          }),
          encodeJson({
            version: 1,
            activeConnection: "work",
            connections: [{ ...validConnection, httpBaseUrl: "file:///tmp/token" }],
          }),
          encodeJson({
            version: 1,
            activeConnection: "work",
            connections: [
              {
                ...validConnection,
                wsBaseUrl: "wss://remote.example.test/?token=secret-corrupt-token",
              },
            ],
          }),
        ];
        for (const contents of invalidDocuments) {
          yield* fs.writeFileString(filePath, contents);
          const error = yield* listConnections(configDir).pipe(Effect.flip);
          expect(error._tag).toBe("ConnectionStorageError");
          expect(encodeJson(error)).not.toContain("secret-corrupt-token");
          yield* saveConnection(configDir, "new", registration("environment-new")).pipe(
            Effect.flip,
          );
          expect(yield* fs.readFileString(filePath)).toBe(contents);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects invalid names and missing aliases without changing saved connections", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped();
      yield* saveConnection(configDir, "work", registration("environment-work"));
      for (const name of ["", "../outside", "contains spaces", "-leading", "a".repeat(65)]) {
        expect(
          (yield* saveConnection(configDir, name, registration("invalid")).pipe(Effect.flip))._tag,
        ).toBe("ConnectionStorageError");
      }
      yield* useConnection(configDir, "missing").pipe(Effect.flip);
      yield* removeConnection(configDir, "missing").pipe(Effect.flip);
      expect((yield* readConnection(configDir)).environmentId).toBe("environment-work");
      expect((yield* listConnections(configDir)).map((connection) => connection.name)).toEqual([
        "work",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes owner-only settings atomically and removes temporary files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const configDir = path.join(root, "config");
      yield* saveConnection(configDir, "work", registration("environment-work"));
      yield* useConnection(configDir, "work");
      expect(yield* fs.readDirectory(configDir)).toEqual(["connections.json"]);
      if ((yield* HostProcessPlatform) !== "win32") {
        expect((yield* fs.stat(configDir)).mode & 0o777).toBe(0o700);
        expect((yield* fs.stat(path.join(configDir, "connections.json"))).mode & 0o777).toBe(0o600);
      }
      expect((yield* readConnection(configDir)).bearerToken).toBe("private-token");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
