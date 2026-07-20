"use strict";

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

function makeDeviceId(person) {
  if (person.bleAddress) {
    return `ble-${person.bleAddress.replace(/:/g, "").toLowerCase()}`;
  }
  const slug = person.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `ble-${slug}`;
}

function pushState(api, personName, trackerRef) {
  const info = trackerRef.getState(personName);
  if (!info) return;
  const deviceId = makeDeviceId(personName);
  const isHome = info.state === STATE.HOME;
  api.updateDeviceState(deviceId, {
    occupancy: isHome ? 1 : 0,
    rssi: info.avgRssi,
  });
}

// ─── Scan cycle ────────────────────────────────────────────────────────────────

async function runScanCycle(config) {
  if (!scanner || !tracker || !savedApi) return;

  const duration = (config.scanDuration || 10) * 1000;
  const people = config.people || [];

  if (people.length === 0) return;

  try {
    log("debug", `Scanning BLE (${duration / 1000}s)...`);

    const peripherals = await scanner.scan(duration);
    log("debug", `Found ${peripherals.length} BLE device(s)`);

    const seenThisCycle = new Set();

    for (const peripheral of peripherals) {
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

    // Push state to Doimus for each tracked person
    for (const person of people) {
      pushState(savedApi, person.name, tracker);
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
        pushState(api, personId, tracker);
      },
      log,
    });

    // Register a sensor for each configured person
    for (const person of people) {
      const deviceId = makeDeviceId(person);
      api.registerDevice({
        id: deviceId,
        name: person.name,
        type: "sensor",
        capabilities: ["occupancy", "rssi"],
        state: { occupancy: 0, rssi: 0 },
      });
      registeredDeviceIds.push(deviceId);
      log("info", `Registered: ${person.name} (${deviceId})`);
    }

    if (people.length === 0) {
      log("warn", "No people configured. Add people in the plugin settings.");
      return;
    }

    // Init BLE scanner
    scanner = new BLEScanner({ adapter: "dbus", log });

    scanner
      .init()
      .then(() => {
        log("info", "BLE adapter ready");

        const intervalMs = SCAN_INTERVALS[config.scanInterval] || 60000;
        log("info", `Scan interval: ${config.scanInterval || "1m"}`);

        // First scan immediately
        runScanCycle(config).catch((e) =>
          log("error", `Initial scan: ${e.message}`),
        );

        // Periodic scans
        scanTimer = setInterval(() => {
          runScanCycle(config).catch((e) =>
            log("error", `Periodic scan: ${e.message}`),
          );
        }, intervalMs);
        if (scanTimer.unref) scanTimer.unref();
      })
      .catch((err) => {
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
