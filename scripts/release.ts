/* Release helper: packs the XPI, then generates the Zotero update manifest
 * that `applications.zotero.update_url` points at.
 *
 * The manifest is the Mozilla JSON update format as patched by Zotero:
 * `addons.<id>.updates[]` with a `version` that must be strictly greater
 * than the installed one, an `update_link`, an `update_hash` (sha256/sha512
 * only), and an `applications.zotero` compatibility block. Zotero skips any
 * entry whose `applications.zotero` block is missing.
 *
 * Usage:
 *   bun scripts/release.ts            # build + print update.json
 *   bun scripts/release.ts --write    # also write update.json to build/
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const BUILD_DIR = path.join(ROOT, "build");

const manifest = JSON.parse(await readFile(path.join(ROOT, "manifest.json"), "utf8"));
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));

if (manifest.version !== pkg.version) {
  console.error(`version mismatch: manifest ${manifest.version} vs package ${pkg.version}`);
  process.exit(1);
}

const app = manifest.applications?.zotero;
if (!app?.id || !app?.update_url) {
  console.error("manifest is missing applications.zotero.id or update_url");
  process.exit(1);
}

const version = manifest.version;
const tag = `v${version}`;
const asset = `zotero-pdf-noir-${version}.xpi`;
const xpiPath = path.join(BUILD_DIR, asset);

const xpi = await readFile(xpiPath);
const sha512 = createHash("sha512").update(xpi).digest("hex");

const base = "https://github.com/Zhanyuanium/Zotero-PDF-Noir";

const updateManifest = {
  addons: {
    [app.id]: {
      updates: [
        {
          version,
          update_link: `${base}/releases/download/${tag}/${asset}`,
          update_hash: `sha512:${sha512}`,
          update_info_url: `${base}/releases/tag/${tag}`,
          applications: {
            zotero: {
              strict_min_version: app.strict_min_version,
              strict_max_version: app.strict_max_version,
            },
          },
        },
      ],
    },
  },
};

const json = JSON.stringify(updateManifest, null, 2) + "\n";
console.log(json);

if (process.argv.includes("--write")) {
  await mkdir(BUILD_DIR, { recursive: true });
  const out = path.join(BUILD_DIR, "update.json");
  await writeFile(out, json);
  console.log(`\nwrote ${out}`);
  console.log(`upload both as release assets, and publish the release (not as a pre-release):`);
  console.log(`  gh release create ${tag} --title "${tag}" --notes-file <notes> \\`);
  console.log(`    build/${asset} build/update.json`);
}