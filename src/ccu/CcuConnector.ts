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

// xmlrpc's XML codec internals — used by the hand-rolled callback server
// (see startCallbackServer for why xmlrpc.createServer can't be used).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XmlRpcSerializer = require('xmlrpc/lib/serializer');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XmlRpcDeserializer = require('xmlrpc/lib/deserializer');

// Types for Homematic devices
interface HmDevice {
  address: string;
  type: string;
  interface: string;
  channels: HmChannel[];
}

export interface HmChannel {
  address: string;
  type: string;
  name: string;
  room?: string;
  function?: string;
  /** XML-RPC interface the channel lives on (BidCos-RF, HmIP-RF, …). */
  interface?: string;
  paramsets: {
    VALUES?: Record<string, any>;
    MASTER?: Record<string, any>;
  };
}

interface CcuConfig {
  host: string;
  // Standard CCU interfaces (BidCos-RF 2001, HmIP-RF 2010, VirtualDevices
  // 9292) plus any additional ipc interfaces registered on the CCU, e.g.
  // ShellyHM (2121) from the shelly-homematic addon.
  interfaces: Record<string, { enabled: boolean; port: number } | undefined>;
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
  /** ReGa port that answered the last datapoint dump (avoids re-probing). */
  private regaValuesPort?: number;

  constructor(config: CcuConfig) {
    super();
    this.config = config;
  }

  /**
   * ReGa UriEncode() percent-escapes ISO-8859-1 bytes (%E4 = ä), which
   * decodeURIComponent would reject as invalid UTF-8 — decode byte-wise.
   */
  private decodeRega(s: string): string {
    return s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  /**
   * Whether a CCU name is just the firmware default (no user label). The CCU
   * seeds unnamed objects with names that embed their own address, e.g.
   * `HmIP-FBL 00139F2991A80B:1` for a channel or `HmIP-FBL 00139F2991A80B`
   * for a device. Such a name carries no information beyond the address.
   */
  private isTemplateName(name: string, address: string): boolean {
    return !name || name === address || name.includes(address);
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
   * Start the XML-RPC callback server.
   *
   * Hand-rolled HTTP layer instead of xmlrpc.createServer for two CCU
   * compatibility requirements discovered on real CCU3 firmware:
   *
   * 1. Responses must carry a Content-Length header — node defaults to
   *    chunked transfer encoding, which the CCU's old rfd XML-RPC client
   *    cannot parse (every event delivery fails with an empty error).
   * 2. *Every* method must get a valid XML-RPC response. The HmIP HMServer
   *    calls `listDevices` on the callback server during init and aborts
   *    the entire callback registration when it gets xmlrpc's default
   *    404/empty-body answer ("Unexpected EOF in prolog" in hmserver.log)
   *    — after which no events are ever delivered.
   */
  private async startCallbackServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const deserializer = new XmlRpcDeserializer();
        deserializer.deserializeMethodCall(req, (error: Error | null, methodName: string, params: any[]) => {
          if (error) {
            getLogger().warn(`Callback server: bad request: ${error}`);
            res.writeHead(400);
            res.end();
            return;
          }
          let result: any = '';
          try {
            result = this.handleCallbackMethod(methodName, params);
          } catch (err) {
            getLogger().error(`Callback method ${methodName} failed:`, err);
            result = '';
          }
          const xml = XmlRpcSerializer.serializeMethodResponse(result);
          res.writeHead(200, {
            'Content-Type': 'text/xml',
            'Content-Length': Buffer.byteLength(xml),
          });
          res.end(xml);
        });
      });

