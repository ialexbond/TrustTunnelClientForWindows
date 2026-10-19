#!/usr/bin/env node
// Refuse a stale native core before a GUI build can package it.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const rootArgument = args.indexOf("--repo");
const root = path.resolve(rootArgument >= 0 ? args[rootArgument + 1] : path.join(__dirname, ".."));
const sourcesOnly = args.includes("--sources-only");

function insideRoot(relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep)) throw new Error("Invalid build-input path");
  return resolved;
}

function git(argv, input) {
  return execFileSync("git", ["-c", "core.longpaths=true", "-C", root, ...argv], {
    encoding: "utf8", input, maxBuffer: 8 * 1024 * 1024,
  });
}

function verify() {
  const lock = JSON.parse(fs.readFileSync(insideRoot("config/windows-core.lock.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(insideRoot("config/" + lock.source_manifest), "utf8"));
  if (lock.schema !== 1 || manifest.schema !== 1 || !manifest.files.length) {
    throw new Error("Unsupported native build-input manifest");
  }
  const excluded = new Set(manifest.excluded_files || []);
  for (const file of excluded) {
    insideRoot(file);
    if (!file.endsWith(".md") && !file.startsWith("third-party/lwip/lwip/doc/")) {
      throw new Error("Only non-build documentation may be excluded from the native source manifest");
    }
  }
  const actual = [...new Set(git([
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...manifest.roots,
  ]).split("\0").filter((file) => file && !excluded.has(file)))].sort();
  const expected = [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index].path)) {
    throw new Error("Native source files changed. Rebuild the core and refresh its build-input lock before packaging.");
  }
  for (const file of actual) {
    insideRoot(file);
    if (/[\r\n]/.test(file) || file.startsWith('"')) throw new Error("Unsupported native source filename");
  }
  const blobs = git(["hash-object", "--stdin-paths"], actual.join("\n") + "\n").trim().split(/\r?\n/);
  for (let index = 0; index < expected.length; index++) {
    if (blobs[index] !== expected[index].git_blob) {
      throw new Error("The pinned core is stale for " + expected[index].path + ". Rebuild it and refresh the lock.");
    }
  }
  if (!sourcesOnly) {
    for (const file of lock.files) {
      const location = insideRoot(file.path);
      if (!fs.existsSync(location)) throw new Error("Run scripts/prepare-windows-build.ps1 first: " + file.name + " is missing.");
      const digest = crypto.createHash("sha256").update(fs.readFileSync(location)).digest("hex");
      if (digest !== file.sha256) throw new Error("Build resource differs from its verified lock: " + file.name);
    }
  }
  console.log(`Windows build inputs: PASS (${expected.length} native sources${sourcesOnly ? "" : ", core and WinTUN"}).`);
}

try {
  verify();
} catch (error) {
  console.error("Windows build inputs: " + error.message);
  process.exitCode = 1;
}
