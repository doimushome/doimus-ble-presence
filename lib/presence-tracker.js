"use strict";

/**
 * Presence Tracker — RSSI smoothing + state machine.
 *
 * For each person, maintains:
 *   - Rolling window of RSSI readings (moving average)
 *   - Presence state: 'unknown' | 'home' | 'away'
 *   - Debounce timers to prevent flapping
 *
 * State transitions require sustained signal:
 *   unknown → home   (after homeDelay of continuous detection)
 *   home    → away   (after awayDelay of non-detection)
 *   away    → home   (after homeDelay of continuous detection)
 */

const STATE = {
  UNKNOWN: "unknown",
  HOME: "home",
  AWAY: "away",
};

class PresenceTracker {
  /**
   * @param {object} opts
   * @param {number} opts.rssiThreshold  - dBm cutoff (default -70)
   * @param {number} opts.homeDelay      - ms before confirming home (default 5000)
   * @param {number} opts.awayDelay      - ms before confirming away (default 120000)
   * @param {number} opts.rssiWindow     - readings to average (default 10)
   * @param {function} opts.onStateChange - (personId, oldState, newState, avgRssi)
   * @param {function} opts.log
   */
  constructor({
    rssiThreshold = -70,
    homeDelay = 5000,
    awayDelay = 120000,
    rssiWindow = 10,
    onStateChange = () => {},
    log = () => {},
  } = {}) {
    this.rssiThreshold = rssiThreshold;
    this.homeDelay = homeDelay;
    this.awayDelay = awayDelay;
    this.rssiWindow = rssiWindow;
    this.onStateChange = onStateChange;
    this.log = log;
    this._devices = new Map();
  }

  updateReading(deviceId, rssi) {
    let dev = this._devices.get(deviceId);
    if (!dev) {
      dev = {
        readings: [],
        avgRssi: rssi,
        detected: false,
        state: STATE.UNKNOWN,
        debounceTimer: null,
        lastSeen: Date.now(),
      };
      this._devices.set(deviceId, dev);
    }

    dev.readings.push({ rssi, time: Date.now() });
    if (dev.readings.length > this.rssiWindow) dev.readings.shift();

    dev.avgRssi = dev.readings.reduce((s, r) => s + r.rssi, 0) / dev.readings.length;
    dev.lastSeen = Date.now();

    const detected = dev.avgRssi > this.rssiThreshold;
    if (detected !== dev.detected) {
      dev.detected = detected;
      this._scheduleTransition(deviceId, dev);
    }
  }

  markNotSeen(deviceId) {
    const dev = this._devices.get(deviceId);
    if (!dev) return;

    dev.readings.push({ rssi: -100, time: Date.now() });
    if (dev.readings.length > this.rssiWindow) dev.readings.shift();

    dev.avgRssi = dev.readings.reduce((s, r) => s + r.rssi, 0) / dev.readings.length;

    if (dev.avgRssi <= this.rssiThreshold && dev.detected) {
      dev.detected = false;
      this._scheduleTransition(deviceId, dev);
    }
  }

  getState(deviceId) {
    const dev = this._devices.get(deviceId);
    if (!dev) return null;
    return { state: dev.state, avgRssi: Math.round(dev.avgRssi), lastSeen: dev.lastSeen };
  }

  resetAll() {
    for (const dev of this._devices.values()) {
      if (dev.debounceTimer) clearTimeout(dev.debounceTimer);
    }
    this._devices.clear();
  }

  _scheduleTransition(deviceId, dev) {
    if (dev.debounceTimer) {
      clearTimeout(dev.debounceTimer);
      dev.debounceTimer = null;
    }

    const delay = dev.detected ? this.homeDelay : this.awayDelay;
    const target = dev.detected ? STATE.HOME : STATE.AWAY;

    dev.debounceTimer = setTimeout(() => {
      const old = dev.state;
      if (old !== target) {
        dev.state = target;
        this.onStateChange(deviceId, old, target, Math.round(dev.avgRssi));
      }
      dev.debounceTimer = null;
    }, delay);
  }
}

module.exports = { PresenceTracker, STATE };