      this.callbackServer = server;
      server.on('error', (err: Error) => {
        getLogger().error('Callback server error:', err);
        reject(err);
      });
      server.listen(this.config.callbackPort, '0.0.0.0', () => {
        getLogger().info(`Callback server listening on port ${this.config.callbackPort}`);
        resolve();
      });
    });
  }

  /**
   * Dispatch one XML-RPC method from the CCU and return its result value.
   */
  private handleCallbackMethod(methodName: string, params: any[]): any {
    switch (methodName) {
      case 'event': {
        const [interfaceId, address, key, value] = params;
        this.handleEvent(interfaceId, address, key, value);
        return '';
      }

      // Init handshake: the CCU asks which devices we already know, then
      // pushes the delta via newDevices. We answer "none" — discovery runs
      // through our own client-side listDevices call instead.
      case 'listDevices':
        return [];

      case 'newDevices': {
        const [interfaceId, devices] = params;
        getLogger().info(`New devices on ${interfaceId}: ${devices?.length ?? 0}`);
        this.emit('newDevices', interfaceId, devices);
        return '';
      }

      case 'deleteDevices': {
        const [interfaceId, addresses] = params;
        this.emit('deleteDevices', interfaceId, addresses);
        return '';
      }

      case 'system.listMethods':
        return ['event', 'listDevices', 'newDevices', 'deleteDevices', 'system.listMethods', 'system.multicall'];

      case 'system.multicall': {
        const calls = params[0] || [];
        return calls.map((call: any) => [this.handleCallbackMethod(call.methodName, call.params)]);
      }

      // setReadyConfig, updateDevice, readdedDevice, … — acknowledge
      // anything else so strict CCU components never see an error.
      default:
        getLogger().debug(`Callback server: ignoring method ${methodName}`);
        return '';
    }
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
            interface: interfaceName,
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

    // HMServer's getParamset VALUES comes from its in-memory cache, which
    // is empty after a CCU reboot until every device has reported again —
    // getValue even faults with -5. ReGa keeps the last known datapoint
    // values, so overlay them for initial state seeding (and tilt
    // auto-detection, which needs LEVEL_2 before mapping).
    const regaValues = await this.fetchDatapointValues();
    if (regaValues) {
      let seeded = 0;
      for (const [address, values] of regaValues) {
        const channel = this.channels.get(address);
        if (!channel) continue;
        channel.paramsets.VALUES = { ...values, ...(channel.paramsets.VALUES || {}) };
        seeded++;
      }
      getLogger().info(`Seeded VALUES for ${seeded} channels from ReGa`);
    }

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
      // Without credentials, try the ReGa script endpoint. Modern firmware
      // returns 403 to remote clients, but requests from the CCU itself
      // (the addon deployment) are unauthenticated — the same mechanism
      // hap-homematic relies on.
      if (await this.fetchDeviceNamesViaRega()) return;
      getLogger().info('No CCU credentials configured and ReGa script endpoint unavailable; using addresses as names (set CCU_USER/CCU_PASSWORD env vars)');
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
        // Device name fallback for channels that only carry a template name.
        const devName: string = (dev.name && !this.isTemplateName(dev.name, dev.address))
          ? dev.name : '';
        for (const ch of dev.channels || []) {
          const address: string = ch.address;
          idToAddress.set(String(ch.id), address);
          const channel = this.channels.get(address);
          if (!channel) continue;
          let name: string = ch.name || '';
          if (this.isTemplateName(name, address) && devName) name = devName;
          if (name && name !== address) {
            channel.name = name;
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
   * Re-read a channel's VALUES paramset from the CCU (used by the periodic
   * state resync — events can be missed across restarts/reconnects).
   * Updates the local cache and returns the fresh values.
   */
  async readValues(address: string): Promise<Record<string, any> | null> {
    const channel = this.channels.get(address);
    if (!channel?.interface) return null;
    try {
      const values = await this.rpcCall(channel.interface, 'getParamset', [address, 'VALUES']);
      channel.paramsets.VALUES = values;
      return values as Record<string, any>;
    } catch (err) {
      getLogger().debug(`readValues(${address}) failed: ${err}`);
      return null;
    }
  }

  /**
   * Fetch channel names and room assignments by running a ReGa script
   * against `/tclrega.exe`. Only reachable without credentials from the
   * CCU itself; remote clients on modern firmware get 403 and fall back.
   * Names are UriEncode()d inside ReGa so they survive the ISO-8859-1
   * transport regardless of content.
   */
  private async fetchDeviceNamesViaRega(): Promise<boolean> {
    const script =
      'string did; string cid; boolean cf = true;' +
      'Write("{\\"channels\\":[");' +
      'foreach (did, root.Devices().EnumUsedIDs()) {' +
      '  object d = dom.GetObject(did);' +
      '  if (d && d.ReadyConfig()) {' +
      '    foreach (cid, d.Channels().EnumUsedIDs()) {' +
      '      object c = dom.GetObject(cid);' +
      '      if (c) {' +
      '        if (cf) { cf = false; } else { Write(","); }' +
      '        Write("{\\"id\\":" # cid # ",\\"address\\":\\"" # c.Address() # "\\",\\"name\\":\\"" # c.Name().UriEncode() # "\\"}");' +
      '      }' +
      '    }' +
      '  }' +
      '}' +
      // Device-level names: a user may name only the device (top-level),
      // leaving channels with their default template names. Dump those so we
      // can fall back to the device name for otherwise-unnamed channels.
      'Write("],\\"devices\\":[");' +
      'string did2; boolean df = true;' +
      'foreach (did2, root.Devices().EnumUsedIDs()) {' +
      '  object d2 = dom.GetObject(did2);' +
      '  if (d2 && d2.ReadyConfig()) {' +
      '    if (df) { df = false; } else { Write(","); }' +
      '    Write("{\\"address\\":\\"" # d2.Address() # "\\",\\"name\\":\\"" # d2.Name().UriEncode() # "\\"}");' +
      '  }' +
      '}' +
      'Write("],\\"rooms\\":[");' +
      'string rid; boolean rf = true;' +
      'foreach (rid, dom.GetObject(ID_ROOMS).EnumUsedIDs()) {' +
      '  object r = dom.GetObject(rid);' +
      '  if (r) {' +
      '    if (rf) { rf = false; } else { Write(","); }' +
      '    Write("{\\"name\\":\\"" # r.Name().UriEncode() # "\\",\\"channelIds\\":[");' +
      '    string rcid; boolean rcf = true;' +
      '    foreach (rcid, r.EnumUsedIDs()) {' +
      '      if (rcf) { rcf = false; } else { Write(","); }' +
      '      Write(rcid);' +
      '    }' +
      '    Write("]}");' +
      '  }' +
      '}' +
      'Write("]}");';

    const decodeRega = (s: string): string => this.decodeRega(s);

    // Port 8181 is ReGa's own HTTP port (no auth layer); fall back to the
    // WebUI port, which also proxies tclrega.exe on older/unlocked setups.
    for (const port of [8181, this.config.regaPort ?? 80]) {
      let parsed: { channels?: any[]; devices?: any[]; rooms?: any[] };
      try {
        const raw = await this.regaScript(script, port);
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      // deviceAddress → user-assigned device name (template names filtered out)
      const deviceNames = new Map<string, string>();
      for (const dev of parsed.devices || []) {
        const address = String(dev.address || '');
        const name = decodeRega(String(dev.name || ''));
        if (address && !this.isTemplateName(name, address)) {
          deviceNames.set(address, name);
        }
      }

      const idToAddress = new Map<string, string>();
      let nameUpdates = 0;
      for (const ch of parsed.channels || []) {
        const address: string = ch.address;
        idToAddress.set(String(ch.id), address);
        const channel = this.channels.get(address);
        if (!channel) continue;
        const own = decodeRega(String(ch.name || ''));
        // Prefer the channel's own user name; fall back to the device name
        // when the channel only carries a default template name.
        let name = own;
        if (this.isTemplateName(own, address)) {
          const devName = deviceNames.get(address.split(':')[0]);
          if (devName) name = devName;
        }
        if (name && name !== address) {
          channel.name = name;
          nameUpdates++;
        }
      }

      let roomUpdates = 0;
      for (const room of parsed.rooms || []) {
        const roomName = decodeRega(String(room.name || ''));
        for (const cid of room.channelIds || []) {
          const address = idToAddress.get(String(cid));
          const channel = address ? this.channels.get(address) : undefined;
          if (!channel) continue;
          channel.room = roomName;
          roomUpdates++;
        }
      }

      getLogger().info(`Applied ReGa names to ${nameUpdates} channels, rooms to ${roomUpdates} channels (port ${port})`);
      return true;
    }
    return false;
  }

  /**
   * Dump all datapoint values from ReGa in one script. Returns a map of
   * channel address → { KEY: value } for every discovered channel, or
   * null when no ReGa endpoint is reachable (e.g. pydevccu).
   *
   * This is the only reliable bulk state source on real CCU3 firmware:
   * XML-RPC getParamset VALUES answers from HMServer's in-memory cache
   * (empty struct after a CCU reboot) and getValue faults with -5 until a
   * device has reported. ReGa persists the last known values.
   *
   * Entries whose timestamp is the 1970 epoch have never been reported
   * and are skipped. Empty-string values with a real timestamp are kept —
   * they are meaningful (e.g. DRBL4 LEVEL_2 = "" in roller mode).
   */
  async fetchDatapointValues(): Promise<Map<string, Record<string, any>> | null> {
    const script =
      'string id; boolean f = true;' +
      'Write("{");' +
      'foreach (id, dom.GetObject(ID_DATAPOINTS).EnumIDs()) {' +
      '  object dp = dom.GetObject(id);' +
      '  if (dp) {' +
      '    string sv = "" # dp.Value();' +
      '    string st = "" # dp.Timestamp();' +
      '    if (f) { f = false; } else { Write(","); }' +
      '    Write("\\"" # dp.Name().UriEncode() # "\\":[\\"" # sv.UriEncode() # "\\",\\"" # st # "\\"]");' +
      '  }' +
      '}' +
      'Write("}");';

    // ReGa stringifies values: booleans as true/false, numbers with
    // trailing zeros. Convert back to the types the value converters and
    // tilt auto-detection expect ('' stays '').
    const coerce = (s: string): any => {
      if (s === 'true') return true;
      if (s === 'false') return false;
      if (s !== '' && !isNaN(Number(s))) return Number(s);
      return s;
    };

    const ports = this.regaValuesPort !== undefined
      ? [this.regaValuesPort]
      : [8181, this.config.regaPort ?? 80];
    for (const port of ports) {
      let parsed: Record<string, [string, string]>;
      try {
        const raw = await this.regaScript(script, port);
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const result = new Map<string, Record<string, any>>();
      for (const [encodedName, entry] of Object.entries(parsed)) {
        if (!Array.isArray(entry) || typeof entry[1] !== 'string' || entry[1].startsWith('1970')) continue;
        // Datapoint names are "<Interface>.<Address>.<KEY>"
        const name = this.decodeRega(encodedName);
        const firstDot = name.indexOf('.');
        const lastDot = name.lastIndexOf('.');
        if (firstDot < 0 || lastDot <= firstDot) continue;
        const address = name.slice(firstDot + 1, lastDot);
        if (!this.channels.has(address)) continue;
        const key = name.slice(lastDot + 1);
        let values = result.get(address);
        if (!values) {
          values = {};
          result.set(address, values);
        }
        values[key] = coerce(this.decodeRega(entry[0]));
      }
      this.regaValuesPort = port;
      return result;
    }
    return null;
  }

  /**
   * POST a ReGa script to `/tclrega.exe` and return the script's raw
   * output with the trailing `<xml>…</xml>` status block stripped.
   */
  private regaScript(script: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(script, 'latin1');
      const req = http.request(
        {
          host: this.config.host,
          port,
          path: '/tclrega.exe',
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=ISO-8859-1',
            'Content-Length': data.length,
          },
          timeout: 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`tclrega.exe HTTP ${res.statusCode}`));
              return;
            }
            const body = Buffer.concat(chunks).toString('latin1');
            const xmlStart = body.lastIndexOf('<xml>');
            resolve(xmlStart >= 0 ? body.slice(0, xmlStart) : body);
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('tclrega.exe timeout')));
      req.write(data);
      req.end();
    });
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
