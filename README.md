# Matter-Homematic Bridge

A Matter bridge for Homematic CCU3/RaspberryMatic that exposes your Homematic devices to Matter-compatible smart home ecosystems like Apple Home, Google Home, Amazon Alexa, and Samsung SmartThings.

## Overview

This project provides the same functionality as [hap-homematic](https://github.com/thkl/hap-homematic) but uses the Matter protocol instead of HomeKit. This allows you to integrate your Homematic devices with any Matter-compatible ecosystem, not just Apple HomeKit.

## Requirements

- Node.js 18 or later
- CCU3, RaspberryMatic, or compatible Homematic central unit
- Network access to the CCU (ports 2001, 2010, etc.)
- A Matter-compatible smart home hub (Apple HomePod, Google Nest Hub, Amazon Echo, etc.)

## Installation

```bash
# Clone the repository
git clone https://github.com/homematic-community/matter-homematic.git
cd matter-homematic

# Install dependencies
npm install

# Build
npm run build
```

## Configuration

1. Copy the example configuration:
```bash
cp config.example.json config.json
```

2. Edit `config.json` and set your CCU IP address:
```json
{
  "ccu": {
    "host": "192.168.1.100"  // Your CCU IP address
  }
}
```

## Usage

### Start the bridge

```bash
npm start
```

Or with command-line options:
```bash
npm start -- --ccu=192.168.1.100 --port=5540
```

### Pairing with your smart home

After starting the bridge, you'll see pairing information in the console:

```
========================================
Matter-Homematic Bridge is ready!
========================================

To pair with your smart home controller:

  Manual Pairing Code: 20242024
  Discriminator: 3840
  Port: 5540

========================================
```

Use this pairing code in your smart home app:

- **Apple Home**: Open Home app → Add Accessory → More Options → Enter Setup Code
- **Google Home**: Open Google Home → + → Set up device → Matter-enabled device
- **Amazon Alexa**: Open Alexa app → Devices → + → Add Device → Matter

The web UI dashboard (port 8080) shows the manual pairing code and a scannable
QR code.

### Pairing with multiple systems (multi-admin)

Matter supports multiple controllers (called *fabrics*) on the same bridge —
Apple Home, Alexa, and Google Home can all control the devices simultaneously.
But the way you add the second and later controllers is different from the
first:

- **First controller:** use the bridge's own QR code / manual pairing code
  (web UI dashboard or log output). This works only while the bridge is
  *uncommissioned* — after the first pairing, the commissioning window closes
  and the original code stops being accepted.
- **Additional controllers:** the *already-paired* controller must open a new
  commissioning window. The code shown by the bridge will **not** work again.
  - **From Apple Home:** open the bridge accessory's settings → **Turn On
    Pairing Mode** → a new one-time setup code is displayed. Enter or scan it
    in the other ecosystem's app (e.g. Alexa: Devices → + → Add Device →
    Matter → "device already in use with another app").
  - **From Alexa:** device settings → **Other Assistants and Apps** → Add
    Another, then use the generated code in the other app.
  - **From Google Home:** device settings → **Linked Matter apps & services**
    → Link apps & services.
- Each new pairing window is time-limited (typically 15 minutes) and shows a
  fresh one-time code; the bridge stays connected to all fabrics afterwards,
  including across restarts.
- The bridge uses Matter's **test vendor ID** (`0xFFF1`), so every ecosystem
  shows an "uncertified device" warning during pairing — confirm to proceed.
- **Removing the bridge** from the *first* app does not free the others: each
  fabric must be removed from its own app. A full reset (deleting the
  `.matter-homematic` storage directory) wipes all fabrics and requires
  re-pairing everywhere.

## Supported Devices

### Switches & Actuators
- HM-LC-Sw* (Classic switches)
- HmIP-PS*, HmIP-PSM*, HmIP-FSM* (IP switches)

### Dimmers
- HM-LC-Dim* (Classic dimmers)
- HmIP-BDT*, HmIP-PDT*, HmIP-FDT* (IP dimmers)

### Blinds & Shutters
- HM-LC-Bl*, HM-LC-Ja* (Classic blinds)
- HmIP-BROLL*, HmIP-FROLL*, HmIP-BBL*, HmIP-FBL* (IP blinds)

### Thermostats
- HM-CC-RT-DN (Classic thermostat)
- HmIP-eTRV*, HmIP-STH*, HmIP-STHD* (IP thermostats)

