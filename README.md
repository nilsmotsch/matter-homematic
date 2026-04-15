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

For easy installation directly on your CCU3/RaspberryMatic:

1. Download the latest addon release from the releases page
2. Go to CCU WebUI → Settings → System Settings → Additional Software
3. Install the addon package
4. Access configuration at http://your-ccu:8080

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
