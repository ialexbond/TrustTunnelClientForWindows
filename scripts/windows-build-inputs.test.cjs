const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");

test("packaging accepts the matching pair and rejects stale sources or replaced resources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-build-inputs-"));
  try {
    fs.mkdirSync(path.join(root, "native"));
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "native/core.cpp"), "int version = 1;\n");
    fs.writeFileSync(path.join(root, "core.exe"), "verified-core");
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "-c", "core.autocrlf=false", "add", "native/core.cpp"]);
    const blob = execFileSync("git", ["-C", root, "hash-object", "native/core.cpp"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(root, "config/windows-core-sources.json"), JSON.stringify({
      schema: 1, roots: ["native"], files: [{ path: "native/core.cpp", git_blob: blob }],
    }));
    fs.writeFileSync(path.join(root, "config/windows-core.lock.json"), JSON.stringify({
      schema: 1, source_manifest: "windows-core-sources.json", files: [{
        name: "core.exe", path: "core.exe",
        sha256: crypto.createHash("sha256").update("verified-core").digest("hex"),
      }],
    }));
    const run = () => spawnSync(process.execPath, [path.join(__dirname, "windows-build-inputs.cjs"), "--repo", root], { encoding: "utf8" });
    assert.equal(run().status, 0, "matching native source and resource must be accepted");
    fs.writeFileSync(path.join(root, "native/README.md"), "Optional API reference");
    fs.writeFileSync(path.join(root, "config/windows-core-sources.json"), JSON.stringify({
      schema: 1, roots: ["native"], excluded_files: ["native/README.md"],
      files: [{ path: "native/core.cpp", git_blob: blob }],
    }));
    assert.equal(run().status, 0, "non-build documentation does not invalidate the compiled core");
    fs.appendFileSync(path.join(root, "native/core.cpp"), "int changed = 1;\n");
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pinned core is stale/);
    fs.writeFileSync(path.join(root, "native/core.cpp"), "int version = 1;\n");
    fs.writeFileSync(path.join(root, "native/added.cpp"), "int added = 1;\n");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Native source files changed/);
    fs.unlinkSync(path.join(root, "native/added.cpp"));
    fs.writeFileSync(path.join(root, "core.exe"), "unrelated-core");
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /resource differs/);
  } finally {
    // The exact fresh temporary directory is owned by this test.
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("tt-build-inputs-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