### Sensors
- HM-Sec-SC*, HmIP-SWDO*, HmIP-SWDM* (Contact sensors)
- HM-Sec-MDIR*, HmIP-SMI*, HmIP-SMO* (Motion sensors)
- HM-WDS* (Weather sensors)

### Door Locks
- HM-Sec-Key (Keymatic)
- HmIP-DLD (IP door lock)

## Architecture

```
┌─────────────────────────────────────────┐
│         Matter Ecosystem                 │
│  (Apple/Google/Amazon/Samsung)          │
└─────────────────────────────────────────┘
                    │
                    │ Matter Protocol
                    ▼
┌─────────────────────────────────────────┐
│       Matter-Homematic Bridge           │
│  ┌─────────────┐  ┌─────────────────┐  │
│  │ Matter.js   │  │ Device Mapper   │  │
│  │ Server      │◄─┤ (HM ↔ Matter)   │  │
│  └─────────────┘  └─────────────────┘  │
│         │                 │             │
│  ┌──────┴─────────────────┴──────────┐ │
│  │       CCU Connector (XML-RPC)     │ │
│  └───────────────────────────────────┘ │
└─────────────────────────────────────────┘
                    │
                    │ XML-RPC
                    ▼
┌─────────────────────────────────────────┐
│        CCU3 / RaspberryMatic            │
└─────────────────────────────────────────┘
                    │
                    │ 868 MHz
                    ▼
┌─────────────────────────────────────────┐
│          Homematic Devices              │
└─────────────────────────────────────────┘
```

## CCU Addon Installation

The bridge can be installed directly on RaspberryMatic (CCU3, RaspberryMatic on Pi, OVA, etc.) as a CCU addon. Node.js 18+ is provided by the RaspberryMatic base image — no extra runtime needs to be installed.

### Building the addon tarball

```bash
npm install
npm run build:addon
# → dist-addon/matter-homematic-<version>.tar.gz
```

The tarball bundles a prod-only `node_modules`, the compiled `dist/`, and the web UI. Because all dependencies are pure JavaScript, the same artifact runs on aarch64, armv7, and x86_64 RaspberryMatic builds.

### Installing on the CCU

1. Open the CCU WebUI → **Einstellungen / Settings** → **Systemsteuerung / System Settings** → **Zusatzsoftware / Additional Software**.
2. Choose the `matter-homematic-<version>.tar.gz` file and click **Installieren / Install**.
3. The CCU will reboot on first install. After reboot, a *Matter Homematic* tile appears in the System Settings page.
4. Click the tile — the WebUI redirects to `http://<ccu-host>:8080/`, which is the bridge's configuration UI.
5. Edit the CCU host (defaults to `192.168.1.100`), pick which devices to expose, then restart the bridge from the WebUI.

Persistent state (config, Matter fabric, logs) lives at `/usr/local/etc/config/addons/matter-homematic/`. Firmware updates and addon upgrades preserve it; pairings with Matter ecosystems survive across upgrades.

### Test CCU on a Raspberry Pi

To iterate on the addon without touching your production CCU, see [`docs/test-ccu-setup.md`](docs/test-ccu-setup.md) for flashing RaspberryMatic onto a separate SD card.

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

## Troubleshooting

### Bridge not discovered

- Ensure your Matter controller and the bridge are on the same network
- Check that port 5540 (UDP) is not blocked by firewall
- Verify mDNS traffic (port 5353) is allowed

### CCU connection failed

- Verify the CCU IP address is correct
- Check that XML-RPC ports (2001, 2010) are accessible
- Ensure CCU firewall allows connections from the bridge

### Devices not appearing

- Check the device is supported (see Supported Devices)
- Verify the device is working in the CCU WebUI
- Check the logs for mapping errors

## Limitations

- Matter has a limited set of device types; some Homematic functionality may not be exposed
- Maximum ~150 devices per bridge (Matter specification limit)
- Some advanced Homematic features (programs, variables) are not supported

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests.

## License

MIT License - see LICENSE file for details.

## Acknowledgments

- [matter.js](https://github.com/project-chip/matter.js) - Matter protocol implementation
- [hap-homematic](https://github.com/thkl/hap-homematic) - Inspiration and reference
- [RaspberryMatic](https://github.com/jens-maus/RaspberryMatic) - CCU software

## Related Projects

- [hap-homematic](https://github.com/thkl/hap-homematic) - HomeKit bridge for Homematic
- [Matterbridge](https://github.com/Luligu/matterbridge) - Generic Matter bridge with plugins
- [Home Assistant](https://www.home-assistant.io/) - Smart home platform with Homematic & Matter support
