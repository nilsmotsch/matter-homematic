/**
 * Matter-Homematic Bridge - Main Bridge Implementation
 * 
 * Creates a Matter bridge that exposes Homematic devices
 */

import {
  ServerNode,
  Endpoint,
  Environment,
  StorageService,
  Logger,
} from "@matter/main";

import {
  AggregatorEndpoint,
} from "@matter/main/endpoints";

import {
  OnOffPlugInUnitDevice,
  DimmableLightDevice,
  WindowCoveringDevice,
  ThermostatDevice,
  ContactSensorDevice,
  OccupancySensorDevice,
  TemperatureSensorDevice,
  DoorLockDevice
} from "@matter/main/devices";

import {
  BridgedDeviceBasicInformationServer,
  WindowCoveringServer,
  ThermostatServer,
  OccupancySensingServer,
} from "@matter/main/behaviors";
import { VendorId, QrCode } from "@matter/main/types";
import { CcuConnector, HmChannel } from '../ccu/CcuConnector';
import { DeviceMapper, MappedDevice, MatterDeviceType } from '../devices/DeviceMapper';
import { getLogger } from '../utils/Logger';

interface BridgeConfig {
  name: string;
  port: number;
  passcode: number;
  discriminator: number;
  vendorId: number;
  productId: number;
  storagePath: string;
}

interface FullConfig {
  bridge: BridgeConfig;
  ccu: {
    host: string;
    // Standard CCU interfaces (BidCos-RF 2001, HmIP-RF 2010, VirtualDevices
    // 9292) plus any additional ipc interfaces registered on the CCU, e.g.
    // ShellyHM (2121) from the shelly-homematic addon.
    interfaces: Record<string, { enabled: boolean; port: number } | undefined>;
    callbackPort: number;
    callbackHost?: string;
    regaPort?: number;
    user?: string;
    password?: string;
  };
  devices?: {
    defaultExposed?: boolean;
    exposed?: Record<string, boolean>;
    /** Per-address override for WindowCovering tilt. true = force venetian
     *  (expose tilt), false = force lift-only (hide tilt). Absent = auto-
     *  detect from LEVEL_2 value (works on HmIPW-DRBL4 but not HmIP-FBL,
     *  which always reports LEVEL_2 numeric regardless of physical install). */
    tilt?: Record<string, boolean>;
  };
}

export class MatterHomematicBridge {
  private config: FullConfig;
  private ccuConnector: CcuConnector;
  private deviceMapper: DeviceMapper;
  private serverNode?: ServerNode;
  private aggregator?: Endpoint;
  private matterEndpoints: Map<string, Endpoint> = new Map();
  /** *_TRANSMITTER state channel → the mapped *_VIRTUAL_RECEIVER addresses
   *  whose Matter endpoints mirror it (see findStateSourceChannel). */
  private stateSources: Map<string, string[]> = new Map();
  /** HM value keys whose authoritative copy lives on the transmitter. */
  private static readonly MIRRORED_KEYS = ['LEVEL', 'LEVEL_2', 'STATE'];
  /** Receiver addresses that have a transmitter state source. Their own
   *  MIRRORED_KEYS events are stale command echoes and must be ignored. */
  private mirroredReceivers: Set<string> = new Set();
  private resyncTimer?: NodeJS.Timeout;

  constructor(config: FullConfig) {
    this.config = config;
    this.ccuConnector = new CcuConnector(config.ccu);
    this.deviceMapper = new DeviceMapper();

    // matter.js logs at debug by default, which floods the log file and
    // drowns out the bridge's own entries. Must be set before any matter.js
    // activity — the Environment applies its logging vars only at
    // construction, so `vars.set("log.level", …)` later has no effect.
    Logger.level = "info";
    // matter.js always emits ANSI colors, even when stdout is a file (the
    // daemonized addon redirects it into the log).
    Logger.format = process.stdout.isTTY ? "ansi" : "plain";
  }

