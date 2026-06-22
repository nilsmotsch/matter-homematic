/**
 * Matter-Homematic Bridge - Device Mapper
 *
 * Maps Homematic device types to Matter device types and handles value conversion
 */

import { getLogger } from '../utils/Logger';

// Matter device types from the Matter specification
export enum MatterDeviceType {
  OnOffLight = 'OnOffLight',
  DimmableLight = 'DimmableLight',
  ColorTemperatureLight = 'ColorTemperatureLight',
  OnOffPlugInUnit = 'OnOffPlugInUnit',
  DimmablePlugInUnit = 'DimmablePlugInUnit',
  WindowCovering = 'WindowCovering',
  Thermostat = 'Thermostat',
  TemperatureSensor = 'TemperatureSensor',
  HumiditySensor = 'HumiditySensor',
  ContactSensor = 'ContactSensor',
  OccupancySensor = 'OccupancySensor',
  LightSensor = 'LightSensor',
  GenericSwitch = 'GenericSwitch',
  Unknown = 'Unknown'
}

// Mapping configuration
interface DeviceTypeMapping {
  matterType: MatterDeviceType;
  clusters: string[];
  valueMap: Record<string, ValueMapping>;
}

interface ValueMapping {
  hmKey: string;
  matterAttribute: string;
  matterCluster: string;
  toMatter: (hmValue: any) => any;
  toHomematic: (matterValue: any) => any;
}

