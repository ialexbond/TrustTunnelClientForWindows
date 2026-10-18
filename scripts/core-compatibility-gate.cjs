"use strict";

// Check the exact sidecar Tauri bundles. Only read-only CLI queries are allowed;
// no configuration file is passed and no tunnel is started.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const EXPECTED_VERSION = "1.1.11";
const EXPECTED_POLICY_VERSION = "1";
const EXPECTED_ENDPOINT_PROBE_VERSION = "1";
const DEFAULT_CORE = path.join(__dirname, "..", "gui-pro", "src-tauri",
  "trusttunnel_client-x86_64-pc-windows-msvc.exe");

function validateWindowsExecutable(bytes) {
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("the sidecar is missing a Windows executable header (empty build stubs are not allowed)");
  }
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 26 > bytes.length || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") {
    throw new Error("the sidecar has an invalid Windows executable header");
  }
  const characteristics = bytes.readUInt16LE(pe + 22);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  if (bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b) {
    throw new Error("the sidecar must be a Windows x64 executable");
  }
  if (!(characteristics & 0x2) || (characteristics & 0x2000)
      || bytes.readUInt16LE(pe + 6) === 0 || optionalSize < 112
      || pe + 24 + optionalSize > bytes.length) {
    throw new Error("the sidecar is not a complete Windows executable");
  }
}

function probeCore(filePath, flag) {
  return spawnSync(filePath, [flag], {
    cwd: path.dirname(filePath),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
}

function query(filePath, flag, probe, allowedStatuses = [0]) {
  const result = probe(filePath, flag);
  if (result.error || result.signal || !allowedStatuses.includes(result.status)) {
    throw new Error(`${flag} did not complete successfully within the query limits`);
  }
  return String(result.stdout || "").trim();
}

function verifyCore(filePath = DEFAULT_CORE, options = {}) {
  const readFile = options.readFile || fs.readFileSync;
  const probe = options.probe || probeCore;
  const platform = options.platform || process.platform;
  let bytes;
  try {
    bytes = readFile(filePath);
  } catch {
    throw new Error("the bundled sidecar is missing or unreadable; build and stage the matching fork core first");
  }
  validateWindowsExecutable(bytes);
  if (platform !== "win32") {
    throw new Error("the Windows sidecar must be measured on Windows; cross-platform fixture tests do not verify a release binary");
  }

  const version = query(filePath, "--version", probe);
  if (version !== `trusttunnel_client ${EXPECTED_VERSION}`) {
    throw new Error(`the bundled sidecar must report trusttunnel_client ${EXPECTED_VERSION}; rebuild it from this fork`);
  }

  // Older official cores do not recognize the fork flag. Inspect their safe
  // help command first; the TrustTunnel CLI normally exits 1 after printing it.
  const help = query(filePath, "--help", probe, [0, 1]);
  if (!/(?:^|[\s,])--routing-policy-version(?:[\s,=]|$)/m.test(help)) {
    throw new Error("the bundled core does not advertise the fork routing policy capability; an official prebuilt core cannot replace it");
  }
  const policy = query(filePath, "--routing-policy-version", probe);
  if (policy !== EXPECTED_POLICY_VERSION) {
    throw new Error(`the bundled core must support routing policy ${EXPECTED_POLICY_VERSION}`);
  }
  if (!/(?:^|[\s,])--endpoint-probe-version(?:[\s,=]|$)/m.test(help)
      || !/(?:^|[\s,])--probe-endpoint(?:[\s,=]|$)/m.test(help)) {
    throw new Error("the bundled core does not advertise the protected endpoint probe capability");
  }
  const endpointProbe = query(filePath, "--endpoint-probe-version", probe);
  if (endpointProbe !== EXPECTED_ENDPOINT_PROBE_VERSION) {
    throw new Error(`the bundled core must support endpoint probe ${EXPECTED_ENDPOINT_PROBE_VERSION}`);
  }
  return {
    version: EXPECTED_VERSION,
    policyVersion: EXPECTED_POLICY_VERSION,
    endpointProbeVersion: EXPECTED_ENDPOINT_PROBE_VERSION,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
}

if (require.main === module) {
  if (process.argv.length > 3) {
    console.error("Usage: node scripts/core-compatibility-gate.cjs [sidecar.exe]");
    process.exitCode = 1;
  } else {
    try {
      const result = verifyCore(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CORE);
      console.log(`core-compatibility: PASS; core ${result.version}; routing policy ${result.policyVersion}; endpoint probe ${result.endpointProbeVersion}; SHA-256 ${result.sha256}`);
    } catch (error) {
      console.error(`core-compatibility: FAIL; ${error.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { EXPECTED_VERSION, EXPECTED_POLICY_VERSION, DEFAULT_CORE, validateWindowsExecutable, verifyCore };
