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
import { VendorId } from "@matter/main/types";
import { CcuConnector } from '../ccu/CcuConnector';
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
    interfaces: {
      'BidCos-RF'?: { enabled: boolean; port: number };
      'HmIP-RF'?: { enabled: boolean; port: number };
      'VirtualDevices'?: { enabled: boolean; port: number };
    };
    callbackPort: number;
  };
}

export class MatterHomematicBridge {
  private config: FullConfig;
  private ccuConnector: CcuConnector;
  private deviceMapper: DeviceMapper;
  private serverNode?: ServerNode;
  private aggregator?: Endpoint;
  private matterEndpoints: Map<string, Endpoint> = new Map();

  constructor(config: FullConfig) {
    this.config = config;
    this.ccuConnector = new CcuConnector(config.ccu);
    this.deviceMapper = new DeviceMapper();
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

      const mapped = this.deviceMapper.mapChannel(
        address,
        channel.type,
        deviceType,
        channel.name,
        channel.paramsets.VALUES || {},
        channel.room
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

    // Configure storage
    const storageService = environment.get(StorageService);
    // Storage will be at the configured path

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
   * Add all mapped devices as bridged devices
   */
  private async addBridgedDevices(): Promise<void> {
    const mappedDevices = this.deviceMapper.getAllMappedDevices();

    for (const [address, device] of mappedDevices) {
      try {
        const endpoint = await this.createMatterEndpoint(device);
        if (endpoint) {
          await this.aggregator!.add(endpoint);
          this.matterEndpoints.set(address, endpoint);
          getLogger().info(`Added bridged device: ${device.name} (${device.matterDeviceType})`);
        }
      } catch (err) {
        getLogger().error(`Failed to add device ${address}:`, err);
      }
    }

    getLogger().info(`Added ${this.matterEndpoints.size} bridged devices`);
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
    const endpoint = new Endpoint(
      DimmableLightDevice.with(BridgedDeviceBasicInformationServer),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        onOff: {
          onOff: (device.currentState.currentLevel || 0) > 0
        },
        levelControl: {
          currentLevel: device.currentState.currentLevel || 0,
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
   * Create Window Covering device (blind/shutter)
   */
  private createWindowCoveringDevice(id: string, device: MappedDevice, bridgedInfo: any): Endpoint {
    const endpoint = new Endpoint(
      WindowCoveringDevice.with(BridgedDeviceBasicInformationServer, WindowCoveringServer.with("Lift", "PositionAwareLift", "AbsolutePosition")),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        windowCovering: {
          type: 0, // Rollershade
          currentPositionLiftPercent100ths: device.currentState.currentPositionLiftPercent100ths || 0,
          targetPositionLiftPercent100ths: device.currentState.currentPositionLiftPercent100ths || 0,
          operationalStatus: { global: 0, lift: 0, tilt: 0 },
          endProductType: 0 // Rollershade
        }
      }
    );

    // Handle position changes from Matter
    endpoint.events.windowCovering.targetPositionLiftPercent100ths$Changed.on(async (value: any) => {
      if (value !== null && value !== undefined) {
        getLogger().info(`Matter -> CCU: ${device.hmAddress} POSITION = ${value}`);
        const hmValue = this.deviceMapper.convertToHomematic(
          device.hmAddress, 'windowCovering', 'currentPositionLiftPercent100ths', value
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
    return new Endpoint(
      OccupancySensorDevice.with(BridgedDeviceBasicInformationServer, OccupancySensingServer),
      {
        id,
        bridgedDeviceBasicInformation: bridgedInfo,
        occupancySensing: {
          occupancy: { occupied: device.currentState.occupancy ? true : false },
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
   * Setup event handlers for CCU -> Matter updates
   */
  private setupEventHandlers(): void {
    this.ccuConnector.on('deviceEvent', async (event) => {
      const { address, key, value } = event;
      
      const matterValue = this.deviceMapper.convertToMatter(address, key, value);
      if (!matterValue) return;

      const endpoint = this.matterEndpoints.get(address);
      if (!endpoint) return;

      getLogger().info(`CCU -> Matter: ${address} ${key}=${value} -> ${matterValue.cluster}.${matterValue.attribute}=${matterValue.value}`);

      try {
        // Update Matter endpoint state
        const state: any = {};
        state[matterValue.cluster] = {};
        state[matterValue.cluster][matterValue.attribute] = matterValue.value;
        
        await endpoint.set(state);
      } catch (err) {
        getLogger().error(`Failed to update Matter endpoint:`, err);
      }
    });

    this.ccuConnector.on('connectionLost', (interfaceName) => {
      getLogger().error(`Lost connection to CCU interface: ${interfaceName}`);
      // Could implement reconnection logic here
    });
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

  /**
   * Stop the bridge
   */
  async stop(): Promise<void> {
    getLogger().info('Stopping Matter-Homematic Bridge...');

    if (this.serverNode) {
      await this.serverNode.close();
    }

    await this.ccuConnector.disconnect();

    getLogger().info('Bridge stopped');
  }
}