// Homematic channel type to Matter device type mapping
const CHANNEL_TYPE_MAPPINGS: Record<string, DeviceTypeMapping> = {
  // Switches
  'SWITCH': {
    matterType: MatterDeviceType.OnOffPlugInUnit,
    clusters: ['OnOff'],
    valueMap: {
      STATE: {
        hmKey: 'STATE',
        matterCluster: 'onOff',
        matterAttribute: 'onOff',
        toMatter: (v) => Boolean(v),
        toHomematic: (v) => Boolean(v)
      }
    }
  },
  'SWITCH_VIRTUAL_RECEIVER': {
    matterType: MatterDeviceType.OnOffPlugInUnit,
    clusters: ['OnOff'],
    valueMap: {
      STATE: {
        hmKey: 'STATE',
        matterCluster: 'onOff',
        matterAttribute: 'onOff',
        toMatter: (v) => Boolean(v),
        toHomematic: (v) => Boolean(v)
      }
    }
  },

  // Dimmers
  'DIMMER': {
    matterType: MatterDeviceType.DimmableLight,
    clusters: ['OnOff', 'LevelControl'],
    valueMap: {
      STATE: {
        hmKey: 'LEVEL',
        matterCluster: 'onOff',
        matterAttribute: 'onOff',
        toMatter: (v) => v > 0,
        toHomematic: (v) => v ? 1.0 : 0
      },
      LEVEL: {
        hmKey: 'LEVEL',
        matterCluster: 'levelControl',
        matterAttribute: 'currentLevel',
        toMatter: (v) => Math.round(v * 254),  // HM: 0.0-1.0 -> Matter: 0-254
        toHomematic: (v) => v / 254
      }
    }
  },
  'DIMMER_VIRTUAL_RECEIVER': {
    matterType: MatterDeviceType.DimmableLight,
    clusters: ['OnOff', 'LevelControl'],
    valueMap: {
      STATE: {
        hmKey: 'LEVEL',
        matterCluster: 'onOff',
        matterAttribute: 'onOff',
        toMatter: (v) => v > 0,
        toHomematic: (v) => v ? 1.0 : 0
      },
      LEVEL: {
        hmKey: 'LEVEL',
        matterCluster: 'levelControl',
        matterAttribute: 'currentLevel',
        toMatter: (v) => Math.round(v * 254),
        toHomematic: (v) => v / 254
      }
    }
  },

  // Blinds / Shutters.
  //
  // HM blind channels always expose LEVEL (lift). Venetian actuators (HmIP-FBL,
  // HmIP-BBL, some HmIPW-DRBL4 channels) additionally expose LEVEL_2 (slat
  // tilt). On roller/awning/screen-mode channels, LEVEL_2 is present in the
  // paramset but reported as the empty string "" — mapChannel strips LEVEL_2
  // from the runtime valueMappings in that case so Matter won't expose
  // tilt controls for a roller blind.
  'BLIND': {
    matterType: MatterDeviceType.WindowCovering,
    clusters: ['WindowCovering'],
    valueMap: {
      LEVEL: {
        hmKey: 'LEVEL',
        matterCluster: 'windowCovering',
        matterAttribute: 'currentPositionLiftPercent100ths',
        // HM: 0.0 (closed) - 1.0 (open)
        // Matter: 0 (open) - 10000 (closed) - inverted!
        toMatter: (v) => Math.round((1 - v) * 10000),
        toHomematic: (v) => 1 - (v / 10000)
      },
      LEVEL_2: {
        hmKey: 'LEVEL_2',
        matterCluster: 'windowCovering',
        matterAttribute: 'currentPositionTiltPercent100ths',
        toMatter: (v) => Math.round((1 - v) * 10000),
        toHomematic: (v) => 1 - (v / 10000)
      }
    }
  },
  'BLIND_VIRTUAL_RECEIVER': {
    matterType: MatterDeviceType.WindowCovering,
    clusters: ['WindowCovering'],
    valueMap: {
      LEVEL: {
        hmKey: 'LEVEL',
        matterCluster: 'windowCovering',
        matterAttribute: 'currentPositionLiftPercent100ths',
        toMatter: (v) => Math.round((1 - v) * 10000),
        toHomematic: (v) => 1 - (v / 10000)
      },
      LEVEL_2: {
        hmKey: 'LEVEL_2',
        matterCluster: 'windowCovering',
        matterAttribute: 'currentPositionTiltPercent100ths',
        toMatter: (v) => Math.round((1 - v) * 10000),
        toHomematic: (v) => 1 - (v / 10000)
      }
    }
  },
  'SHUTTER_VIRTUAL_RECEIVER': {
    matterType: MatterDeviceType.WindowCovering,
    clusters: ['WindowCovering'],
    valueMap: {
      LEVEL: {
        hmKey: 'LEVEL',
        matterCluster: 'windowCovering',
        matterAttribute: 'currentPositionLiftPercent100ths',
        toMatter: (v) => Math.round((1 - v) * 10000),
        toHomematic: (v) => 1 - (v / 10000)
      }
      // Shutters never tilt.
    }
  },

  // Thermostats
  'CLIMATECONTROL_RT_TRANSCEIVER': {
    matterType: MatterDeviceType.Thermostat,
    clusters: ['Thermostat'],
    valueMap: {
      ACTUAL_TEMPERATURE: {
        hmKey: 'ACTUAL_TEMPERATURE',
        matterCluster: 'thermostat',
        matterAttribute: 'localTemperature',
        toMatter: (v) => Math.round(v * 100),  // °C -> 0.01°C units
        toHomematic: (v) => v / 100
      },
      SET_TEMPERATURE: {
        hmKey: 'SET_TEMPERATURE',
        matterCluster: 'thermostat',
        matterAttribute: 'occupiedHeatingSetpoint',
        toMatter: (v) => Math.round(v * 100),
        toHomematic: (v) => v / 100
      }
    }
  },
  'HEATING_CLIMATECONTROL_TRANSCEIVER': {
    matterType: MatterDeviceType.Thermostat,
    clusters: ['Thermostat'],
    valueMap: {
      ACTUAL_TEMPERATURE: {
        hmKey: 'ACTUAL_TEMPERATURE',
        matterCluster: 'thermostat',
        matterAttribute: 'localTemperature',
        toMatter: (v) => Math.round(v * 100),
        toHomematic: (v) => v / 100
      },
      SET_POINT_TEMPERATURE: {
        hmKey: 'SET_POINT_TEMPERATURE',
        matterCluster: 'thermostat',
        matterAttribute: 'occupiedHeatingSetpoint',
        toMatter: (v) => Math.round(v * 100),
        toHomematic: (v) => v / 100
      }
    }
  },

  // Contact Sensors
  'SHUTTER_CONTACT': {
    matterType: MatterDeviceType.ContactSensor,
    clusters: ['BooleanState'],
    valueMap: {
      STATE: {
        hmKey: 'STATE',
        matterCluster: 'booleanState',
        matterAttribute: 'stateValue',
        // HM: true = open, Matter: false = contact (closed)
        toMatter: (v) => !v,
        toHomematic: (v) => !v
      }
    }
  },
  'SHUTTER_CONTACT_TRANSCEIVER': {
    matterType: MatterDeviceType.ContactSensor,
    clusters: ['BooleanState'],
    valueMap: {
      STATE: {
        hmKey: 'STATE',
        matterCluster: 'booleanState',
        matterAttribute: 'stateValue',
        toMatter: (v) => !v,
        toHomematic: (v) => !v
      }
    }
  },

  // Motion Sensors
  'MOTION_DETECTOR': {
    matterType: MatterDeviceType.OccupancySensor,
    clusters: ['OccupancySensing'],
    valueMap: {
      MOTION: {
        hmKey: 'MOTION',
        matterCluster: 'occupancySensing',
        matterAttribute: 'occupancy',
        // matter.js bitmap attributes reject plain numbers
        toMatter: (v) => ({ occupied: Boolean(v) }),
        toHomematic: (v) => Boolean(v?.occupied ?? v)
      }
    }
  },
  'MOTIONDETECTOR_TRANSCEIVER': {
    matterType: MatterDeviceType.OccupancySensor,
    clusters: ['OccupancySensing'],
    valueMap: {
      MOTION: {
        hmKey: 'MOTION',
        matterCluster: 'occupancySensing',
        matterAttribute: 'occupancy',
        toMatter: (v) => ({ occupied: Boolean(v) }),
        toHomematic: (v) => Boolean(v?.occupied ?? v)
      }
    }
  },
  // HmIP-SPI presence detector — reports PRESENCE_DETECTION_STATE instead
  // of MOTION and also exposes illumination (not bridged here).
  'PRESENCEDETECTOR_TRANSCEIVER': {
    matterType: MatterDeviceType.OccupancySensor,
    clusters: ['OccupancySensing'],
    valueMap: {
      PRESENCE: {
        hmKey: 'PRESENCE_DETECTION_STATE',
        matterCluster: 'occupancySensing',
        matterAttribute: 'occupancy',
        toMatter: (v) => ({ occupied: Boolean(v) }),
        toHomematic: (v) => Boolean(v?.occupied ?? v)
      }
    }
  },

  // Temperature Sensors
  'WEATHER': {
    matterType: MatterDeviceType.TemperatureSensor,
    clusters: ['TemperatureMeasurement'],
    valueMap: {
      TEMPERATURE: {
        hmKey: 'TEMPERATURE',
        matterCluster: 'temperatureMeasurement',
        matterAttribute: 'measuredValue',
        toMatter: (v) => Math.round(v * 100),
        toHomematic: (v) => v / 100
      }
    }
  },
  'WEATHER_TRANSMIT': {
    matterType: MatterDeviceType.TemperatureSensor,
    clusters: ['TemperatureMeasurement'],
    valueMap: {
      TEMPERATURE: {
        hmKey: 'TEMPERATURE',
        matterCluster: 'temperatureMeasurement',
        matterAttribute: 'measuredValue',
        toMatter: (v) => Math.round(v * 100),
        toHomematic: (v) => v / 100
      }
    }
  }

  // Door locks (KEYMATIC / HmIP-DLD) are intentionally not mapped — the current
  // attribute-write approach doesn't match Matter's command-driven DoorLock
  // model, so it was removed rather than ship something non-functional. See
  // README "Unsupported devices".
};

