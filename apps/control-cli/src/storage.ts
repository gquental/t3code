import * as NodeOS from "node:os";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { BearerConnectionRegistration } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class ConnectionStorageError extends Schema.TaggedError<ConnectionStorageError>()(
  "ConnectionStorageError",
  { message: Schema.String },
) {}

const ConnectionName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/));

const endpointUrl = (protocols: ReadonlyArray<string>) =>
  Schema.String.check(
    Schema.makeFilter((value) => {
      if (!URL.canParse(value)) return "Invalid connection URL.";
      const url = new URL(value);
      return (
        (protocols.includes(url.protocol) &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "") ||
        "Connection URL must use the expected protocol without credentials, query, or fragment."
      );
    }),
  );

export const SavedConnection = Schema.Struct({
  name: ConnectionName,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  httpBaseUrl: endpointUrl(["http:", "https:"]),
  wsBaseUrl: endpointUrl(["ws:", "wss:"]),
  bearerToken: TrimmedNonEmptyString,
});
export type SavedConnection = typeof SavedConnection.Type;
export type ConnectionSummary = Omit<SavedConnection, "bearerToken"> & { readonly active: boolean };

const ConnectionDocument = Schema.Struct({
  version: Schema.Literal(1),
  activeConnection: Schema.NullOr(ConnectionName),
  connections: Schema.Array(SavedConnection),
}).check(
  Schema.makeFilter((document) => {
    const names = new Set(document.connections.map((connection) => connection.name));
    return (
      (names.size === document.connections.length &&
        (document.activeConnection === null || names.has(document.activeConnection))) ||
      "Connection names must be unique and the active connection must exist."
    );
  }),
);
type ConnectionDocument = typeof ConnectionDocument.Type;
const ConnectionDocumentJson = Schema.fromJsonString(ConnectionDocument);
const decodeDocument = Schema.decodeUnknownEffect(ConnectionDocumentJson);
const encodeDocument = Schema.encodeEffect(ConnectionDocumentJson);
const decodeSavedConnection = Schema.decodeUnknownEffect(SavedConnection);
const decodeConnectionName = Schema.decodeUnknownEffect(ConnectionName);

export const defaultConfigDir = () => `${NodeOS.homedir()}/.config/t3ctl`;

export const validateConnectionName = (name: string) =>
  decodeConnectionName(name).pipe(
    Effect.mapError(
      () =>
        new ConnectionStorageError({
          message:
            "Connection name must be 1-64 letters, numbers, dots, underscores, or hyphens and start with a letter or number.",
        }),
    ),
  );

const readDocument = Effect.fn("t3ctl.storage.readDocument")(function* (configDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(configDir, "connections.json");
  const contents = yield* fs.readFileString(filePath).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    Effect.mapError(
      () => new ConnectionStorageError({ message: "Could not read connections.json." }),
    ),
  );
  if (contents === null) {
    return { version: 1, activeConnection: null, connections: [] } satisfies ConnectionDocument;
  }
  return yield* decodeDocument(contents).pipe(
    Effect.mapError(
      () =>
        new ConnectionStorageError({
          message: "connections.json is invalid or uses an unsupported version.",
        }),
    ),
  );
});

const writeDocument = Effect.fn("t3ctl.storage.writeDocument")(function* (
  configDir: string,
  document: ConnectionDocument,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* encodeDocument(document).pipe(
    Effect.mapError(
      () => new ConnectionStorageError({ message: "Connection settings are invalid." }),
    ),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* fs.makeDirectory(configDir, { recursive: true, mode: 0o700 });
      yield* fs.chmod(configDir, 0o700);
      const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
        directory: configDir,
        prefix: ".connections-",
      });
      yield* fs.chmod(temporaryDirectory, 0o700);
      const temporaryPath = path.join(temporaryDirectory, "connections.json");
      yield* fs.writeFileString(temporaryPath, `${contents}\n`, { mode: 0o600, flag: "wx" });
      yield* fs.rename(temporaryPath, path.join(configDir, "connections.json"));
    }),
  ).pipe(
    Effect.mapError(
      () => new ConnectionStorageError({ message: "Could not save connections.json." }),
    ),
  );
});

function summary(connection: SavedConnection, activeConnection: string | null): ConnectionSummary {
  return {
    name: connection.name,
    environmentId: connection.environmentId,
    label: connection.label,
    httpBaseUrl: connection.httpBaseUrl,
    wsBaseUrl: connection.wsBaseUrl,
    active: connection.name === activeConnection,
  };
}

export const listConnections = Effect.fn("t3ctl.storage.listConnections")(function* (
  configDir: string,
) {
  const document = yield* readDocument(configDir);
  return document.connections.map((connection) => summary(connection, document.activeConnection));
});

export const readConnection = Effect.fn("t3ctl.storage.readConnection")(function* (
  configDir: string,
  name?: string,
) {
  if (name !== undefined) yield* validateConnectionName(name);
  const document = yield* readDocument(configDir);
  const selected = name ?? document.activeConnection;
  if (selected === null) {
    return yield* new ConnectionStorageError({
      message: "No active connection. Pair an environment or select a saved connection.",
    });
  }
  const connection = document.connections.find((connection) => connection.name === selected);
  if (connection === undefined) {
    return yield* new ConnectionStorageError({
      message: `Connection '${selected}' does not exist.`,
    });
  }
  return connection;
});

export const saveConnection = Effect.fn("t3ctl.storage.saveConnection")(function* (
  configDir: string,
  name: string,
  registration: BearerConnectionRegistration,
) {
  yield* validateConnectionName(name);
  const document = yield* readDocument(configDir);
  const connection = yield* decodeSavedConnection({
    name,
    environmentId: registration.target.environmentId,
    label: registration.target.label,
    httpBaseUrl: registration.profile.httpBaseUrl,
    wsBaseUrl: registration.profile.wsBaseUrl,
    bearerToken: registration.credential.token,
  }).pipe(
    Effect.mapError(
      () => new ConnectionStorageError({ message: "The paired connection settings are invalid." }),
    ),
  );
  const activeConnection = document.activeConnection ?? name;
  yield* writeDocument(configDir, {
    version: 1,
    activeConnection,
    connections: [
      ...document.connections.filter((connection) => connection.name !== name),
      connection,
    ],
  });
  return summary(connection, activeConnection);
});

export const useConnection = Effect.fn("t3ctl.storage.useConnection")(function* (
  configDir: string,
  name: string,
) {
  yield* validateConnectionName(name);
  const document = yield* readDocument(configDir);
  const connection = document.connections.find((connection) => connection.name === name);
  if (connection === undefined) {
    return yield* new ConnectionStorageError({ message: `Connection '${name}' does not exist.` });
  }
  yield* writeDocument(configDir, { ...document, activeConnection: name });
  return summary(connection, name);
});

export const removeConnection = Effect.fn("t3ctl.storage.removeConnection")(function* (
  configDir: string,
  name: string,
) {
  yield* validateConnectionName(name);
  const document = yield* readDocument(configDir);
  if (!document.connections.some((connection) => connection.name === name)) {
    return yield* new ConnectionStorageError({ message: `Connection '${name}' does not exist.` });
  }
  yield* writeDocument(configDir, {
    version: 1,
    activeConnection: document.activeConnection === name ? null : document.activeConnection,
    connections: document.connections.filter((connection) => connection.name !== name),
  });
});