  /**
   * Start the bridge
   */
  async start(): Promise<void> {
    getLogger().info('Starting Matter-Homematic Bridge...');

    // Connect to CCU
    await this.ccuConnector.connect();
    
    // Discover devices
    const channels = await this.ccuConnector.discoverDevices();
    getLogger().info(`Discovered ${channels.size} channels`);

    // Map devices
    const devices = this.ccuConnector.getDevices();
    let mappedCount = 0;

    for (const [address, channel] of channels) {
      // Get parent device type
      const parentAddress = address.split(':')[0];
      const parentDevice = devices.get(parentAddress);
      const deviceType = parentDevice?.type || 'Unknown';

      // HmIP actuators report physical state on the channel group's
      // *_TRANSMITTER channel; the *_VIRTUAL_RECEIVER we map only echoes
      // commands sent through it (so it goes stale when the device is
      // operated from the CCU UI, a wall button, or another receiver).
      // Seed initial state from the transmitter and remember it as the
      // live state source for events.
      let values = channel.paramsets.VALUES || {};
      const stateSource = this.findStateSourceChannel(address, channel.type, channels);
      if (stateSource) {
        // Each HmIP actuator output is one *_TRANSMITTER plus three
        // *_VIRTUAL_RECEIVER channels — the extra two receivers exist only
        // for direct device peering links and drive the same physical
        // output. Expose just the first receiver of each transmitter group
        // so one physical switch/dimmer/blind is a single Matter device.
        if ((this.stateSources.get(stateSource)?.length ?? 0) > 0) {
          continue;
        }
        const txValues = channels.get(stateSource)?.paramsets.VALUES || {};
        values = { ...values };
        for (const key of MatterHomematicBridge.MIRRORED_KEYS) {
          // '' = transmitter mid-movement ("value unknown") — keep the
          // receiver's value so tilt auto-detect and position seeding
          // aren't poisoned by a blind that happens to be moving now.
          if (txValues[key] !== undefined && txValues[key] !== '') {
            values[key] = txValues[key];
          }
        }
        const targets = this.stateSources.get(stateSource) ?? [];
        targets.push(address);
        this.stateSources.set(stateSource, targets);
        this.mirroredReceivers.add(address);
      }

      const mapped = this.deviceMapper.mapChannel(
        address,
        channel.type,
        deviceType,
        channel.name,
        values,
        channel.room,
        this.config.devices?.tilt?.[address]
      );

      if (mapped) {
        mappedCount++;
      }
    }

    getLogger().info(`Mapped ${mappedCount} devices to Matter`);

    // Create Matter server
    await this.createMatterServer();

    // Add bridged devices
    await this.addBridgedDevices();

    // Setup event handlers
    this.setupEventHandlers();
    this.startStateResync();

    // Start the server
    await this.serverNode!.start();

    getLogger().info('Matter-Homematic Bridge started successfully!');
    this.printPairingInfo();
  }

  /**
   * Create the Matter server node
   */
  private async createMatterServer(): Promise<void> {
    const environment = Environment.default;

    // Point matter.js storage at the configured path. Without this it
    // defaults to $HOME/.matter, which doesn't exist for the CCU daemon
    // (and silently ignores config.bridge.storagePath).
    if (this.config.bridge.storagePath) {
      environment.vars.set("storage.path", this.config.bridge.storagePath);
    }

    const storageService = environment.get(StorageService);

    this.serverNode = await ServerNode.create({
      id: "matter-homematic",

      // Network configuration
      network: {
        port: this.config.bridge.port
      },

      // Commissioning configuration
      commissioning: {
        passcode: this.config.bridge.passcode,
        discriminator: this.config.bridge.discriminator
      },

      // Product information
      productDescription: {
        name: this.config.bridge.name,
        vendorId: VendorId(this.config.bridge.vendorId),
        productId: this.config.bridge.productId
      },

      // Basic information cluster
      basicInformation: {
        vendorName: "Homematic Community",
        vendorId: VendorId(this.config.bridge.vendorId),
        productName: "Matter-Homematic Bridge",
        productId: this.config.bridge.productId,
        nodeLabel: this.config.bridge.name,
        serialNumber: `MHB-${Date.now()}`,
        hardwareVersion: 1,
        hardwareVersionString: "1.0",
        softwareVersion: 1,
        softwareVersionString: "1.0.0"
      }
    });

    // Create aggregator endpoint for bridged devices
    this.aggregator = new Endpoint(AggregatorEndpoint, { id: "bridge" });
    await this.serverNode.add(this.aggregator);

    getLogger().info('Matter server created');
  }

  /**
   * Decide whether a given device should be exposed over Matter.
   * Per-device toggle wins; falls back to defaultExposed (default: false —
   * users opt in to each device they want visible in Matter).
   */
  private isDeviceExposed(address: string): boolean {
    const cfg = this.config.devices;
    if (cfg?.exposed && Object.prototype.hasOwnProperty.call(cfg.exposed, address)) {
      return !!cfg.exposed[address];
    }
    return cfg?.defaultExposed ?? false;
  }