// Device type patterns for automatic detection
const DEVICE_TYPE_PATTERNS: Array<{ pattern: RegExp; channelType: string }> = [
  // HmIP devices
  { pattern: /^HmIP-PSM/, channelType: 'SWITCH_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-PS/, channelType: 'SWITCH_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-FSM/, channelType: 'SWITCH_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-BSM/, channelType: 'SWITCH_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-BDT/, channelType: 'DIMMER_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-PDT/, channelType: 'DIMMER_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-FDT/, channelType: 'DIMMER_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-BROLL/, channelType: 'BLIND_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-FROLL/, channelType: 'BLIND_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-BBL/, channelType: 'BLIND_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-FBL/, channelType: 'BLIND_VIRTUAL_RECEIVER' },
  { pattern: /^HmIP-eTRV/, channelType: 'HEATING_CLIMATECONTROL_TRANSCEIVER' },
  { pattern: /^HmIP-STHD/, channelType: 'HEATING_CLIMATECONTROL_TRANSCEIVER' },
  { pattern: /^HmIP-STH/, channelType: 'HEATING_CLIMATECONTROL_TRANSCEIVER' },
  { pattern: /^HmIP-SWDO/, channelType: 'SHUTTER_CONTACT_TRANSCEIVER' },
  { pattern: /^HmIP-SWDM/, channelType: 'SHUTTER_CONTACT_TRANSCEIVER' },
  { pattern: /^HmIP-SCI/, channelType: 'SHUTTER_CONTACT_TRANSCEIVER' },
  { pattern: /^HmIP-SMI/, channelType: 'MOTIONDETECTOR_TRANSCEIVER' },
  { pattern: /^HmIP-SMO/, channelType: 'MOTIONDETECTOR_TRANSCEIVER' },
  { pattern: /^HmIP-SPI/, channelType: 'MOTIONDETECTOR_TRANSCEIVER' },

  // Classic Homematic devices
  { pattern: /^HM-LC-Sw/, channelType: 'SWITCH' },
  { pattern: /^HM-LC-Dim/, channelType: 'DIMMER' },
  { pattern: /^HM-LC-Bl/, channelType: 'BLIND' },
  { pattern: /^HM-LC-Ja/, channelType: 'BLIND' },
  { pattern: /^HM-CC-RT-DN/, channelType: 'CLIMATECONTROL_RT_TRANSCEIVER' },
  { pattern: /^HM-TC-IT-WM-W-EU/, channelType: 'CLIMATECONTROL_RT_TRANSCEIVER' },
  { pattern: /^HM-Sec-SC/, channelType: 'SHUTTER_CONTACT' },
  { pattern: /^HM-Sec-RHS/, channelType: 'SHUTTER_CONTACT' },
  { pattern: /^HM-Sec-MDIR/, channelType: 'MOTION_DETECTOR' },
  { pattern: /^HM-Sen-MDIR/, channelType: 'MOTION_DETECTOR' },
  { pattern: /^HM-WDS/, channelType: 'WEATHER' }
];

