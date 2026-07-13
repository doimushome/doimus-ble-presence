# doimus-ble-presence

BLE-based home occupancy detection for Doimus. Scans for Bluetooth signals from phones
to detect who's home and who's away.

## How It Works

1. Plugin scans for BLE advertisements from nearby phones
2. Matches discovered devices to people you've configured
3. RSSI (signal strength) is smoothed and fed into a state machine
4. Each person appears as an occupancy sensor in the Doimus app

## Setup

### 1. Enable BLE in Docker

Add to your `docker-compose.yml`:

```yaml
services:
  doimus-backend:
    privileged: true
    network_mode: host
    volumes:
      - /var/run/dbus/system_bus_socket:/var/run/dbus/system_bus_socket
```

### 2. Install the Plugin

Add `doimus-ble-presence` to your Doimus hub via the plugin catalog.

### 3. Configure People

In the Doimus app, open the plugin settings and add each person:

| Field | Description |
|-------|-------------|
| Name | Person's name (shown as sensor) |
| Phone Bluetooth Name | Name your phone advertises (check Bluetooth settings) |
| BLE Address | Optional MAC address (less reliable on iOS) |

### 4. Adjust Settings (Optional)

| Setting | Default | Description |
|---------|---------|-------------|
| Scan Interval | 1 minute | How often to scan |
| Scan Duration | 10 seconds | How long each scan lasts |
| Signal Threshold | -70 dBm | Cutoff for "home" |
| Away Delay | 120 seconds | Time before marking "away" |

## Requirements

- Raspberry Pi or OrangePi Zero 2W with Bluetooth
- Backend container with BLE access (see Docker config above)
- Phones with Bluetooth enabled

## iOS vs Android

| | iOS | Android |
|---|---|---|
| Always discoverable? | ✅ Yes | ⚠️ Depends on apps |
| MAC stable? | ❌ Changes every ~15min | ✅ Usually stable |
| Best identifier | Phone Bluetooth Name | BLE Address |

**Tip**: Use the phone's Bluetooth name (visible in Settings > Bluetooth) for identification.

## File Structure

```
doimus-ble-presence/
├── index.js              # Plugin entry point
├── config.schema.json    # Configuration schema
├── package.json
├── lib/
│   ├── ble-scanner.js    # BLE scanning abstraction
│   └── presence-tracker.js  # RSSI smoothing + state machine
└── AGENT.md              # Developer docs
```

## Troubleshooting

### "BLE init failed"

- Ensure Bluetooth is enabled: `hciconfig`
- Check Docker access: add `--privileged` or `--device=/dev/hci0`

### No devices found

- Make sure phone Bluetooth is ON
- Try longer scan duration (15-20 seconds)
- Check the phone's BLE name matches your config

### Flapping (home/away/home)

- Increase `awayDelay` (e.g. 300 seconds)
- Lower `rssiThreshold` (e.g. -75 dBm)

### Wrong person detected

- Verify the phone's BLE name in Bluetooth settings
- Re-enter the correct name in plugin settings

## License

MIT
