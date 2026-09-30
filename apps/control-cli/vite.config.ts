import { defineConfig, mergeConfig } from "vite-plus";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import packageJson from "./package.json" with { type: "json" };
import baseConfig from "../../vite.config.ts";

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      format: "esm",
      sourcemap: true,
      clean: true,
      deps: { alwaysBundle: () => true, onlyBundle: false },
      banner: { js: "#!/usr/bin/env node\n" },
      onSuccess: (config) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const readme = yield* path.fromFileUrl(new URL("./README.md", import.meta.url));
          const license = yield* path.fromFileUrl(new URL("../../LICENSE", import.meta.url));
          const skills = yield* path.fromFileUrl(new URL("./skills", import.meta.url));
          yield* Effect.all(
            [
              fs.writeFileString(
                path.join(config.outDir, "package.json"),
                encodeManifest({
                  name: packageJson.name,
                  version: packageJson.version,
                  license: packageJson.license,
                  repository: packageJson.repository,
                  type: packageJson.type,
                  bin: { t3ctl: "./bin.mjs" },
                  engines: packageJson.engines,
                  files: ["bin.mjs", "bin.mjs.map", "README.md", "LICENSE", "skills"],
                }) + "\n",
              ),
              fs.copyFile(readme, path.join(config.outDir, "README.md")),
              fs.copyFile(license, path.join(config.outDir, "LICENSE")),
              fs.copy(skills, path.join(config.outDir, "skills")),
            ],
            { concurrency: 3 },
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise),
    },
  }),
);