export interface MappedDevice {
  hmAddress: string;
  hmChannelType: string;
  hmDeviceType: string;
  matterDeviceType: MatterDeviceType;
  clusters: string[];
  name: string;
  room?: string;
  valueMappings: Record<string, ValueMapping>;
  currentState: Record<string, any>;
  /** True only for WindowCovering devices where HM reports numeric LEVEL_2
   *  (venetian slats). MatterBridge uses this to decide whether to add the
   *  Tilt / PositionAwareTilt features to WindowCoveringServer. */
  hasTilt?: boolean;
}

export class DeviceMapper {
  private mappedDevices: Map<string, MappedDevice> = new Map();

  /**
   * Map a Homematic channel to a Matter device
   */
  mapChannel(
    address: string,
    channelType: string,
    deviceType: string,
    name: string,
    currentValues: Record<string, any>,
    room?: string,
    tiltOverride?: boolean
  ): MappedDevice | null {

    // Skip non-functional channel types. MAINTENANCE exists on nearly every
    // device (battery, RSSI, firmware) and must never be bridged — otherwise
    // the device type fallback matches the parent device pattern and creates
    // a bogus duplicate endpoint.
    if (channelType === 'MAINTENANCE' || channelType === 'MAINTENANCE_VIRTUAL_RECEIVER') {
      return null;
    }

    // Try to find mapping by channel type
    let mapping = CHANNEL_TYPE_MAPPINGS[channelType];

    // If not found, try to infer from device type — but only when the CCU
    // gave us no usable channel type. Otherwise we risk matching sub-channels
    // like CLIMATECONTROL_RT_RECEIVER (the thermostat's button panel) to the
    // same pattern as the main transceiver channel.
    if (!mapping && (!channelType || channelType === 'UNKNOWN')) {
      const inferredType = this.inferChannelType(deviceType);
      if (inferredType) {
        mapping = CHANNEL_TYPE_MAPPINGS[inferredType];
      }
    }

    if (!mapping) {
      getLogger().debug(`No mapping found for channel type: ${channelType} (device: ${deviceType})`);
      return null;
    }

    // Clone the valueMap — we may prune entries per-channel (e.g. strip
    // LEVEL_2 from roller-mode blinds) without mutating the static map.
    const valueMappings: Record<string, ValueMapping> = { ...mapping.valueMap };

    // Blind tilt detection.
    //
    //   - HmIPW-DRBL4 firmware returns LEVEL_2 as "" (empty string) when the
    //     channel is configured as roller/awning/screen. Strong signal.
    //   - HmIP-FBL is a pure venetian actuator and ALWAYS exposes LEVEL_2 as
    //     a number, even when the user physically wired a roller to it — the
    //     firmware can't distinguish the two cases. For those channels the
    //     caller can force a value via `tiltOverride` (true/false from config).
    //
    // Drop the LEVEL_2 mapping for lift-only channels so Matter controllers
    // don't show ghost tilt controls and we don't emit no-op setValue calls.
    const rawTilt = currentValues?.LEVEL_2;
    let hasTilt: boolean;
    if (tiltOverride !== undefined) {
      hasTilt = tiltOverride;
    } else if (rawTilt === '') {
      hasTilt = false;
    } else {
      hasTilt = typeof rawTilt === 'number';
    }
    if (!hasTilt && valueMappings.LEVEL_2) {
      delete valueMappings.LEVEL_2;
    }

    const mappedDevice: MappedDevice = {
      hmAddress: address,
      hmChannelType: channelType,
      hmDeviceType: deviceType,
      matterDeviceType: mapping.matterType,
      clusters: mapping.clusters,
      name: name || address,
      room: room,
      valueMappings,
      currentState: {},
      hasTilt: hasTilt ? true : undefined,
    };

    // Convert current values to Matter format. '' means "value unknown"
    // (HmIP transmitters report it while the actuator is moving) — leave
    // the attribute unseeded rather than coercing '' to a real position.
    for (const [, valueMapping] of Object.entries(valueMappings)) {
      const raw = currentValues?.[valueMapping.hmKey];
      if (raw !== undefined && raw !== '') {
        mappedDevice.currentState[valueMapping.matterAttribute] =
          valueMapping.toMatter(raw);
      }
    }

    this.mappedDevices.set(address, mappedDevice);
    return mappedDevice;
  }

