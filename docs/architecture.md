# Matter-Homematic Bridge - Technical Architecture

## Overview

This document outlines the architecture for a Matter bridge that exposes Homematic devices from a CCU3/RaspberryMatic system to Matter-compatible smart home ecosystems (Apple Home, Google Home, Amazon Alexa, Samsung SmartThings).

The design follows a similar pattern to [hap-homematic](https://github.com/thkl/hap-homematic), but uses the Matter protocol instead of HomeKit Accessory Protocol (HAP).

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Matter Ecosystem                              │
│  (Apple Home / Google Home / Amazon Alexa / Samsung SmartThings)    │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ Matter Protocol (mDNS/UDP)
                                   │ Port 5540+
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Matter-Homematic Bridge                          │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │  Matter Server  │  │  Device Manager  │  │  CCU Connector    │  │
│  │  (matter.js)    │◄─┤  & Mapper        │◄─┤  (XML-RPC)        │  │
│  └─────────────────┘  └──────────────────┘  └───────────────────┘  │
│           │                    │                      │             │
│           │           ┌────────┴────────┐            │             │
│           │           │  State Cache    │            │             │
│           │           │  & Event Queue  │            │             │
│           │           └─────────────────┘            │             │
│           │                                          │             │
│  ┌────────┴────────────────────────────────────────┐│             │
│  │              Configuration & Storage             ││             │
│  │         (JSON config + persistent data)          ││             │
│  └──────────────────────────────────────────────────┘│             │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ XML-RPC (Ports 2001, 2010, 9292)
                                   │ + Callback Server (Port 9875)
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      CCU3 / RaspberryMatic                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   rfd        │  │  HmIP-RF     │  │  Virtual Devices /       │  │
│  │  (BidCos-RF) │  │  (HmIP)      │  │  Programs / Variables    │  │
│  │  Port 2001   │  │  Port 2010   │  │  Port 9292               │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ Homematic RF (868 MHz)
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Homematic Devices                               │
│   Switches, Dimmers, Blinds, Thermostats, Sensors, Door Locks...   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. CCU Connector (XML-RPC Client)

Responsible for communication with the CCU using the standard Homematic XML-RPC interface.

#### Interfaces to Connect

| Interface    | Port  | TLS Port | Purpose                        |
|-------------|-------|----------|--------------------------------|
| BidCos-RF   | 2001  | 42001    | Classic Homematic wireless     |
| HmIP-RF     | 2010  | 42010    | Homematic IP wireless          |
| BidCos-Wired| 2000  | 42000    | Homematic wired devices        |
| Groups      | 9292  | 49292    | Virtual groups & thermostats   |
| CUxD        | 8701  | -        | CUxD virtual devices (optional)|

#### Key XML-RPC Methods

```javascript
// Device Discovery
rpc.call('listDevices')           // Get all devices
rpc.call('getDeviceDescription', [address])
rpc.call('getParamsetDescription', [address, 'VALUES'])

// State Operations  
rpc.call('getValue', [address, key])
rpc.call('setValue', [address, key, value])
rpc.call('getParamset', [address, 'VALUES'])

// Event Registration
rpc.call('init', [callbackUrl, interfaceId])  // Register for events
rpc.call('ping', [callbackId])                 // Keep-alive
```

#### Callback Server

The bridge must run an XML-RPC server to receive state change events from the CCU:

```javascript
// CCU calls these methods on state changes
'event': (interfaceId, address, key, value) => { ... }
'newDevices': (interfaceId, devices) => { ... }
'deleteDevices': (interfaceId, addresses) => { ... }
```

### 2. Device Manager & Mapper

Maps Homematic device types and channels to Matter device types and clusters.

#### Matter Device Type Mapping

| Homematic Type | Channel | Matter Device Type | Matter Clusters |
|----------------|---------|-------------------|-----------------|
| HM-LC-Sw1-* | SWITCH | OnOffPlugInUnit | OnOff |
| HM-LC-Dim1-* | DIMMER | DimmableLight | OnOff, LevelControl |
| HmIP-PSM | SWITCH_VIRTUAL_RECEIVER | OnOffPlugInUnit | OnOff, ElectricalMeasurement |
| HM-LC-Bl1-* | BLIND | WindowCovering | WindowCovering |
| HmIP-BROLL | BLIND_VIRTUAL_RECEIVER | WindowCovering | WindowCovering |
| HM-CC-RT-DN | CLIMATECONTROL_RT_TRANSCEIVER | Thermostat | Thermostat |
| HmIP-eTRV-* | HEATING_CLIMATECONTROL_TRANSCEIVER | Thermostat | Thermostat |
| HM-Sec-SC-* | SHUTTER_CONTACT | ContactSensor | BooleanState |
| HmIP-SWDO | SHUTTER_CONTACT | ContactSensor | BooleanState |
| HM-Sec-MDIR | MOTION_DETECTOR | OccupancySensor | OccupancySensing |
| HmIP-SMI | MOTION_DETECTOR | OccupancySensor | OccupancySensing |
| HM-WDS* | WEATHER | TemperatureSensor | TemperatureMeasurement |
| HmIP-STH | HEATING_CLIMATECONTROL_TRANSCEIVER | TemperatureSensor | TemperatureMeasurement, RelativeHumidityMeasurement |
| HM-Sec-Key | KEYMATIC | DoorLock | DoorLock |
| HmIP-DLD | DOOR_LOCK_STATE_TRANSMITTER | DoorLock | DoorLock |

#### Channel-to-Endpoint Mapping Strategy

```javascript
// Each Homematic channel becomes a Matter endpoint
// Example: HM-LC-Sw2-FM (2-channel switch)
// - BidCos-RF.LEQ1234567:1 → Endpoint 1 (OnOffPlugInUnit)
// - BidCos-RF.LEQ1234567:2 → Endpoint 2 (OnOffPlugInUnit)

class DeviceMapper {
  mapChannel(hmChannel) {
    const deviceType = this.getDeviceType(hmChannel.type);
    const clusters = this.getClusters(hmChannel.type);
    
    return {
      endpointId: this.allocateEndpointId(),
      deviceType: deviceType,
      clusters: clusters,
      hmAddress: hmChannel.address,
      hmInterface: hmChannel.interface
    };
  }
}
```

### 3. Matter Server (using matter.js)

The core Matter implementation using the official matter.js library.

#### Bridge Device Structure

```javascript
import { 
  ServerNode, 
  Endpoint,
  AggregatorEndpoint 
} from "@matter.js/main";
import { 
  BridgedNodeEndpoint,
  OnOffPlugInUnitDevice,
  DimmableLightDevice,
  WindowCoveringDevice,
  ThermostatDevice,
  ContactSensorDevice,
  OccupancySensorDevice
} from "@matter.js/main/devices";

// Create the bridge as an Aggregator
const bridge = await ServerNode.create({
  id: "matter-homematic-bridge",
  network: {
    port: 5540
  },
  commissioning: {
    passcode: 20242024,
    discriminator: 3840
  },
  productDescription: {
    name: "Matter-Homematic Bridge",
    vendorId: 0xFFF1,      // Test vendor ID
    productId: 0x8001
  },
  basicInformation: {
    vendorName: "Homematic Community",
    productName: "Matter-Homematic",
    serialNumber: "MHB-001"
  }
});

// Add aggregator endpoint for bridged devices
const aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
await bridge.add(aggregator);
```

#### Adding Bridged Devices

```javascript
// Example: Add a Homematic switch as bridged device
async function addBridgedSwitch(hmChannel, aggregator) {
  const device = new Endpoint(
    OnOffPlugInUnitDevice.with(BridgedNodeEndpoint),
    {
      id: `hm-${hmChannel.address.replace(/[:.]/g, '-')}`,
      bridgedDeviceBasicInformation: {
        vendorName: "eQ-3",
        productName: hmChannel.type,
        nodeLabel: hmChannel.name,
        serialNumber: hmChannel.address,
        reachable: true
      },
      onOff: {
        onOff: hmChannel.state.STATE || false
      }
    }
  );
  
  // Handle commands from Matter controllers
  device.events.onOff.onOff$Changed.on(async (value) => {
    await ccuConnector.setValue(hmChannel.address, 'STATE', value);
  });
  
  await aggregator.add(device);
  return device;
}
```

### 4. State Synchronization

Bidirectional state sync between CCU and Matter.

```javascript
class StateSynchronizer {
  constructor(ccuConnector, matterBridge, deviceMap) {
    this.ccu = ccuConnector;
    this.bridge = matterBridge;
    this.devices = deviceMap;
  }
  
  // CCU → Matter: Handle incoming CCU events
  handleCcuEvent(interfaceId, address, key, value) {
    const device = this.devices.get(address);
    if (!device) return;
    
    switch (key) {
      case 'STATE':
        device.matterEndpoint.set({ onOff: { onOff: value } });
        break;
      case 'LEVEL':
        // Homematic: 0.0-1.0, Matter: 0-254
        const matterLevel = Math.round(value * 254);
        device.matterEndpoint.set({ 
          levelControl: { currentLevel: matterLevel } 
        });
        break;
      case 'ACTUAL_TEMPERATURE':
        // Homematic: °C, Matter: 0.01°C units
        const matterTemp = Math.round(value * 100);
        device.matterEndpoint.set({
          thermostat: { localTemperature: matterTemp }
        });
        break;
      // ... more mappings
    }
  }
  
  // Matter → CCU: Handle Matter commands
  async handleMatterCommand(device, cluster, attribute, value) {
    const hmAddress = device.hmAddress;
    
    switch (cluster) {
      case 'onOff':
        await this.ccu.setValue(hmAddress, 'STATE', value);
        break;
      case 'levelControl':
        // Matter: 0-254, Homematic: 0.0-1.0
        const hmLevel = value / 254;
        await this.ccu.setValue(hmAddress, 'LEVEL', hmLevel);
        break;
      case 'windowCovering':
        // Matter: 0-10000 (0.01%), Homematic: 0.0-1.0
        const hmPosition = value / 10000;
        await this.ccu.setValue(hmAddress, 'LEVEL', hmPosition);
        break;
      // ... more mappings
    }
  }
}
```

---

## Configuration

### Configuration File Structure

```json
{
  "bridge": {
    "name": "Matter-Homematic",
    "port": 5540,
    "passcode": 20242024,
    "discriminator": 3840
  },
  "ccu": {
    "host": "192.168.1.100",
    "port": 80,
    "username": "",
    "password": "",
    "useTLS": false,
    "interfaces": {
      "BidCos-RF": { "enabled": true, "port": 2001 },
      "HmIP-RF": { "enabled": true, "port": 2010 },
      "VirtualDevices": { "enabled": true, "port": 9292 },
      "CUxD": { "enabled": false, "port": 8701 }
    }
  },
  "devices": {
    "filter": {
      "rooms": ["Wohnzimmer", "Schlafzimmer"],
      "functions": ["Licht", "Heizung"],
      "exclude": ["BidCos-RF.LEQ1234567:0"]
    },
    "customMappings": [
      {
        "address": "BidCos-RF.LEQ1234567:1",
        "deviceType": "DimmableLight",
        "name": "Deckenleuchte"
      }
    ]
  },
  "advanced": {
    "callbackPort": 9875,
    "reconnectInterval": 30,
    "stateUpdateInterval": 60
  }
}
```

### Device Filtering Options

Similar to hap-homematic, devices can be filtered by:
- **Rooms** (Räume) defined in CCU
- **Functions** (Gewerke) defined in CCU  
- **Explicit include/exclude lists**

---

## Implementation Details

### Project Structure

```
matter-homematic/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Main entry point
│   ├── bridge/
│   │   ├── MatterBridge.ts         # Matter server wrapper
│   │   └── EndpointFactory.ts      # Creates Matter endpoints
│   ├── ccu/
│   │   ├── CcuConnector.ts         # XML-RPC client
│   │   ├── CallbackServer.ts       # XML-RPC server for events
│   │   ├── DeviceList.ts           # Device discovery
│   │   └── interfaces/
│   │       ├── BidCosRF.ts
│   │       ├── HmIPRF.ts
│   │       └── VirtualDevices.ts
│   ├── devices/
│   │   ├── DeviceMapper.ts         # HM → Matter mapping
│   │   ├── BaseDevice.ts           # Abstract device class
│   │   └── types/
│   │       ├── SwitchDevice.ts
│   │       ├── DimmerDevice.ts
│   │       ├── BlindDevice.ts
│   │       ├── ThermostatDevice.ts
│   │       ├── ContactSensorDevice.ts
│   │       ├── MotionSensorDevice.ts
│   │       └── DoorLockDevice.ts
│   ├── state/
│   │   ├── StateCache.ts           # Local state cache
│   │   └── StateSynchronizer.ts    # Bidirectional sync
│   ├── config/
│   │   ├── ConfigLoader.ts
│   │   └── ConfigValidator.ts
│   └── utils/
│       ├── Logger.ts
│       └── ValueConverter.ts
├── addon/                          # CCU Addon packaging
│   ├── addon_installer/
│   │   ├── update_script
│   │   └── rc.d/
│   ├── etc/
│   │   └── config_templates/
│   └── build.sh
└── test/
    └── ...
```

### Key Dependencies

```json
{
  "dependencies": {
    "@matter.js/main": "^0.12.0",
    "@matter.js/nodejs": "^0.12.0",
    "xmlrpc": "^1.3.2",
    "winston": "^3.11.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0"
  }
}
```

---

## CCU Addon Packaging

To run directly on CCU3/RaspberryMatic (like hap-homematic):

### Addon Structure

```
matter-homematic-addon.tar.gz
├── addon/
│   ├── update_script              # Installation script
│   ├── rc.d/
│   │   └── matter-homematic       # Init script
│   └── VERSION
├── node_modules/                  # Pre-bundled dependencies
├── dist/                          # Compiled JavaScript
├── www/                           # Web UI for configuration
│   ├── index.html
│   ├── api/
│   └── assets/
└── etc/
    └── matter-homematic.json.template
```

### Init Script (rc.d/matter-homematic)

```bash
#!/bin/sh

ADDON_DIR=/usr/local/addons/matter-homematic
CONFIG_DIR=/usr/local/etc/config/addons/matter-homematic
PIDFILE=/var/run/matter-homematic.pid
NODE=/usr/local/addons/matter-homematic/node/bin/node

case "$1" in
  start)
    echo "Starting Matter-Homematic Bridge..."
    cd $ADDON_DIR
    $NODE dist/index.js --config $CONFIG_DIR/config.json &
    echo $! > $PIDFILE
    ;;
  stop)
    echo "Stopping Matter-Homematic Bridge..."
    kill $(cat $PIDFILE) 2>/dev/null
    rm -f $PIDFILE
    ;;
  restart)
    $0 stop
    sleep 2
    $0 start
    ;;
  info)
    echo "Info: <b>Matter-Homematic Bridge</b>"
    echo "Name: Matter-Homematic"
    echo "Version: 1.0.0"
    echo "Config-Url: /addons/matter-homematic/www/index.html"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|info}"
    exit 1
    ;;
esac

exit 0
```

---

## Value Conversion Reference

### Level/Brightness

```javascript
// Homematic LEVEL: 0.0 - 1.0 (float)
// Matter LevelControl: 0 - 254 (uint8)

function hmToMatterLevel(hmValue) {
  return Math.round(hmValue * 254);
}

function matterToHmLevel(matterValue) {
  return matterValue / 254;
}
```

### Temperature

```javascript
// Homematic: Celsius (float, e.g., 21.5)
// Matter: 0.01°C units (int16, e.g., 2150)

function hmToMatterTemp(celsius) {
  return Math.round(celsius * 100);
}

function matterToHmTemp(matterTemp) {
  return matterTemp / 100;
}
```

### Window Covering Position

```javascript
// Homematic LEVEL: 0.0 (closed) - 1.0 (open)
// Matter: 0 (open) - 10000 (closed) in 0.01% units
// Note: Inverted logic!

function hmToMatterPosition(hmLevel) {
  return Math.round((1 - hmLevel) * 10000);
}

function matterToHmPosition(matterPos) {
  return 1 - (matterPos / 10000);
}
```

### Thermostat Modes

```javascript
// Homematic CONTROL_MODE: 0=AUTO, 1=MANUAL, 2=PARTY, 3=BOOST
// Matter SystemMode: 0=Off, 1=Auto, 3=Cool, 4=Heat

const HM_TO_MATTER_MODE = {
  0: 1,  // AUTO → Auto
  1: 4,  // MANUAL → Heat
  2: 1,  // PARTY → Auto
  3: 4   // BOOST → Heat (with setpoint override)
};
```

---

## Network & Port Requirements

### Ports Used by Bridge

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 5540+ | UDP | Bidirectional | Matter communication |
| 5353 | UDP | Bidirectional | mDNS discovery |
| 9875 | TCP | CCU → Bridge | XML-RPC callbacks |
| 8080 | TCP | Inbound | Web configuration UI |

### Firewall Configuration

If running on CCU3, ensure these ports are accessible:
- Matter: 5540-5560/udp (for multiple bridge instances)
- mDNS: 5353/udp
- Web UI: 8080/tcp (or configured port)

---

## Commissioning Flow

```
1. User starts bridge
   └── Bridge initializes Matter server
   └── Bridge connects to CCU via XML-RPC
   └── Bridge discovers devices and creates Matter endpoints

2. Bridge advertises via mDNS
   └── Service type: _matter._tcp
   └── Includes discriminator and pairing hint

3. User opens Matter controller (Apple Home, Google Home, etc.)
   └── Controller discovers bridge via mDNS
   └── User scans QR code or enters pairing code

4. PASE (Passcode Authenticated Session Establishment)
   └── Controller and bridge establish secure session
   └── Uses configured passcode (default: 20242024)

5. CASE (Certificate Authenticated Session Establishment)
   └── Controller provisions operational certificates
   └── Bridge joins controller's fabric

6. Subscription Setup
   └── Controller subscribes to device attributes
   └── Bridge reports current state of all devices

7. Operational
   └── Controller can now control devices
   └── State changes flow bidirectionally
```

---

## Limitations & Considerations

### Matter Protocol Limitations

1. **Device Types**: Matter has a limited set of device types compared to Homematic
   - Some Homematic devices may need to be represented as generic switches
   - Complex devices like weather stations may lose some functionality

2. **Attributes**: Not all Homematic values map to Matter attributes
   - Battery levels may not be exposed
   - Some sensor values have no Matter equivalent

3. **Latency**: Additional hop through bridge adds ~50-100ms latency

4. **Fabric Limits**: Matter devices can join max 5 fabrics
   - Bridge counts as one "device" regarding fabric limits

### Implementation Considerations

1. **State Consistency**: CCU is source of truth
   - Always read back state after writes
   - Handle temporary disconnections gracefully

2. **Large Installations**: Many devices = many endpoints
   - Matter bridge specification allows up to 150 endpoints
   - Consider multiple bridge instances for large setups

3. **Updates**: CCU firmware updates may require bridge updates
   - XML-RPC interface is stable but not guaranteed

---

## Development Roadmap

### Phase 1: Core Functionality
- [ ] Basic XML-RPC connection to CCU
- [ ] Switch device support (on/off)
- [ ] Matter bridge with single device
- [ ] Commissioning with Apple Home

### Phase 2: Device Types
- [ ] Dimmers (LevelControl)
- [ ] Blinds/Shutters (WindowCovering)
- [ ] Contact sensors (BooleanState)
- [ ] Motion sensors (OccupancySensing)

### Phase 3: Advanced Devices
- [ ] Thermostats
- [ ] Door locks
- [ ] Energy measurement

### Phase 4: Polish
- [ ] Web configuration UI
- [ ] CCU addon packaging
- [ ] Multi-controller support (Google, Amazon)
- [ ] Documentation

---

## References

- [matter.js GitHub](https://github.com/project-chip/matter.js)
- [Matter Specification](https://csa-iot.org/developer-resource/specifications-download-request/)
- [hap-homematic (reference implementation for HomeKit)](https://github.com/thkl/hap-homematic)
- [Homematic XML-RPC Documentation](https://www.eq-3.de/Downloads/Software/HM-XmlRpc-API.pdf)
- [RaspberryMatic](https://github.com/jens-maus/RaspberryMatic)
