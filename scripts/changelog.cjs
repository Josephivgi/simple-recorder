"use strict";

// CHANGELOG.md in the public repo is what users read as release notes. Each
// release is one section, newest first:
//
//   ## v1.2.7 (2026-10-17)
//
//   ### New
//   - ...
//
// `npm run promote -- --notes <file>` adds the section for the version it
// ships, and the public workflow publishes that section as the GitHub release
// notes. A release with no section, or one that only says the build passed its
// checks, is refused: those notes tell a user nothing about the update.
//
//   node scripts/changelog.cjs section v1.2.7 [CHANGELOG.md]   print one section

const fs = require("fs");

const TITLE = "# Changelog";

// Notes that describe the pipeline instead of the update.
const BOILERPLATE = [/passed (the )?(release )?(security )?gate/i, /passed (all |the )?(unit )?tests/i];

function headingTag(line) {
  const m = /^##\s+(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(line);
  return m ? m[1] : "";
}

// The body of the section for `tag`, trimmed; "" when there is none.
function changelogSection(text, tag) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex((line) => headingTag(line) === tag);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end += 1;
  return lines.slice(start + 1, end).join("\n").trim();
}

// Why these notes cannot ship, or "" when they can.
function notesProblem(notes) {
  const body = String(notes || "").trim();
  if (!body) return "The release notes are empty.";
  const meaningful = body.split(/\r?\n/).filter((line) => line.trim() && !BOILERPLATE.some((re) => re.test(line)));
  if (!meaningful.length) return "The release notes only say the build passed its checks. Say what changed for users.";
  return "";
}

// `existing` with a new section for `tag` on top, under the title.
function addChangelogSection(existing, tag, date, notes) {
  const problem = notesProblem(notes);
  if (problem) throw new Error(problem);
  const text = String(existing || "").replace(/\r\n/g, "\n");
  if (text.split("\n").some((line) => headingTag(line) === tag)) {
    throw new Error("CHANGELOG.md already has a section for " + tag + ".");
  }
  const rest = text.startsWith(TITLE) ? text.slice(TITLE.length).trim() : text.trim();
  const section = "## " + tag + " (" + date + ")\n\n" + String(notes).replace(/\r\n/g, "\n").trim();
  return TITLE + "\n\n" + section + "\n" + (rest ? "\n" + rest + "\n" : "");
}

if (require.main === module) {
  const [cmd, tag, file = "CHANGELOG.md"] = process.argv.slice(2);
  if (cmd !== "section" || !tag) {
    process.stderr.write("Usage: node scripts/changelog.cjs section <tag> [CHANGELOG.md]\n");
    process.exit(2);
  }
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const notes = changelogSection(text, tag);
  const problem = notesProblem(notes);
  if (problem) {
    process.stderr.write("No usable " + file + " section for " + tag + ". " + problem + "\n");
    process.exit(1);
  }
  process.stdout.write(notes + "\n");
}

module.exports = { changelogSection, addChangelogSection, notesProblem };