  /**
   * Add all mapped devices as bridged devices
   */
  private async addBridgedDevices(): Promise<void> {
    const mappedDevices = this.deviceMapper.getAllMappedDevices();
    let skipped = 0;

    for (const [address, device] of mappedDevices) {
      if (!this.isDeviceExposed(address)) {
        skipped++;
        getLogger().debug(`Skipping ${address} (${device.name}) — not exposed`);
        continue;
      }

      let endpoint: Endpoint | null = null;
      let added = false;
      try {
        endpoint = await this.createMatterEndpoint(device);
        if (!endpoint) continue;
        await this.aggregator!.add(endpoint);
        added = true;
        this.matterEndpoints.set(address, endpoint);
        getLogger().info(`Added bridged device: ${device.name} (${device.matterDeviceType})`);
      } catch (err) {
        getLogger().error(`Failed to add device ${address}:`, err);
        // Only close endpoints that were successfully added; calling close()
        // on a half-constructed endpoint re-throws "endpoint storage
        // inaccessible" as an unhandled rejection.
        if (added && endpoint) {
          try { await endpoint.close(); } catch { /* ignore */ }
        }
      }
    }

    getLogger().info(`Added ${this.matterEndpoints.size} bridged devices (${skipped} not exposed)`);
  }

  /**
   * Create a Matter endpoint for a mapped device
   */
  private async createMatterEndpoint(device: MappedDevice): Promise<Endpoint | null> {
    const id = `hm-${device.hmAddress.replace(/[:.]/g, '-')}`;
    
    // Common bridged device information
    const bridgedInfo = {
      vendorName: "eQ-3",
      productName: device.hmDeviceType,
      nodeLabel: device.name,
      serialNumber: device.hmAddress,
      reachable: true
    };

    switch (device.matterDeviceType) {
      case MatterDeviceType.OnOffPlugInUnit:
        return this.createOnOffDevice(id, device, bridgedInfo);

      case MatterDeviceType.DimmableLight:
        return this.createDimmableDevice(id, device, bridgedInfo);

      case MatterDeviceType.WindowCovering:
        return this.createWindowCoveringDevice(id, device, bridgedInfo);

      case MatterDeviceType.Thermostat:
        return this.createThermostatDevice(id, device, bridgedInfo);

      case MatterDeviceType.ContactSensor:
        return this.createContactSensorDevice(id, device, bridgedInfo);

      case MatterDeviceType.OccupancySensor:
        return this.createOccupancySensorDevice(id, device, bridgedInfo);

      case MatterDeviceType.TemperatureSensor:
        return this.createTemperatureSensorDevice(id, device, bridgedInfo);

      case MatterDeviceType.DoorLock:
        return this.createDoorLockDevice(id, device, bridgedInfo);

      default:
        getLogger().info(`Unsupported Matter device type: ${device.matterDeviceType}`);
        return null;
    }
  }

