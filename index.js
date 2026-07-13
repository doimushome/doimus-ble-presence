"use strict";

const fs = require("fs");
const path = require("path");
const { BLEScanner } = require("./lib/ble-scanner");
const { PresenceTracker, STATE } = require("./lib/presence-tracker");

// ─── Logger ────────────────────────────────────────────────────────────────────

function createLogger(api, prefix) {
  return (level, msg) => api.log(level, `[${prefix}] ${msg}`);
}

// ─── Scan interval map ─────────────────────────────────────────────────────────

const SCAN_INTERVALS = {
  "1m": 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

// ─── State ─────────────────────────────────────────────────────────────────────

let savedApi = null;
let log = null;
let scanner = null;
let tracker = null;
let scanTimer = null;
const registeredDeviceIds = [];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeDeviceId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `ble-${slug}`;
}

function persistPath() {
  const dir = path.join(process.cwd(), "data", "persist");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "ble-presence-devices.json");
}

function loadPersistedDevices() {
  try {
    const file = persistPath();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {}
  return [];
}

function persistDevices(devices) {
  try {
    fs.writeFileSync(persistPath(), JSON.stringify(devices, null, 2), "utf8");
  } catch (err) {
    log("error", `Failed to persist devices: ${err.message}`);
  }
}

// ─── Scan cycle ────────────────────────────────────────────────────────────────

async function runScanCycle(config) {
  if (!scanner || !tracker) return;

  const duration = (config.scanDuration || 10) * 1000;
  const people = config.people || [];

  if (people.length === 0) {
    log("debug", "No people configured, skipping scan");
    return;
  }

  try {
    log("debug", `Scanning BLE (${duration / 1000}s)...`);

    const peripherals = await scanner.scan(duration);
    log("debug", `Found ${peripherals.length} BLE device(s)`);

    const seenThisCycle = new Set();

    for (const peripheral of peripherals) {
      // Match against configured people
      const matched = people.find((p) => {
        if (p.bleName && peripheral.localName === p.bleName) return true;
        if (p.bleAddress && peripheral.address.toLowerCase() === p.bleAddress.toLowerCase()) return true;
        return false;
      });

      if (!matched) continue;

      seenThisCycle.add(matched.name);
      tracker.updateReading(matched.name, peripheral.rssi);
      log("debug", `${matched.name}: RSSI ${peripheral.rssi} dBm`);
    }

    // Mark unseen people
    for (const person of people) {
      if (!seenThisCycle.has(person.name)) {
        tracker.markNotSeen(person.name);
      }
    }

    // Update Doimus state
    for (const person of people) {
      const stateInfo = tracker.getState(person.name);
      if (!stateInfo) continue;

      const deviceId = makeDeviceId(person.name);
      const isHome = stateInfo.state === STATE.HOME;

      const state = {
        on: isHome,
        occupancy: isHome ? 1 : 0,
        rssi: stateInfo.avgRssi,
      };

      if (registeredDeviceIds.includes(deviceId)) {
        savedApi.updateDeviceState(deviceId, state);
      }
    }
  } catch (err) {
    log("error", `Scan failed: ${err.message}`);
  }
}

// ─── Plugin entry ──────────────────────────────────────────────────────────────

module.exports = {
  start(config, api) {
    savedApi = api;
    log = createLogger(api, "BlePresence");

    log("info", "Starting BLE Presence plugin...");

    const people = config.people || [];
    const rssiThreshold = config.rssiThreshold || -70;
    const awayDelay = (config.awayDelay || 120) * 1000;

    // Init presence tracker
    tracker = new PresenceTracker({
      rssiThreshold,
      homeDelay: 5000,
      awayDelay,
      onStateChange: (personId, oldState, newState, avgRssi) => {
        log("info", `${personId}: ${oldState} → ${newState} (RSSI: ${avgRssi} dBm)`);
        const deviceId = makeDeviceId(personId);
        const isHome = newState === STATE.HOME;
        savedApi.updateDeviceState(deviceId, {
          on: isHome,
          occupancy: isHome ? 1 : 0,
          rssi: avgRssi,
        });
      },
      log,
    });

    // Register a sensor for each configured person
    for (const person of people) {
      const deviceId = makeDeviceId(person.name);
      api.registerDevice({
        id: deviceId,
        name: person.name,
        type: "sensor",
        capabilities: ["on", "occupancy", "rssi"],
        state: { on: false, occupancy: 0, rssi: 0 },
      });
      registeredDeviceIds.push(deviceId);
      log("info", `Registered: ${person.name} (${deviceId})`);
    }

    if (people.length === 0) {
      log("warn", "No people configured. Add people in the plugin settings.");
    }

    // Init BLE scanner
    scanner = new BLEScanner({
      adapter: "dbus",
      log,
    });

    scanner.init().then(() => {
      log("info", "BLE adapter ready");

      // Start scan loop
      const intervalMs = SCAN_INTERVALS[config.scanInterval] || 60000;
      log("info", `Scan interval: ${config.scanInterval || "1m"}`);

      // First scan immediately
      runScanCycle(config).catch((e) => log("error", `Initial scan: ${e.message}`));

      scanTimer = setInterval(() => {
        runScanCycle(config).catch((e) => log("error", `Periodic scan: ${e.message}`));
      }, intervalMs);
      if (scanTimer.unref) scanTimer.unref();
    }).catch((err) => {
      log("error", `BLE init failed: ${err.message}. Check Docker BLE access.`);
    });
  },

  stop() {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    if (scanner) {
      scanner.stop().catch(() => {});
      scanner = null;
    }
    if (tracker) {
      tracker.resetAll();
      tracker = null;
    }
    registeredDeviceIds.length = 0;
    savedApi = null;
    log = null;
  },

  setConfig(config) {
    this.stop();
    this.start(config, savedApi);
  },
};
