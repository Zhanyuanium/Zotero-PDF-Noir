// Minimal builder: packs the plugin into build/*.xpi (a zip) using only
// zero-dependency code + PowerShell Compress-Archive (Windows) or `zip` (fallback).
// Reads the version from manifest.json. No npm/bun dependencies required.
import { $ } from "bun";
import { cp, mkdir, rm, readFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BUILD_DIR = path.join(ROOT, "build");
const STAGE_DIR = path.join(BUILD_DIR, "stage");

const manifest = JSON.parse(await readFile(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version ?? "0.0.1";
const xpiName = `zotero-pdf-noir-${version}.xpi`;
const xpiPath = path.join(BUILD_DIR, xpiName);
const zipPath = path.join(BUILD_DIR, `zotero-pdf-noir-${version}.zip`);

// Sanity: required bootstrap-addon files.
const required = ["manifest.json", "bootstrap.js", "prefs.js"];
for (const f of required) {
  if (!existsSync(path.join(ROOT, f))) {
    console.error(`missing required file: ${f}`);
    process.exit(1);
  }
}

await rm(STAGE_DIR, { recursive: true, force: true });
await mkdir(STAGE_DIR, { recursive: true });

// Allowlist — keeps dev files (README, scripts, .git) out of the xpi.
// content/ carries the noir modules injected into the pdf.js viewer realm.
const entries = ["manifest.json", "bootstrap.js", "prefs.js", "content"];
for (const e of entries) {
  await cp(path.join(ROOT, e), path.join(STAGE_DIR, e), { recursive: true });
}

await rm(xpiPath, { force: true });
await rm(zipPath, { force: true });

if (process.platform === "win32") {
  await $`powershell -NoProfile -Command Compress-Archive -Path ${STAGE_DIR + "\\*"} -DestinationPath ${xpiPath}`;
} else {
  await $`sh -c ${`cd ${JSON.stringify(STAGE_DIR)} && zip -qr ${JSON.stringify(xpiPath)} .`}`;
}
await copyFile(xpiPath, zipPath);
await rm(STAGE_DIR, { recursive: true, force: true });

console.log(`built: ${xpiPath}`);
console.log(`built: ${zipPath}`);
console.log(`note: .xpi and .zip are identical (xpi is a zip)`);