  /**
   * Create OnOff device (switch/plug)
   */
  private createOnOffDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    const endpoint = new Endpoint(
      OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        onOff: {
          onOff: device.currentState.onOff || false
        }
      }
    );

    // Handle state changes from Matter
    endpoint.events.onOff.onOff$Changed.on(async (value) => {
      // Echo from a CCU-originated update — don't bounce it back.
      if (device.currentState.onOff === value) return;
      getLogger().info(`Matter -> CCU: ${device.hmAddress} STATE = ${value}`);
      const hmValue = this.deviceMapper.convertToHomematic(
        device.hmAddress, 'onOff', 'onOff', value
      );
      if (hmValue) {
        await this.ccuConnector.setValue(device.hmAddress, hmValue.key, hmValue.value);
      }
    });

    return endpoint;
  }

  /**
   * Create Dimmable device (dimmer/light)
   */
  private createDimmableDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    // Matter LevelControl requires currentLevel in [minLevel, maxLevel].
    // Raw HM LEVEL=0 maps to Matter 0 which is below minLevel=1, so clamp.
    const initialLevel = device.currentState.currentLevel || 0;
    const endpoint = new Endpoint(
      DimmableLightDevice.with(BridgedDeviceBasicInformationServer),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        onOff: {
          onOff: initialLevel > 0
        },
        levelControl: {
          currentLevel: Math.max(1, Math.min(254, initialLevel || 1)),
          minLevel: 1,
          maxLevel: 254
        }
      }
    );

    // Handle on/off from Matter
    endpoint.events.onOff.onOff$Changed.on(async (value) => {
      getLogger().info(`Matter -> CCU: ${device.hmAddress} ON/OFF = ${value}`);
      const hmValue = this.deviceMapper.convertToHomematic(
        device.hmAddress, 'onOff', 'onOff', value
      );
      if (hmValue) {
        await this.ccuConnector.setValue(device.hmAddress, hmValue.key, hmValue.value);
      }
    });

    // Handle level from Matter
    endpoint.events.levelControl.currentLevel$Changed.on(async (value) => {
      if (value !== null && value !== undefined) {
        getLogger().info(`Matter -> CCU: ${device.hmAddress} LEVEL = ${value}`);
        const hmValue = this.deviceMapper.convertToHomematic(
          device.hmAddress, 'levelControl', 'currentLevel', value
        );
        if (hmValue) {
          await this.ccuConnector.setValue(device.hmAddress, hmValue.key, hmValue.value);
        }
      }
    });

    return endpoint;
  }

  /**
   * Create Window Covering device (blind/shutter).
   *
   * Venetian blinds (HmIP-FBL, some HmIPW-DRBL4 channels) report a numeric
   * LEVEL_2 for slat tilt — DeviceMapper sets `device.hasTilt` for those.
   * Roller shutters (LEVEL only) get the simpler Lift-only composition so
   * Matter controllers don't render a non-functional tilt slider.
   */
  private createWindowCoveringDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    const liftPos = device.currentState.currentPositionLiftPercent100ths || 0;

    if (device.hasTilt) {
      const tiltPos = device.currentState.currentPositionTiltPercent100ths || 0;
      const endpoint = new Endpoint(
        WindowCoveringDevice.with(
          BridgedDeviceBasicInformationServer,
          WindowCoveringServer.with("Lift", "Tilt", "PositionAwareLift", "PositionAwareTilt", "AbsolutePosition"),
        ),
        {
          id,
          bridgedDeviceBasicInformation: bridgedInfo,
          windowCovering: {
            type: 8, // TiltBlindLift (venetian)
            currentPositionLiftPercent100ths: liftPos,
            targetPositionLiftPercent100ths: liftPos,
            currentPositionTiltPercent100ths: tiltPos,
            targetPositionTiltPercent100ths: tiltPos,
            operationalStatus: { global: 0, lift: 0, tilt: 0 },
            endProductType: 5, // TiltOnlyInteriorBlind / venetian
          },
        },
      );

      endpoint.events.windowCovering.targetPositionLiftPercent100ths$Changed.on(async (value: any) => {
        if (value !== null && value !== undefined) {
          // Echo from a CCU-originated update (deviceEvent wrote this
          // value into currentState before setting the attribute) — don't
          // bounce it back to the CCU.
          if (device.currentState.targetPositionLiftPercent100ths === value) return;
          // Remember the commanded lift so a tilt command that follows
          // pairs LEVEL with the newest target, not a stale position.
          device.currentState.targetPositionLiftPercent100ths = value;
          getLogger().info(`Matter -> CCU: ${device.hmAddress} LIFT = ${value}`);
          const hmValue = this.deviceMapper.convertToHomematic(
            device.hmAddress, 'windowCovering', 'currentPositionLiftPercent100ths', value,
          );
          if (hmValue) {
            await this.ccuConnector.setValue(device.hmAddress, hmValue.key, hmValue.value);
          }
        }
      });

      endpoint.events.windowCovering.targetPositionTiltPercent100ths$Changed.on(async (value: any) => {
        if (value !== null && value !== undefined) {
          if (device.currentState.targetPositionTiltPercent100ths === value) return;
          device.currentState.targetPositionTiltPercent100ths = value;
          getLogger().info(`Matter -> CCU: ${device.hmAddress} TILT = ${value}`);
          const hmValue = this.deviceMapper.convertToHomematic(
            device.hmAddress, 'windowCovering', 'currentPositionTiltPercent100ths', value,
          );
          if (hmValue) {
            await this.ccuConnector.setValue(device.hmAddress, hmValue.key, hmValue.value);
            // HmIP blind actuators latch LEVEL_2 and only execute it when
            // LEVEL is written afterwards — a lone LEVEL_2 write does
            // nothing. Re-send the current/last-commanded lift to trigger
            // the slat move without changing blind height.
            const liftMatter = device.currentState.targetPositionLiftPercent100ths
              ?? device.currentState.currentPositionLiftPercent100ths;
            const liftHm = liftMatter !== undefined && liftMatter !== null
              ? this.deviceMapper.convertToHomematic(
                  device.hmAddress, 'windowCovering', 'currentPositionLiftPercent100ths', liftMatter,
                )
              : null;
            const liftValue = liftHm
              ? liftHm.value
              : await this.ccuConnector.getValue(device.hmAddress, 'LEVEL');
            getLogger().info(`Matter -> CCU: ${device.hmAddress} LEVEL = ${liftValue} (tilt commit)`);
            await this.ccuConnector.setValue(device.hmAddress, 'LEVEL', liftValue);
          }
        }
      });

      return endpoint;
    }

    const endpoint = new Endpoint(
      WindowCoveringDevice.with(
        BridgedDeviceBasicInformationServer,
        WindowCoveringServer.with("Lift", "PositionAwareLift", "AbsolutePosition"),
      ),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        windowCovering: {
          type: 0, // Rollershade
          currentPositionLiftPercent100ths: liftPos,
          targetPositionLiftPercent100ths: liftPos,
          operationalStatus: { global: 0, lift: 0, tilt: 0 },
          endProductType: 0, // Rollershade
        },
      },
    );

    endpoint.events.windowCovering.targetPositionLiftPercent100ths$Changed.on(async (value: any) => {
      if (value !== null && value !== undefined) {
        if (device.currentState.targetPositionLiftPercent100ths === value) return;
        device.currentState.targetPositionLiftPercent100ths = value;
        getLogger().info(`Matter -> CCU: ${device.hmAddress} LIFT = ${value}`);
        const hmValue = this.deviceMapper.convertToHomematic(
          device.hmAddress, 'windowCovering', 'currentPositionLiftPercent100ths', value,
        );
        if (hmValue) {
          await this.ccuConnector.setValue(device.hmAddress, hmValue.key, hmValue.value);
        }
      }
    });

    return endpoint;
  }

  /**
   * Create Thermostat device
   */
  private createThermostatDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    const endpoint = new Endpoint(
      ThermostatDevice.with(BridgedDeviceBasicInformationServer, ThermostatServer.with("Heating")),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        thermostat: {
          localTemperature: device.currentState.localTemperature || 2000, // 20.00°C
          occupiedHeatingSetpoint: device.currentState.occupiedHeatingSetpoint || 2100, // 21.00°C
          systemMode: 4, // Heat
          controlSequenceOfOperation: 2, // HeatingOnly
          minHeatSetpointLimit: 400, // 4°C
          maxHeatSetpointLimit: 3000 // 30°C
        }
      }
    );

    // Handle setpoint changes from Matter
    endpoint.events.thermostat.occupiedHeatingSetpoint$Changed.on(async (value: any) => {
      if (value !== null && value !== undefined) {
        getLogger().info(`Matter -> CCU: ${device.hmAddress} SETPOINT = ${value}`);
        const hmValue = this.deviceMapper.convertToHomematic(
          device.hmAddress, 'thermostat', 'occupiedHeatingSetpoint', value
        );
        if (hmValue) {
          await this.ccuConnector.setValue(device.hmAddress, hmValue.key, hmValue.value);
        }
      }
    });

    return endpoint;
  }

  /**
   * Create Contact Sensor device
   */
  private createContactSensorDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    return new Endpoint(
      ContactSensorDevice.with(BridgedDeviceBasicInformationServer),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        booleanState: {
          stateValue: device.currentState.stateValue ?? true // true = closed/contact
        }
      }
    );
    // Contact sensors are read-only, no Matter -> CCU handler needed
  }

  /**
   * Create Occupancy Sensor device
   */
  private createOccupancySensorDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    // OccupancySensing requires at least one sensing-modality feature
    // (PassiveInfrared, UltraSonic, PhysicalContact) in Matter 1.3+.
    return new Endpoint(
      OccupancySensorDevice.with(BridgedDeviceBasicInformationServer, OccupancySensingServer.with("PassiveInfrared")),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        occupancySensing: {
          occupancy: device.currentState.occupancy ?? { occupied: false },
          occupancySensorType: 0, // PIR
          occupancySensorTypeBitmap: { pir: true }
        }
      }
    );
    // Occupancy sensors are read-only
  }

  /**
   * Create Temperature Sensor device
   */
  private createTemperatureSensorDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    return new Endpoint(
      TemperatureSensorDevice.with(BridgedDeviceBasicInformationServer),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        temperatureMeasurement: {
          measuredValue: device.currentState.measuredValue || 2000, // 20.00°C
          minMeasuredValue: -4000, // -40°C
          maxMeasuredValue: 8500 // 85°C
        }
      }
    );
    // Temperature sensors are read-only
  }

  /**
   * Create Door Lock device
   */
  private createDoorLockDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    const endpoint = new Endpoint(
      DoorLockDevice.with(BridgedDeviceBasicInformationServer),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        doorLock: {
          lockState: device.currentState.lockState || 1, // 1 = locked
          lockType: 0, // DeadBolt
          actuatorEnabled: true
        }
      }
    );

    // Handle lock/unlock from Matter
    endpoint.events.doorLock.lockState$Changed.on(async (value) => {
      if (value !== null && value !== undefined) {
        getLogger().info(`Matter -> CCU: ${device.hmAddress} LOCK = ${value}`);
        const hmValue = this.deviceMapper.convertToHomematic(
          device.hmAddress, 'doorLock', 'lockState', value
        );
        if (hmValue) {
          await this.ccuConnector.setValue(device.hmAddress, hmValue.key, hmValue.value);
        }
      }
    });

    return endpoint;
  }

  /**
   * For a `*_VIRTUAL_RECEIVER` channel, find the `*_TRANSMITTER` channel of
   * the same HmIP channel group (e.g. DRBL4 `:14/:15/:16` → `:13`, FBL
   * `:4/:5/:6` → `:3`). Walks channel numbers downward through the group's
   * sibling receivers until the transmitter is hit.
   */
  private findStateSourceChannel(
    address: string,
    channelType: string,
    channels: Map<string, HmChannel>
  ): string | undefined {
    const suffix = '_VIRTUAL_RECEIVER';
    if (!channelType || !channelType.endsWith(suffix)) return undefined;
    const txType = channelType.slice(0, -suffix.length) + '_TRANSMITTER';
    const [parent, chStr] = address.split(':');
    for (let ch = parseInt(chStr, 10) - 1; ch >= 0; ch--) {
      const candidate = channels.get(`${parent}:${ch}`);
      if (!candidate) return undefined;
      if (candidate.type === txType) return `${parent}:${ch}`;
      if (candidate.type !== channelType) return undefined; // left the group
    }
    return undefined;
  }

  /**
   * Setup event handlers for CCU -> Matter updates
   */
  private setupEventHandlers(): void {
    // Channels announced at runtime (e.g. a Shelly exposed in the
    // shelly-homematic UI): map them so they appear in the Web UI for
    // exposing — endpoints are only created when the user exposes them.
    this.ccuConnector.on('channelsAdded', (addresses: string[]) => {
      const channels = this.ccuConnector.getChannels();
      const devices = this.ccuConnector.getDevices();
      for (const address of addresses) {
        const channel = channels.get(address);
        if (!channel) continue;
        const parentDevice = devices.get(address.split(':')[0]);
        const mapped = this.deviceMapper.mapChannel(
          address,
          channel.type,
          parentDevice?.type || 'Unknown',
          channel.name,
          channel.paramsets.VALUES || {},
          channel.room,
          this.config.devices?.tilt?.[address]
        );
        if (mapped) getLogger().info(`Mapped announced channel ${address} (${mapped.matterDeviceType}) — expose it in the Web UI`);
      }
    });

    // Devices removed by their interface (unlearned/unexposed at the source):
    // remove any live endpoint so Matter stays in sync.
    this.ccuConnector.on('deleteDevices', (_interfaceId: string, addresses: string[]) => {
      for (const address of addresses || []) {
        for (const [chAddress] of this.deviceMapper.getAllMappedDevices()) {
          if (chAddress === address || chAddress.startsWith(address + ':')) {
            this.setDeviceExposed(chAddress, false).catch(() => undefined);
          }
        }
      }
    });

    this.ccuConnector.on('deviceEvent', async (event) => {
      const { address, key, value } = event;

      // A mapped receiver's own LEVEL/LEVEL_2/STATE events are stale
      // echoes of commands sent through that receiver — the transmitter
      // is authoritative for those keys. Letting them through makes them
      // fight the transmitter events (flip-flopping state) and leaks
      // ghost commands back to the CCU.
      if (this.mirroredReceivers.has(address) && MatterHomematicBridge.MIRRORED_KEYS.includes(key)) {
        return;
      }

      // Events on a *_TRANSMITTER state channel belong to the mapped
      // receiver endpoints that mirror it; everything else applies to the
      // channel's own endpoint.
      const targets = this.stateSources.get(address) ?? [address];
      for (const target of targets) {
        await this.applyCcuUpdate(target, key, value, address);
      }
    });

    this.ccuConnector.on('connectionLost', (interfaceName) => {
      getLogger().error(`Lost connection to CCU interface: ${interfaceName}`);
      // Could implement reconnection logic here
    });
  }

  /**
   * Apply one CCU value to the mapped device + Matter endpoint of
   * `target`. No-op when the value already matches (deduplicates repeated
   * events and keeps the periodic resync quiet).
   */
  private async applyCcuUpdate(target: string, key: string, value: any, source: string): Promise<void> {
    // HmIP transmitters report '' for LEVEL/LEVEL_2 while the actuator is
    // moving ("value unknown"). The converters would coerce '' to a real
    // position (e.g. fully closed) — drop it and wait for the settled value.
    if (value === '') return;

    const matterValue = this.deviceMapper.convertToMatter(target, key, value);
    if (!matterValue) return;

    // Track state on the mapped device: keeps the web UI fresh and lets
    // the $Changed handlers tell external updates from real Matter
    // commands (echo suppression).
    const mappedDevice = this.deviceMapper.getMappedDevice(target);
    if (mappedDevice) {
      // Bitmap attributes (e.g. occupancy) are objects — compare structurally.
      const previous = mappedDevice.currentState[matterValue.attribute];
      const unchanged = typeof matterValue.value === 'object' && matterValue.value !== null
        ? JSON.stringify(previous) === JSON.stringify(matterValue.value)
        : previous === matterValue.value;
      if (unchanged) return;
      mappedDevice.currentState[matterValue.attribute] = matterValue.value;
    }

    const endpoint = this.matterEndpoints.get(target);
    if (!endpoint) return;

    getLogger().info(`CCU -> Matter: ${source} ${key}=${value} -> ${target} ${matterValue.cluster}.${matterValue.attribute}=${matterValue.value}`);

    try {
      const state: any = {};
      state[matterValue.cluster] = {};
      state[matterValue.cluster][matterValue.attribute] = matterValue.value;

      // External position changes move target along with current so
      // controllers don't render a perpetual "opening/closing…". The
      // $Changed echo this triggers is suppressed via currentState.
      if (matterValue.cluster === 'windowCovering' && matterValue.attribute.startsWith('currentPosition')) {
        const targetAttribute = matterValue.attribute.replace('currentPosition', 'targetPosition');
        state.windowCovering[targetAttribute] = matterValue.value;
        if (mappedDevice) {
          mappedDevice.currentState[targetAttribute] = matterValue.value;
        }
      }

      await endpoint.set(state);
    } catch (err) {
      getLogger().error(`Failed to update Matter endpoint:`, err);
    }
  }

  /**
   * Periodically re-read the authoritative state channels of all exposed
   * endpoints from the CCU. Events cover the live path; this closes the
   * gaps (missed callbacks, bridge restarts, CCU interface hiccups).
   */
  private startStateResync(): void {
    const RESYNC_MS = 5 * 60 * 1000;
    this.resyncTimer = setInterval(async () => {
      const sourceOf = new Map<string, string>();
      for (const [src, targets] of this.stateSources) {
        for (const t of targets) sourceOf.set(t, src);
      }
      // Pick up CCU renames so the Web UI (and future endpoint adds) always
      // show current names. Live controllers keep their own labels — only
      // the bridge-side name is updated.
      try {
        const renamed = await this.ccuConnector.refreshNames();
        for (const [address, name] of renamed) {
          const mapped = this.deviceMapper.getAllMappedDevices().get(address);
          if (mapped) {
            getLogger().info(`CCU rename: ${address} -> "${name}"`);
            mapped.name = name;
          }
          const endpoint = this.matterEndpoints.get(address);
          if (endpoint) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (endpoint as any).set({ bridgedDeviceBasicInformation: { nodeLabel: name.substring(0, 32) } })
              .catch((err: unknown) => getLogger().debug(`nodeLabel update failed for ${address}: ${err}`));
          }
        }
      } catch (err) {
        getLogger().debug(`Name refresh failed: ${err}`);
      }

      // One ReGa bulk dump covers all endpoints; getParamset only answers
      // from HMServer's cache (empty after a CCU reboot), so it's the
      // fallback, not the primary source.
      const regaValues = await this.ccuConnector.fetchDatapointValues();
      for (const address of this.matterEndpoints.keys()) {
        const stateAddress = sourceOf.get(address) ?? address;
        const values = regaValues?.get(stateAddress)
          ?? await this.ccuConnector.readValues(stateAddress);
        if (!values) continue;
        for (const [key, value] of Object.entries(values)) {
          await this.applyCcuUpdate(address, key, value, `resync:${stateAddress}`);
        }
      }
    }, RESYNC_MS);
  }

  /**
   * Print pairing information
   */
  private printPairingInfo(): void {
    getLogger().info('\n========================================');
    getLogger().info('Matter-Homematic Bridge is ready!');
    getLogger().info('========================================');
    getLogger().info('');
    getLogger().info('To pair with your smart home controller:');
    getLogger().info('');
    getLogger().info(`  Manual Pairing Code: ${this.config.bridge.passcode}`);
    getLogger().info(`  Discriminator: ${this.config.bridge.discriminator}`);
    getLogger().info(`  Port: ${this.config.bridge.port}`);
    getLogger().info('');
    getLogger().info('Or scan the QR code generated by the Matter library.');
    getLogger().info('');
    getLogger().info(`Bridged Devices: ${this.matterEndpoints.size}`);
    getLogger().info('========================================\n');
  }

  getMatterEndpointCount(): number {
    return this.matterEndpoints.size;
  }

  /**
   * Pairing codes for the web UI. `qrAscii` is matter.js's terminal QR
   * rendering (half-block chars); braille blanks are swapped for plain
   * spaces so browsers render it scannable in a tight monospace <pre>.
   */
  getPairingInfo(): {
    manualPairingCode: string;
    qrPairingCode: string;
    qrAscii: string;
    commissioned: boolean;
  } | null {
    const commissioning = (this.serverNode as any)?.state?.commissioning;
    if (!commissioning?.pairingCodes) return null;
    const { manualPairingCode, qrPairingCode } = commissioning.pairingCodes;
    return {
      manualPairingCode,
      qrPairingCode,
      qrAscii: QrCode.get(qrPairingCode).replace(/⠀/g, ' ').trimEnd(),
      commissioned: !!commissioning.commissioned,
    };
  }

  /**
   * Add or remove a single bridged endpoint at runtime (web UI toggle) —
   * matter.js supports dynamic topology changes on a live aggregator, so
   * no bridge restart is needed. Also patches the in-memory config so
   * isDeviceExposed() stays consistent with what's on disk.
   * Returns true when the live topology actually changed.
   */
  async setDeviceExposed(address: string, exposed: boolean): Promise<boolean> {
    if (this.config.devices) {
      if (!this.config.devices.exposed) this.config.devices.exposed = {};
      this.config.devices.exposed[address] = exposed;
    }
    if (!this.aggregator) return false;

    const existing = this.matterEndpoints.get(address);
    if (exposed) {
      if (existing) return false;
      const device = this.deviceMapper.getMappedDevice(address);
      if (!device) {
        getLogger().warn(`Cannot expose ${address}: not a mapped device`);
        return false;
      }
      const endpoint = await this.createMatterEndpoint(device);
      if (!endpoint) return false;
      await this.aggregator.add(endpoint);
      this.matterEndpoints.set(address, endpoint);
      getLogger().info(`Added bridged device at runtime: ${device.name} (${device.matterDeviceType})`);
      return true;
    }

    if (!existing) return false;
    this.matterEndpoints.delete(address);
    // delete() removes the endpoint from the aggregator and erases its
    // persisted state (a later re-expose starts clean).
    await existing.delete();
    getLogger().info(`Removed bridged device at runtime: ${address}`);
    return true;
  }

  getDeviceMapper(): DeviceMapper {
    return this.deviceMapper;
  }

  getCcuConnector(): CcuConnector {
    return this.ccuConnector;
  }

  getBridgeConfig() {
    return this.config.bridge;
  }

  getCcuHost(): string {
    return this.config.ccu.host;
  }

  /** The interface set the running bridge was started with (merged config). */
  getCcuInterfaces(): Record<string, { enabled: boolean; port: number } | undefined> {
    return this.config.ccu.interfaces;
  }

  /**
   * Stop the bridge
   */
  async stop(): Promise<void> {
    getLogger().info('Stopping Matter-Homematic Bridge...');

    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = undefined;
    }

    if (this.serverNode) {
      // A failed matter.js close (e.g. storage dir already gone) must not
      // skip the CCU disconnect below — leaving the callback server bound
      // makes the next start fail with EADDRINUSE.
      try {
        await this.serverNode.close();
      } catch (err) {
        getLogger().error(`Error closing Matter node: ${err}`);
      }
    }

    await this.ccuConnector.disconnect();

    getLogger().info('Bridge stopped');
  }
}
