#!/usr/bin/env bash
#
# Bump the plugin version in lockstep across every manifest and roll the CHANGELOG.
# Usage: scripts/bump-version.sh <major|minor|patch>
#
# Edits files only — it does not commit, tag, or push (see RELEASING.md for those steps).

set -euo pipefail
cd "$(dirname "$0")/.."

level="${1:-}"
case "$level" in
  major|minor|patch) ;;
  *) echo "usage: $0 <major|minor|patch>" >&2; exit 2 ;;
esac

cur="$(node -p "require('./package.json').version")"
IFS=. read -r MA MI PA <<<"$cur"
case "$level" in
  major) MA=$((MA + 1)); MI=0; PA=0 ;;
  minor) MI=$((MI + 1)); PA=0 ;;
  patch) PA=$((PA + 1)) ;;
esac
new="$MA.$MI.$PA"

echo "bumping $cur -> $new"

# All four version strings live as `"version": "<x>"`; replace only those, in all manifests.
for f in package.json plugins/grok/.claude-plugin/plugin.json .claude-plugin/marketplace.json; do
  perl -pi -e "s/\"version\": \"\Q$cur\E\"/\"version\": \"$new\"/g" "$f"
done

# Roll the CHANGELOG: relabel [Unreleased]'s notes as the new dated release and leave a fresh
# empty [Unreleased] above them. Also seed the version's compare link.
today="$(date +%F)"
node - "$new" "$today" <<'NODE'
const fs = require("fs");
const [ver, date] = process.argv.slice(2);
let c = fs.readFileSync("CHANGELOG.md", "utf8");
c = c.replace(/## \[Unreleased\]\n/, `## [Unreleased]\n\n## [${ver}] - ${date}\n`);
if (!c.includes(`[${ver}]: `)) {
  c = c.replace(
    /\[Unreleased\]: (\S+)compare\/v\S+\.\.\.HEAD\n/,
    (m, base) => `[Unreleased]: ${base}compare/v${ver}...HEAD\n[${ver}]: ${base}compare/v<PREV>...v${ver}\n`
  );
}
fs.writeFileSync("CHANGELOG.md", c);
NODE

echo "done. next:"
echo "  1. edit CHANGELOG.md — confirm the [$new] notes, fix the <PREV> in its compare link"
echo "  2. npm test"
echo "  3. git commit -am \"Release $new\" && git tag -a v$new -m \"v$new\" && git push --follow-tags"
