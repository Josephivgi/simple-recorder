"use strict";

// Settings > Report a problem: opens a new issue on the public repo in the
// browser, using the repo's issue forms. Only the app version and Windows
// version are filled in. The app sends nothing itself; the user reads and
// submits the issue on GitHub.

const ISSUE_REPO = "Josephivgi/simple-recorder";
const TEMPLATES = { bug: "bug_report.yml", feature: "feature_request.yml" };

function osLabel(platform, release) {
  const rel = String(release || "");
  if (platform === "win32") {
    const build = Number(rel.split(".")[2]) || 0;
    return (build >= 22000 ? "Windows 11" : "Windows 10") + " (" + rel + ")";
  }
  return String(platform || "") + " " + rel;
}

function issueUrl(kind, info) {
  const template = TEMPLATES[kind];
  if (!template) throw new Error("Unknown report kind: " + kind);
  const src = info || {};
  const params = new URLSearchParams({ template });
  const version = String(src.version || "");
  if (/^\d+\.\d+\.\d+$/.test(version)) params.set("version", "v" + version);
  if (kind === "bug" && src.os) params.set("os", String(src.os).slice(0, 80));
  return "https://github.com/" + ISSUE_REPO + "/issues/new?" + params.toString();
}

module.exports = { ISSUE_REPO, TEMPLATES, osLabel, issueUrl };
