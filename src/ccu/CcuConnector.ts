/**
 * Matter-Homematic Bridge - Proof of Concept
 * 
 * CCU Connector - Handles XML-RPC communication with Homematic CCU
 */

import * as xmlrpc from 'xmlrpc';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as os from 'os';
import { getLogger } from '../utils/Logger';

// Types for Homematic devices
interface HmDevice {
  address: string;
  type: string;
  interface: string;
  channels: HmChannel[];
}

interface HmChannel {
  address: string;
  type: string;
  name: string;
  room?: string;
  function?: string;
  paramsets: {
    VALUES?: Record<string, any>;
    MASTER?: Record<string, any>;
  };
}

interface CcuConfig {
  host: string;
  interfaces: {
    'BidCos-RF'?: { enabled: boolean; port: number };
    'HmIP-RF'?: { enabled: boolean; port: number };
    'VirtualDevices'?: { enabled: boolean; port: number };
  };
  callbackPort: number;
  callbackHost?: string;
  regaPort?: number;
  /** CCU WebUI credentials — only needed for tclrega.exe calls on CCUs
   *  with authentication enabled. XML-RPC endpoints don't use auth. */
  user?: string;
  password?: string;
}

interface InterfaceClient {
  name: string;
  client: any;
  port: number;
}

export class CcuConnector extends EventEmitter {
  private config: CcuConfig;
  private clients: Map<string, InterfaceClient> = new Map();
  private callbackServer?: http.Server;
  private devices: Map<string, HmDevice> = new Map();
  private channels: Map<string, HmChannel> = new Map();
  private connected: boolean = false;
  private pingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(config: CcuConfig) {
    super();
    this.config = config;
  }

  /**
   * Connect to all enabled CCU interfaces
   */
  async connect(): Promise<void> {
    getLogger().info(`Connecting to CCU at ${this.config.host}...`);

    // Start callback server first
    await this.startCallbackServer();

    // Connect to each enabled interface
    for (const [name, settings] of Object.entries(this.config.interfaces)) {
      if (settings?.enabled) {
        await this.connectInterface(name, settings.port);
      }
    }

    this.connected = true;
    this.emit('connected');
  }

  /**
   * Connect to a specific CCU interface
   */
  private async connectInterface(name: string, port: number): Promise<void> {
    getLogger().info(`Connecting to interface ${name} on port ${port}...`);

    const client = xmlrpc.createClient({
      host: this.config.host,
      port: port,
      path: '/'
    });

    this.clients.set(name, { name, client, port });

    // Register for callbacks
    const callbackUrl = `http://${this.config.callbackHost || this.getLocalIp()}:${this.config.callbackPort}`;
    const interfaceId = `matter-homematic-${name}`;

    try {
      await this.rpcCall(name, 'init', [callbackUrl, interfaceId]);
      getLogger().info(`Registered callbacks for ${name}`);

      // Start ping interval to keep connection alive
      const pingInterval = setInterval(async () => {
        try {
          await this.rpcCall(name, 'ping', [interfaceId]);
        } catch (err) {
          getLogger().error(`Ping failed for ${name}:`, err);
          this.emit('connectionLost', name);
        }
      }, 30000);

      this.pingIntervals.set(name, pingInterval);
    } catch (err) {
      getLogger().error(`Failed to initialize ${name}:`, err);
      throw err;
    }
  }

  /**
   * Start XML-RPC callback server
   */
  private async startCallbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = xmlrpc.createServer({ 
        host: '0.0.0.0', 
        port: this.config.callbackPort 
      });

      // Handle incoming events from CCU
      server.on('event', (err: Error | null, params: any[], callback: (...args: any[]) => void) => {
        if (err) {
          getLogger().error('Event error:', err);
          callback(null, '');
          return;
        }

        const [interfaceId, address, key, value] = params;
        this.handleEvent(interfaceId, address, key, value);
        callback(null, '');
      });

      // Handle new devices notification
      server.on('newDevices', (err: Error | null, params: any[], callback: (...args: any[]) => void) => {
        if (err) {
          getLogger().error('newDevices error:', err);
          callback(null, '');
          return;
        }

        const [interfaceId, devices] = params;
        getLogger().info(`New devices on ${interfaceId}:`, devices.length);
        this.emit('newDevices', interfaceId, devices);
        callback(null, '');
      });

      // Handle deleted devices
      server.on('deleteDevices', (err: Error | null, params: any[], callback: (...args: any[]) => void) => {
        if (err) {
          getLogger().error('deleteDevices error:', err);
          callback(null, '');
          return;
        }

        const [interfaceId, addresses] = params;
        getLogger().info(`Deleted devices on ${interfaceId}:`, addresses);
        this.emit('deleteDevices', interfaceId, addresses);
        callback(null, '');
      });

      // Handle system.listMethods (required by CCU)
      server.on('system.listMethods', (err: Error | null, params: any[], callback: (...args: any[]) => void) => {
        callback(null, ['event', 'newDevices', 'deleteDevices', 'system.listMethods', 'system.multicall']);
      });