  /**
   * Infer channel type from device type string
   */
  private inferChannelType(deviceType: string): string | null {
    for (const { pattern, channelType } of DEVICE_TYPE_PATTERNS) {
      if (pattern.test(deviceType)) {
        return channelType;
      }
    }
    return null;
  }

  /**
   * Convert Homematic value to Matter value
   */
  convertToMatter(address: string, hmKey: string, hmValue: any): { cluster: string; attribute: string; value: any } | null {
    const device = this.mappedDevices.get(address);
    if (!device) return null;

    // Find the value mapping for this key
    for (const [, valueMapping] of Object.entries(device.valueMappings)) {
      if (valueMapping.hmKey === hmKey) {
        return {
          cluster: valueMapping.matterCluster,
          attribute: valueMapping.matterAttribute,
          value: valueMapping.toMatter(hmValue)
        };
      }
    }

    return null;
  }

  /**
   * Convert Matter value to Homematic value
   */
  convertToHomematic(address: string, matterCluster: string, matterAttribute: string, matterValue: any): { key: string; value: any } | null {
    const device = this.mappedDevices.get(address);
    if (!device) return null;

    // Find the value mapping for this cluster/attribute
    for (const [, valueMapping] of Object.entries(device.valueMappings)) {
      if (valueMapping.matterCluster === matterCluster && valueMapping.matterAttribute === matterAttribute) {
        return {
          key: valueMapping.hmKey,
          value: valueMapping.toHomematic(matterValue)
        };
      }
    }

    return null;
  }

  /**
   * Get mapped device by address
   */
  getMappedDevice(address: string): MappedDevice | undefined {
    return this.mappedDevices.get(address);
  }

  /**
   * Get all mapped devices
   */
  getAllMappedDevices(): Map<string, MappedDevice> {
    return this.mappedDevices;
  }

  /**
   * Get devices filtered by Matter device type
   */
  getDevicesByType(matterType: MatterDeviceType): MappedDevice[] {
    return Array.from(this.mappedDevices.values())
      .filter(device => device.matterDeviceType === matterType);
  }

  /**
   * Get supported Homematic channel types
   */
  getSupportedChannelTypes(): string[] {
    return Object.keys(CHANNEL_TYPE_MAPPINGS);
  }
}
