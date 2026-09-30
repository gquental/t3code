import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { AuthStandardClientScopes, type ServerConfig } from "@t3tools/contracts";
import {
  appendOrchestrationProtocol,
  BearerConnectionProfile,
  BearerConnectionTarget,
  Connectivity,
  ConnectionBlockedError,
  ConnectionTransientError,
  Driver,
  EnvironmentSupervisor,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  orchestrationProtocolCompatibilityError,
  preparePairingRegistration,
  Supervisor,
  Wakeups,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { ClientPresentation } from "@t3tools/client-runtime/platform";
import { remoteHttpClientLayer, Session } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  listConnections,
  readConnection,
  saveConnection,
  validateConnectionName,
  type SavedConnection,
} from "./storage.ts";

export class CliClient extends Context.Service<
  CliClient,
  { readonly config: ServerConfig; readonly connection: SavedConnection }
>()("@t3tools/control-cli/client/CliClient") {}

const presentation = ClientPresentation.of({
  metadata: { label: "T3 Control CLI", deviceType: "bot", surface: "cli" },
  scopes: AuthStandardClientScopes,
});

const TimeoutSeconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
const decodeTimeoutSeconds = Schema.decodeUnknownEffect(TimeoutSeconds);

export const pairConnection = Effect.fn("t3ctl.client.pairConnection")(function* (options: {
  readonly configDir: string;
  readonly name: string;
  readonly pairingUrl: string;
  readonly timeoutSeconds?: number;
}) {
  const timeoutSeconds = yield* decodeTimeoutSeconds(options.timeoutSeconds ?? 30).pipe(
    Effect.mapError(
      () =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: "Timeout must be a positive number of seconds.",
        }),
    ),
  );
  yield* validateConnectionName(options.name);
  yield* listConnections(options.configDir);
  const registration = yield* preparePairingRegistration({ pairingUrl: options.pairingUrl }).pipe(
    Effect.provideService(ClientPresentation, presentation),
    Effect.provide(remoteHttpClientLayer(globalThis.fetch)),
    Effect.timeoutOrElse({
      duration: timeoutSeconds * 1_000,
      orElse: () =>
        Effect.fail(
          new ConnectionTransientError({
            reason: "timeout",
            detail: `Pairing timed out after ${timeoutSeconds} seconds.`,
          }),
        ),
    }),
  );
  return yield* saveConnection(options.configDir, options.name, registration);
});

export interface ClientOptions {
  readonly configDir: string;
  readonly connection?: string;
  readonly timeoutSeconds: number;
}

export const withClient = <A, E, R>(options: ClientOptions, action: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const timeoutSeconds = yield* decodeTimeoutSeconds(options.timeoutSeconds).pipe(
        Effect.mapError(
          () =>
            new ConnectionBlockedError({
              reason: "configuration",
              detail: "Timeout must be a positive number of seconds.",
            }),
        ),
      );
      return yield* Effect.gen(function* () {
        const connection = yield* readConnection(options.configDir, options.connection);
        const target = new BearerConnectionTarget({
          environmentId: connection.environmentId,
          label: connection.label,
          connectionId: `bearer:${connection.environmentId}`,
        });
        const sessions = yield* Session.make();
        const httpClient = yield* HttpClient.HttpClient;
        const driver = Driver.ConnectionDriver.of({
          connect: Effect.fn("t3ctl.client.connect")(
            function* (_entry, reportProgress) {
              yield* reportProgress({ stage: "preparing" });
              const descriptor = yield* fetchRemoteEnvironmentDescriptor({
                httpBaseUrl: connection.httpBaseUrl,
              }).pipe(Effect.mapError(mapRemoteEnvironmentError));
              if (descriptor.environmentId !== connection.environmentId) {
                return yield* environmentMismatchError({
                  expected: connection.environmentId,
                  actual: descriptor.environmentId,
                });
              }
              const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
              if (compatibilityError !== null) return yield* compatibilityError;
              const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
                httpBaseUrl: connection.httpBaseUrl,
                wsBaseUrl: connection.wsBaseUrl,
                bearerToken: connection.bearerToken,
                clientMetadata: presentation.metadata,
                connectionMethod: "direct",
              }).pipe(Effect.mapError(mapRemoteEnvironmentError));
              const prepared: PreparedConnection = {
                target,
                environmentId: connection.environmentId,
                label: descriptor.label,
                httpBaseUrl: connection.httpBaseUrl,
                socketUrl: appendOrchestrationProtocol(socketUrl),
                httpAuthorization: { _tag: "Bearer", token: connection.bearerToken },
              };
              yield* reportProgress({ stage: "opening", prepared });
              const session = yield* sessions.connect(prepared);
              yield* reportProgress({ stage: "synchronizing", prepared });
              yield* session.ready;
              return { prepared, session };
            },
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
        });
        const supervisor = yield* Supervisor.make(
          {
            target,
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId: target.connectionId,
                environmentId: connection.environmentId,
                label: connection.label,
                httpBaseUrl: connection.httpBaseUrl,
                wsBaseUrl: connection.wsBaseUrl,
              }),
            ),
            enabled: true,
          },
          { initiallyDesired: true },
        ).pipe(
          Effect.provideService(Driver.ConnectionDriver, driver),
          Effect.provide(
            Layer.mergeAll(
              Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.empty }),
              Wakeups.layer({ changes: Stream.empty }),
            ),
          ),
        );
        yield* SubscriptionRef.changes(supervisor.state).pipe(
          Stream.filter((state) => state.phase === "connected" || state.lastFailure !== null),
          Stream.mapEffect((state) =>
            state.lastFailure !== null ? Effect.fail(state.lastFailure) : Effect.void,
          ),
          Stream.runHead,
        );
        const session = yield* SubscriptionRef.get(supervisor.session).pipe(
          Effect.flatMap((session) =>
            Effect.fromOption(
              session,
              () =>
                new ConnectionTransientError({
                  reason: "transport",
                  detail: "The environment disconnected before the command could run.",
                }),
            ),
          ),
        );
        const config = yield* session.initialConfig;
        return yield* Effect.raceFirst(
          action.pipe(
            Effect.provideService(EnvironmentSupervisor, supervisor),
            Effect.provideService(CliClient, { config, connection }),
          ),
          session.closed,
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutSeconds * 1_000,
          orElse: () =>
            Effect.fail(
              new ConnectionTransientError({
                reason: "timeout",
                detail: `The command timed out after ${timeoutSeconds} seconds.`,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          remoteHttpClientLayer(globalThis.fetch),
          NodeSocket.layerWebSocketConstructor,
        ),
      ),
    ),
  );
