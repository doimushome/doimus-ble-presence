# AGENT.md

This file provides guidance to coding agents working on the doimus-ble-presence plugin.

## Project Overview

**doimus-ble-presence** is a Doimus native plugin for BLE-based home occupancy detection.
It scans for Bluetooth Low Energy signals from phones and maps them to people, exposing
each person as an occupancy sensor in the Doimus app.

### Key Concepts

- **BLE Scanning**: Uses `@stoprocent/noble` with `dbus` binding (Docker-friendly, no root needed)
- **Device Matching**: Matches phones by BLE advertised name or MAC address
- **Presence Tracking**: RSSI smoothing + state machine with debounce (HOME/AWAY)
- **Mobile-First**: All configuration through the Doimus mobile app — no CLI needed

## Repository Structure

- `index.js` — Plugin entry point (start/stop/setConfig)
- `lib/ble-scanner.js` — BLE scanning abstraction
- `lib/presence-tracker.js` — RSSI smoothing + state machine
- `config.schema.json` — Configuration schema (rendered in app wizard)
- `package.json` — Dependencies

## Key Commands

```bash
npm install
```

## Architecture

```
Mobile App Config → people array
        ↓
BLE Scanner (dbus binding)
        ↓
Presence Tracker (RSSI + state machine)
        ↓
api.updateDeviceState → Occupancy sensors
```

## Logging

Always use the `createLogger` helper:

```javascript
function createLogger(api, prefix) {
  return (level, msg) => api.log(level, `[${prefix}] ${msg}`);
}

const log = createLogger(api, "BlePresence");
log("info", "BLE adapter ready");
```

## BLE Scanner

### Docker Configuration

The backend container needs BLE access. Add to `docker-compose.yml`:

```yaml
services:
  doimus-backend:
    # Option 1: Simplest (dev)
    privileged: true
    network_mode: host
    volumes:
      - /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket

    # Option 2: Tighter security (prod)
    # network_mode: host
    # devices:
    #   - /dev/hci0:/dev/hci0
    # cap_add:
    #   - NET_ADMIN
    #   - NET_RAW
    # volumes:
    #   - /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket
```

### Raspberry Pi vs OrangePi

| Property | Raspberry Pi | OrangePi Zero 2W |
|----------|-------------|------------------|
| BT Chip | BCM43455 | WiFi+BT combo |
| BlueZ | 5.66+ | 5.64+ |
| Docker BLE | Well-tested | Works (use dbus binding) |

Both work with the `dbus` binding. Use `hci` only if dbus fails.

### iOS vs Android

| | iOS | Android |
|---|---|---|
| Always discoverable? | ✅ Yes (BT on) | ⚠️ App-dependent |
| MAC stable? | ❌ Rotates ~15min | ✅ Usually stable |
| Best identifier | `bleName` | `bleAddress` |

## Presence Tracker

### State Machine

```
UNKNOWN → HOME (after 5s of detection)
HOME → AWAY (after 120s of non-detection)
AWAY → HOME (after 5s of detection)
```

### RSSI Thresholds

| RSSI (dBm) | Distance |
|------------|----------|
| -30 to -50 | < 1m |
| -50 to -60 | 1-3m |
| -60 to -70 | 3-5m (default threshold) |
| -70 to -80 | 5-10m |
| < -80 | Out of range |

## Configuration

Configured through the Doimus mobile app wizard:

| Option | Default | Description |
|--------|---------|-------------|
| `people` | `[]` | Array of {name, bleName, bleAddress} |
| `scanInterval` | `1m` | How often to scan |
| `scanDuration` | `10` | Scan length in seconds |
| `rssiThreshold` | `-70` | Signal cutoff for "home" |
| `awayDelay` | `120` | Seconds before marking "away" |

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "BLE init failed" | No BLE access in Docker | Add `--privileged` or `--device=/dev/hci0` |
| No devices found | Phone BT off | Enable Bluetooth on phone |
| Flapping | Threshold too tight | Lower `rssiThreshold` or increase `awayDelay` |
| Wrong person | Name mismatch | Check phone's BLE name in Bluetooth settings |

## Debugging

```bash
# Docker logs
docker compose logs -f | grep "BlePresence"

# Check BLE adapter
hciconfig
systemctl status bluetooth
```

### Key Log Patterns

| Log line | Meaning |
|---|---|
| `[BlePresence] BLE adapter ready` | Scanner initialised |
| `[BlePresence] Scanning BLE (10s)...` | Scan cycle started |
| `[BlePresence] Name: RSSI -65 dBm` | Device detected |
| `[BlePresence] Name: unknown → home` | State transition |
| `[BlePresence] BLE init failed` | Hardware access issue |