      // Handle multicall
      server.on('system.multicall', (err: Error | null, params: any[], callback: (...args: any[]) => void) => {
        const calls = params[0] || [];
        const results: any[] = [];

        for (const call of calls) {
          if (call.methodName === 'event') {
            const [interfaceId, address, key, value] = call.params;
            this.handleEvent(interfaceId, address, key, value);
            results.push(['']);
          } else {
            results.push(['']);
          }
        }

        callback(null, results);
      });

      // xmlrpc's createServer exposes the underlying http.Server as .httpServer
      // and 'listening' / 'error' are emitted on that, not on the xmlrpc server itself.
      this.callbackServer = server.httpServer;
      server.httpServer.on('listening', () => {
        getLogger().info(`Callback server listening on port ${this.config.callbackPort}`);
        resolve();
      });

      server.httpServer.on('error', (err: Error) => {
        getLogger().error('Callback server error:', err);
        reject(err);
      });
    });
  }

  /**
   * Handle incoming event from CCU
   */
  private handleEvent(interfaceId: string, address: string, key: string, value: any): void {
    // Extract interface name from interfaceId (e.g., "matter-homematic-BidCos-RF" -> "BidCos-RF")
    const interfaceName = interfaceId.replace('matter-homematic-', '');
    
    // Update local cache
    const channel = this.channels.get(address);
    if (channel && channel.paramsets.VALUES) {
      channel.paramsets.VALUES[key] = value;
    }

    // Emit event for state synchronizer
    this.emit('deviceEvent', {
      interface: interfaceName,
      address,
      key,
      value
    });
  }

  /**
   * Discover all devices from CCU
   */
  async discoverDevices(): Promise<Map<string, HmChannel>> {
    getLogger().info('Discovering devices...');

    for (const [interfaceName, interfaceClient] of this.clients) {
      try {
        const deviceList = await this.rpcCall(interfaceName, 'listDevices', []);
        
        for (const device of deviceList) {
          // Skip device root entries (address without colon)
          if (!device.ADDRESS.includes(':')) {
            this.devices.set(device.ADDRESS, {
              address: device.ADDRESS,
              type: device.TYPE,
              interface: interfaceName,
              channels: []
            });
            continue;
          }

          // This is a channel
          const channel: HmChannel = {
            address: device.ADDRESS,
            type: device.TYPE,
            name: device.ADDRESS, // Will be updated from ReGa
            paramsets: {}
          };

          // Get current values
          try {
            const values = await this.rpcCall(interfaceName, 'getParamset', [device.ADDRESS, 'VALUES']);
            channel.paramsets.VALUES = values;
          } catch (err) {
            // Some channels don't have VALUES paramset
          }

          this.channels.set(device.ADDRESS, channel);

          // Add to parent device
          const parentAddress = device.PARENT;
          const parentDevice = this.devices.get(parentAddress);
          if (parentDevice) {
            parentDevice.channels.push(channel);
          }
        }

        getLogger().info(`Found ${deviceList.length} items on ${interfaceName}`);
      } catch (err) {
        getLogger().error(`Failed to list devices on ${interfaceName}:`, err);
      }
    }

    // Fetch names from ReGa (CCU logic layer)
    await this.fetchDeviceNames();

    return this.channels;
  }

  /**
   * Fetch device names and room assignments via the CCU JSON-RPC API
   * (`/api/homematic.cgi`), which is the only way modern CCU3 firmware
   * exposes ReGa data to external clients — `tclrega.exe` requires ADMIN
   * rights the non-interactive `WebUI login` user doesn't have.
   *
   * Requires `ccu.user` / `ccu.password` (sourced from `CCU_USER` /
   * `CCU_PASSWORD` env vars). Without credentials or on any failure,
   * logs a warning and leaves addresses as names.
   */
  private async fetchDeviceNames(): Promise<void> {
    if (!this.config.user) {
      getLogger().info('No CCU credentials configured; skipping name/room lookup (set CCU_USER/CCU_PASSWORD env vars)');
      return;
    }
    getLogger().info('Fetching device names from CCU JSON-RPC...');

    let sid: string;
    try {
      sid = await this.jsonRpcLogin();
    } catch (err) {
      getLogger().warn(`CCU login failed (${(err as Error).message}); falling back to addresses as names`);
      return;
    }

    try {
      const devices = await this.jsonRpc('Device.listAllDetail', { _session_id_: sid }) as any[];
      const rooms = await this.jsonRpc('Room.getAll', { _session_id_: sid }) as any[];

      // channelId → channel address (only for channels we've discovered via XML-RPC)
      const idToAddress = new Map<string, string>();
      let nameUpdates = 0;
      for (const dev of devices || []) {
        for (const ch of dev.channels || []) {
          const address: string = ch.address;
          idToAddress.set(String(ch.id), address);
          const channel = this.channels.get(address);
          if (!channel) continue;
          if (ch.name && ch.name !== address) {
            channel.name = ch.name;
            nameUpdates++;
          }
        }
      }

      let roomUpdates = 0;
      for (const room of rooms || []) {
        for (const cid of room.channelIds || []) {
          const address = idToAddress.get(String(cid));
          if (!address) continue;
          const channel = this.channels.get(address);
          if (!channel) continue;
          channel.room = room.name;
          roomUpdates++;
        }
      }

      getLogger().info(`Applied CCU names to ${nameUpdates} channels, rooms to ${roomUpdates} channels`);
    } catch (err) {
      getLogger().warn(`CCU name fetch failed (${(err as Error).message}); falling back to addresses as names`);
    } finally {
      try {
        await this.jsonRpc('Session.logout', { _session_id_: sid });
      } catch { /* best-effort */ }
    }
  }

  /**
   * Log in to the CCU JSON-RPC API and return a session id.
   */
  private async jsonRpcLogin(): Promise<string> {
    const res = await this.jsonRpc('Session.login', {
      username: this.config.user,
      password: this.config.password ?? '',
    });
    if (typeof res !== 'string' || !res) {
      throw new Error('Session.login did not return a session id');
    }
    return res;
  }

  /**
   * Low-level JSON-RPC call against `/api/homematic.cgi`. Returns the
   * `result` field or throws on transport / API errors.
   */
  private jsonRpc(method: string, params: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const port = this.config.regaPort ?? 80;
      const payload = JSON.stringify({ version: '1.1', method, params });
      const data = Buffer.from(payload, 'utf-8');
      const req = http.request(
        {
          host: this.config.host,
          port,
          path: '/api/homematic.cgi',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length,
          },
          timeout: 5000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`JSON-RPC HTTP ${res.statusCode}`));
              return;
            }
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (body.error) {
                reject(new Error(`${method}: ${body.error.message || JSON.stringify(body.error)}`));
              } else {
                resolve(body.result);
              }
            } catch (err) {
              reject(new Error(`Invalid JSON response from ${method}: ${err}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`${method} timed out`));
      });
      req.write(data);
      req.end();
    });
  }

  /**
   * Set a value on a device channel
   */
  async setValue(address: string, key: string, value: any): Promise<void> {
    const channel = this.channels.get(address);
    if (!channel) {
      throw new Error(`Unknown channel: ${address}`);
    }

    // Determine which interface this channel belongs to
    const parentAddress = address.split(':')[0];
    const device = this.devices.get(parentAddress);
    if (!device) {
      throw new Error(`Unknown device for channel: ${address}`);
    }

    const interfaceName = device.interface;

    try {
      await this.rpcCall(interfaceName, 'setValue', [address, key, value]);
      
      // Update local cache
      if (channel.paramsets.VALUES) {
        channel.paramsets.VALUES[key] = value;
      }
    } catch (err) {
      getLogger().error(`Failed to set ${key}=${value} on ${address}:`, err);
      throw err;
    }
  }

  /**
   * Get a value from a device channel
   */
  async getValue(address: string, key: string): Promise<any> {
    const channel = this.channels.get(address);
    if (!channel) {
      throw new Error(`Unknown channel: ${address}`);
    }

    const parentAddress = address.split(':')[0];
    const device = this.devices.get(parentAddress);
    if (!device) {
      throw new Error(`Unknown device for channel: ${address}`);
    }

    const interfaceName = device.interface;

    try {
      const value = await this.rpcCall(interfaceName, 'getValue', [address, key]);
      
      // Update local cache
      if (channel.paramsets.VALUES) {
        channel.paramsets.VALUES[key] = value;
      }
      
      return value;
    } catch (err) {
      getLogger().error(`Failed to get ${key} from ${address}:`, err);
      throw err;
    }
  }

  /**
   * Make an XML-RPC call
   */
  private rpcCall(interfaceName: string, method: string, params: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const interfaceClient = this.clients.get(interfaceName);
      if (!interfaceClient) {
        reject(new Error(`Interface not connected: ${interfaceName}`));
        return;
      }

      interfaceClient.client.methodCall(method, params, (err: Error | null, result: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Get local IP address for callback URL
   */
  private getLocalIp(): string {
    const interfaces = os.networkInterfaces();
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    
    return '127.0.0.1';
  }

  /**
   * Disconnect from CCU
   */
  async disconnect(): Promise<void> {
    getLogger().info('Disconnecting from CCU...');

    // Stop ping intervals
    for (const [name, interval] of this.pingIntervals) {
      clearInterval(interval);
    }
    this.pingIntervals.clear();

    // Unregister callbacks
    for (const [name, interfaceClient] of this.clients) {
      try {
        await this.rpcCall(name, 'init', ['', `matter-homematic-${name}`]);
      } catch (err) {
        // Ignore errors during disconnect
      }
    }

    // Close callback server
    if (this.callbackServer) {
      this.callbackServer.close();
    }

    this.clients.clear();
    this.connected = false;
    this.emit('disconnected');
  }

  /**
   * Get all discovered channels
   */
  getChannels(): Map<string, HmChannel> {
    return this.channels;
  }

  /**
   * Get all discovered devices
   */
  getDevices(): Map<string, HmDevice> {
    return this.devices;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}
