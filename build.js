import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.js"],
  bundle: true,
  sourcemap: true,
  minify: true,
  target: ["es2022"],
  platform: "node",
  format: "esm",
  external: ["ws", "rxjs"],
  outfile: "dist/node-game-session.js",
  logLevel: "info",
});
