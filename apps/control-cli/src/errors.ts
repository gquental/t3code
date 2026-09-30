import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import {
  EnvironmentAuthorizationError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as CliError from "effect/unstable/cli/CliError";
import { ConnectionStorageError } from "./storage.ts";
import { CliInputError } from "./operations.ts";

const isInputError = Schema.is(CliInputError);
const isStorageError = Schema.is(ConnectionStorageError);
const isBlocked = Schema.is(ConnectionBlockedError);
const isTransient = Schema.is(ConnectionTransientError);
const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);
const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const isSnapshotError = Schema.is(OrchestrationGetSnapshotError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isSettingsError = Schema.is(ServerSettingsError);

export function errorOutput(error: unknown) {
  if (isInputError(error) || isStorageError(error)) {
    return { error: { code: error._tag, message: error.message } };
  }
  if (isDispatchError(error) || isSnapshotError(error)) {
    return { error: { code: error._tag, message: error.message } };
  }
  if (isAuthorizationError(error)) {
    return {
      error: {
        code: error._tag,
        message: `This operation requires the '${error.requiredScope}' scope. Pair with a credential that grants it.`,
      },
    };
  }
  if (isSettingsError(error)) {
    return {
      error: {
        code: error._tag,
        message: `Server settings ${error.operation} failed. Check the server logs.`,
      },
    };
  }
  if (isBlocked(error)) {
    return {
      error: {
        code: error._tag,
        message: `Connection blocked (${error.reason}). Pair again or check the environment.`,
      },
    };
  }
  if (isTransient(error) || isUnavailable(error)) {
    return {
      error: {
        code: error._tag,
        message:
          "The environment is unavailable or the command timed out. A submitted command may still be running; inspect the thread before retrying.",
      },
    };
  }
  if (CliError.isCliError(error)) {
    return {
      error: {
        code: "InvalidArguments",
        message: "Invalid command arguments. Run 't3ctl --help' or '<command> --help'.",
      },
    };
  }
  return {
    error: {
      code: "CommandFailed",
      message:
        "The environment rejected the request or pairing failed. Check the connection, scopes, and server logs.",
    },
  };
}
