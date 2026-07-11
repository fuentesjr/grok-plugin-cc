import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

// The version lives in four places and is also the cache-busting key for the installed
// plugin snapshot (see RELEASING.md), so drift means a release that silently never reaches
// installs. Keep them in lockstep.
test("plugin version strings are in lockstep across all manifests", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const versions = {
    "package.json": readJson("package.json").version,
    "plugins/grok/.claude-plugin/plugin.json": readJson("plugins/grok/.claude-plugin/plugin.json").version,
    "marketplace.json metadata.version": marketplace.metadata.version,
    "marketplace.json plugins[0].version": marketplace.plugins[0].version
  };
  const distinct = [...new Set(Object.values(versions))];
  assert.equal(distinct.length, 1, `version drift: ${JSON.stringify(versions, null, 2)}`);
  assert.match(distinct[0], /^\d+\.\d+\.\d+$/, `not semver: ${distinct[0]}`);
});

test("CHANGELOG has an entry for the current version", () => {
  const version = readJson("package.json").version;
  assert.ok(
    read("CHANGELOG.md").includes(`## [${version}]`),
    `CHANGELOG.md has no "## [${version}]" section — add one before releasing (see RELEASING.md)`
  );
});
