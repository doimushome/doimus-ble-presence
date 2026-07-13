"use strict";

/**
 * BLE Scanner — wraps @stoprocent/noble for Docker-friendly BLE scanning.
 *
 * Bindings:
 *   - 'dbus'   → BlueZ via D-Bus (recommended for Docker, no root needed)
 *   - 'hci'    → Direct HCI socket (needs root or cap_net_raw)
 *   - 'default' → Auto-detect
 *
 * Both Raspberry Pi and OrangePi Zero 2W work with 'dbus' binding.
 */

let noble;
try {
  noble = require("@stoprocent/noble");
} catch {
  noble = null;
}

class BLEScanner {
  /**
   * @param {object} opts
   * @param {string} opts.adapter - 'dbus' | 'hci' | 'default'
   * @param {function} opts.log   - createLogger instance
   */
  constructor({ adapter = "dbus", log = () => {} } = {}) {
    this.adapter = adapter;
    this.log = log;
    this._noble = null;
    this._scanning = false;
    this._poweredOn = false;
  }

  async init() {
    if (!noble) {
      throw new Error(
        "@stoprocent/noble not installed. Run: npm install",
      );
    }

    this.log("info", `BLE scanner init (binding=${this.adapter})`);

    this._noble = noble.withBindings(this.adapter);
    await this._noble.waitForPoweredOnAsync();
    this._poweredOn = true;
    this.log("info", "BLE adapter powered on");
  }

  /**
   * Run a single scan. Returns discovered peripherals.
   * @param {number} durationMs
   * @returns {Promise<Array<{id: string, address: string, localName: string, rssi: number, manufacturerData: Buffer|null}>>}
   */
  async scan(durationMs = 10000) {
    if (!this._noble || !this._poweredOn) {
      throw new Error("Scanner not initialised");
    }
    if (this._scanning) {
      this.log("debug", "Scan already in progress, skipping");
      return [];
    }

    this._scanning = true;
    const devices = new Map();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._noble.stopScanningAsync().catch(() => {});
        this._scanning = false;
        resolve(Array.from(devices.values()));
      }, durationMs);

      this._noble.startScanningAsync([], true).then(() => {
        this._noble.on("discover", (peripheral) => {
          devices.set(peripheral.address, {
            id: peripheral.id,
            address: peripheral.address,
            localName: peripheral.advertisement?.localName || "",
            rssi: peripheral.rssi,
            manufacturerData: peripheral.advertisement?.manufacturerData || null,
          });
        });
      }).catch((err) => {
        this.log("error", `Scan start failed: ${err.message}`);
        clearTimeout(timeout);
        this._scanning = false;
        resolve([]);
      });
    });
  }

  async stop() {
    if (this._noble) {
      try { await this._noble.stopScanningAsync(); } catch {}
    }
    this._scanning = false;
  }
}

module.exports = { BLEScanner };
