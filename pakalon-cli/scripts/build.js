const fs = require("fs");
const path = require("path");

const mode = process.argv[2] || "all";
const rootDir = path.resolve(__dirname, "..");
const external = ["react-devtools-core", "playwright"];

function ensureShebang(filePath, runtime, optional = false) {
  const resolvedPath = path.resolve(rootDir, filePath);
  if (!fs.existsSync(resolvedPath)) {
    if (optional) {
      console.log(`[WARN] Shebang skipped (file not found): ${resolvedPath}`);
      return;
    }
    console.error(`Cannot add shebang; file does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  const shebang = `#!/usr/bin/env ${runtime}`;
  const current = fs.readFileSync(resolvedPath, "utf8");
  if (current.startsWith(shebang)) return;

  fs.writeFileSync(resolvedPath, `${shebang}\n${current.replace(/^#!.*\r?\n/, "")}`);
}

async function runBuild(entrypoints, outdir, target = "bun") {
  if (typeof Bun === "undefined") {
    console.error("This build script must be run with Bun.");
    process.exit(1);
  }

  // Ensure output directory exists
  const outDirPath = path.resolve(rootDir, outdir);
  if (!fs.existsSync(outDirPath)) {
    fs.mkdirSync(outDirPath, { recursive: true });
    console.log(`[BUILD] Created output directory: ${outdir}`);
  }

  console.log(`[BUILD] Starting build...`);
  console.log(`[BUILD] Entrypoints: ${entrypoints.join(", ")}`);
  console.log(`[BUILD] Output dir: ${outdir}`);
  console.log(`[BUILD] Target: ${target}`);

  const result = await Bun.build({
    entrypoints,
    outdir,
    target,
    external,
    minify: true,
    splitting: false,
  });

  console.log(`[BUILD] Result.success = ${result.success}`);
  console.log(`[BUILD] Result.outputs = ${result.outputs?.length ?? 0}`);
  console.log(`[BUILD] Result.logs = ${result.logs?.length ?? 0}`);

  if (result.logs && result.logs.length > 0) {
    for (const log of result.logs) {
      console.log(`[BUILD]   ${log.level}: ${log.message || String(log)}`);
    }
  }

  if (result.outputs && result.outputs.length > 0) {
    for (const output of result.outputs) {
      console.log(`[BUILD]   Output: ${output.path} (${output.size} bytes)`);
    }
  }

  if (!result.success) {
    console.error(`[BUILD] Build FAILED`);
    process.exit(1);
  }

  // List what's in the output directory
  if (fs.existsSync(outDirPath)) {
    const files = fs.readdirSync(outDirPath);
    console.log(`[BUILD] ${outdir}/ contents: [${files.join(", ")}]`);
    if (files.length === 0) {
      console.error(`[BUILD] ERROR: Output directory is empty after successful build!`);
      console.error(`[BUILD] This might be a Bun version issue. Check Bun version:`);
      process.exit(1);
    }
  }
}

(async () => {
  // Ensure dist directory exists
  const distDir = path.resolve(rootDir, "dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    console.log(`[BUILD] Created dist/ directory`);
  }

  switch (mode) {
    case "all":
      await runBuild(["src/index.tsx"], "dist", "bun");
      ensureShebang("dist/index.js", "bun", true);
      break;
    case "cli":
      await runBuild(["src/index.tsx"], "dist", "bun");
      ensureShebang("dist/index.js", "bun", true);
      break;
    case "legacy-cli":
      await runBuild(["src/cli.ts"], "dist", "node");
      ensureShebang("dist/legacy-cli.js", "node", true);
      break;
    case "app":
      await runBuild(["src/index.tsx"], "dist", "bun");
      ensureShebang("dist/index.js", "bun", true);
      break;
    default:
      console.error(`Unknown build target: ${mode}`);
      process.exit(2);
  }

  console.log(`[BUILD] Done!`);
})().catch((error) => {
  console.error(`[BUILD] Fatal error:`, error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(`[BUILD] Stack:`, error.stack);
  }
  process.exit(1);
});
