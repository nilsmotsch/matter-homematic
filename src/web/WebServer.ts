import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { getLogger } from '../utils/Logger';

interface WebServerDeps {
  getDevices: () => Map<string, any>;
  getChannels: () => Map<string, any>;
  isCcuConnected: () => boolean;
  getMatterEndpointCount: () => number;
  getBridgeConfig: () => {
    name: string;
    port: number;
    passcode: number;
    discriminator: number;
  };
  getCcuHost: () => string;
  configPath: string;
  restartBridge: () => Promise<void>;
  /** Apply an exposure toggle to the running bridge (add/remove the
   *  endpoint live). Returns true if the topology changed. */
  setDeviceExposed: (address: string, exposed: boolean) => Promise<boolean>;
  /** Matter pairing codes incl. ASCII QR; null until the server is up. */
  getPairingInfo: () => {
    manualPairingCode: string;
    qrPairingCode: string;
    qrAscii: string;
    commissioned: boolean;
  } | null;
  /** Absolute path of the bridge log file ('' when logging to console only). */
  logFilePath: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class WebServer {
  private server: http.Server;
  private port: number;
  private deps: WebServerDeps;
  private staticDir: string;
  private startTime: Date;

  constructor(port: number, deps: WebServerDeps) {
    this.port = port;
    this.deps = deps;
    // Resolve relative to the compiled file so the daemonized service finds
    // the static assets regardless of cwd. Two layouts exist:
    //   tsc:           dist/web/WebServer.js → ../../html
    //   esbuild addon: dist/index.js         → ../html
    const candidates = [
      path.resolve(__dirname, '..', '..', 'html'),
      path.resolve(__dirname, '..', 'html'),
    ];
    this.staticDir = candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
    this.startTime = new Date();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        getLogger().info(`Web UI available at http://localhost:${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsed = url.parse(req.url || '/', true);
    const pathname = parsed.pathname || '/';

    if (pathname === '/api/') {
      const method = parsed.query.method as string;
      if (!method) {
        this.sendJson(res, 400, { error: 'Missing method parameter' });
        return;
      }
      this.handleApi(method, req, res);
    } else {
      this.serveStatic(pathname, res);
    }
  }

  private handleApi(method: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    switch (method) {
      case 'getBridgeStatus':
        this.sendJson(res, 200, this.getBridgeStatus());
        break;

      case 'getDevices':
        this.sendJson(res, 200, this.getDevices());
        break;

      case 'getChannels':
        this.sendJson(res, 200, this.getChannels());
        break;

      case 'getSupportedTypes':
        this.sendJson(res, 200, this.getSupportedTypes());
        break;

      case 'getPairingInfo':
        this.sendJson(res, 200, this.deps.getPairingInfo() || { error: 'Matter server not started' });
        break;

      case 'getLog':
        this.handleGetLog(req, res);
        break;

      case 'getConfig':
        this.sendJson(res, 200, this.getConfig());
        break;

      case 'setDeviceExposed':
        if (req.method !== 'POST') {
          this.sendJson(res, 405, { error: 'POST required' });
          return;
        }
        this.handleSetDeviceExposed(req, res);
        break;

      case 'setDefaultExposed':
        if (req.method !== 'POST') {
          this.sendJson(res, 405, { error: 'POST required' });
          return;
        }
        this.handleSetDefaultExposed(req, res);
        break;

      case 'setDeviceTilt':
        if (req.method !== 'POST') {
          this.sendJson(res, 405, { error: 'POST required' });
          return;
        }
        this.handleSetDeviceTilt(req, res);
        break;

      case 'restartBridge':
        if (req.method !== 'POST') {
          this.sendJson(res, 405, { error: 'POST required' });
          return;
        }
        this.handleRestartBridge(res);
        break;

      default:
        this.sendJson(res, 404, { error: `Unknown method: ${method}` });
    }
  }

  private handleRestartBridge(res: http.ServerResponse): void {
    // Respond immediately — the client polls /getBridgeStatus to see when
    // the new bridge is up. If we await the restart before responding, the
    // browser fetch can time out on slow Matter startup.
    this.sendJson(res, 202, { success: true, message: 'Restart initiated.' });
    getLogger().info('Restart requested via Web UI');
    this.deps.restartBridge().catch((err) => {
      getLogger().error(`Bridge restart failed: ${err}`);
    });
  }

  private getBridgeStatus() {
    const uptimeMs = Date.now() - this.startTime.getTime();
    const bridgeConfig = this.deps.getBridgeConfig();
    return {
      bridgeName: bridgeConfig.name,
      uptime: Math.floor(uptimeMs / 1000),
      ccuHost: this.deps.getCcuHost(),
      ccuConnected: this.deps.isCcuConnected(),
      matterPort: bridgeConfig.port,
      endpointCount: this.deps.getMatterEndpointCount(),
      deviceCount: this.deps.getDevices().size,
      passcode: bridgeConfig.passcode,
      discriminator: bridgeConfig.discriminator,
    };
  }

  private getDevices() {
    const { exposed, defaultExposed, tilt } = this.readExposureConfig();
    const devices: any[] = [];
    for (const [address, device] of this.deps.getDevices()) {
      const explicit = Object.prototype.hasOwnProperty.call(exposed, address);
      const tiltOverride = Object.prototype.hasOwnProperty.call(tilt, address)
        ? tilt[address]
        : null;
      devices.push({
        address,
        name: device.name,
        hmChannelType: device.hmChannelType,
        hmDeviceType: device.hmDeviceType,
        matterDeviceType: device.matterDeviceType,
        room: device.room || '',
        clusters: device.clusters,
        currentState: device.currentState,
        exposed: explicit ? !!exposed[address] : defaultExposed,
        exposedExplicit: explicit,
        hasTilt: !!device.hasTilt,
        tiltOverride,
      });
    }
    return { devices, count: devices.length, defaultExposed };
  }

  private readExposureConfig(): { exposed: Record<string, boolean>; defaultExposed: boolean; tilt: Record<string, boolean> } {
    try {
      const config = JSON.parse(fs.readFileSync(this.deps.configPath, 'utf-8'));
      return {
        exposed: config.devices?.exposed || {},
        defaultExposed: config.devices?.defaultExposed ?? false,
        tilt: config.devices?.tilt || {},
      };
    } catch {
      return { exposed: {}, defaultExposed: false, tilt: {} };
    }
  }

  /**
   * Tail the bridge log. Reads only the last 256 KB of the file (the log
   * grows unbounded on the CCU) and strips ANSI escape sequences from
   * winston's console colors and matter.js's diagnostic output.
   */
  private handleGetLog(req: http.IncomingMessage, res: http.ServerResponse): void {
    const file = this.deps.logFilePath;
    if (!file || !fs.existsSync(file)) {
      this.sendJson(res, 200, { lines: [], note: 'No log file configured (console logging only)' });
      return;
    }
    const query = url.parse(req.url || '', true).query;
    const wanted = Math.min(parseInt(String(query.lines || ''), 10) || 200, 1000);
    try {
      const stat = fs.statSync(file);
      const readBytes = Math.min(stat.size, 256 * 1024);
      const buf = Buffer.alloc(readBytes);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
      } finally {
        fs.closeSync(fd);
      }
      // eslint-disable-next-line no-control-regex
      const text = buf.toString('utf-8').replace(/\x1b\[[0-9;]*m/g, '');
      let lines = text.split('\n').filter((l) => l.trim() !== '');
      if (readBytes < stat.size && lines.length > 0) lines = lines.slice(1); // drop partial first line
      this.sendJson(res, 200, { lines: lines.slice(-wanted), size: stat.size });
    } catch (err) {
      this.sendJson(res, 500, { error: `Failed to read log: ${err}` });
    }
  }

  private writeConfigPatch(patch: (cfg: any) => void): void {
    let config: any = {};
    try {
      config = JSON.parse(fs.readFileSync(this.deps.configPath, 'utf-8'));
    } catch {
      // Start fresh if file doesn't exist
    }
    if (!config.devices) config.devices = {};
    patch(config);
    fs.writeFileSync(this.deps.configPath, JSON.stringify(config, null, 2));
  }

  private getChannels() {
    const channels: any[] = [];
    for (const [address, channel] of this.deps.getChannels()) {
      channels.push({
        address,
        type: channel.type,
        name: channel.name,
        room: channel.room || '',
        values: channel.paramsets?.VALUES || {},
      });
    }
    return { channels, count: channels.length };
  }

  private getSupportedTypes() {
    // Read from CHANNEL_TYPE_MAPPINGS keys via DeviceMapper
    const devices = this.deps.getDevices();
    const matterTypes = new Set<string>();
    for (const [, device] of devices) {
      matterTypes.add(device.matterDeviceType);
    }
    return { types: Array.from(matterTypes).sort() };
  }

  private getConfig() {
    try {
      const content = fs.readFileSync(this.deps.configPath, 'utf-8');
      const config = JSON.parse(content);
      return {
        filter: config.devices?.filter || { rooms: [], functions: [], include: [], exclude: [] },
        customMappings: config.devices?.customMappings || [],
        exposed: config.devices?.exposed || {},
        defaultExposed: config.devices?.defaultExposed ?? false,
      };
    } catch {
      return {
        filter: { rooms: [], functions: [], include: [], exclude: [] },
        customMappings: [],
        exposed: {},
        defaultExposed: false,
      };
    }
  }

  private handleSetDeviceExposed(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readJsonBody(req, res, (payload) => {
      const { address, exposed } = payload || {};
      if (typeof address !== 'string' || typeof exposed !== 'boolean') {
        this.sendJson(res, 400, { error: 'Expected {address: string, exposed: boolean}' });
        return;
      }
      this.writeConfigPatch((config) => {
        if (!config.devices.exposed) config.devices.exposed = {};
        config.devices.exposed[address] = exposed;
      });
      this.deps.setDeviceExposed(address, exposed)
        .then((changed) => {
          getLogger().info(`Device ${address} exposure set to ${exposed}${changed ? ' (applied live)' : ''}`);
          this.sendJson(res, 200, { success: true, message: changed ? 'Applied.' : 'Saved.' });
        })
        .catch((err) => {
          getLogger().error(`Live exposure toggle for ${address} failed: ${err}`);
          this.sendJson(res, 200, { success: true, message: 'Saved. Restart bridge to apply.' });
        });
    });
  }

  private handleSetDefaultExposed(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readJsonBody(req, res, (payload) => {
      const { defaultExposed } = payload || {};
      if (typeof defaultExposed !== 'boolean') {
        this.sendJson(res, 400, { error: 'Expected {defaultExposed: boolean}' });
        return;
      }
      this.writeConfigPatch((config) => { config.devices.defaultExposed = defaultExposed; });
      getLogger().info(`Default device exposure set to ${defaultExposed}. Restart required.`);
      this.sendJson(res, 200, { success: true, message: 'Saved. Restart bridge to apply.' });
    });
  }

  /**
   * Per-address tilt override for blind channels. `tilt` is a tri-state:
   *   true  → force venetian (expose Matter tilt cluster feature)
   *   false → force lift-only (hide tilt)
   *   null  → clear override, auto-detect from LEVEL_2
   *
   * Needed because HmIP-FBL always reports LEVEL_2 numeric even when the
   * physical install is a roller — firmware can't tell us.
   */
  private handleSetDeviceTilt(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.readJsonBody(req, res, (payload) => {
      const { address, tilt } = payload || {};
      if (typeof address !== 'string' || (tilt !== null && typeof tilt !== 'boolean')) {
        this.sendJson(res, 400, { error: 'Expected {address: string, tilt: boolean | null}' });
        return;
      }
      this.writeConfigPatch((config) => {
        if (!config.devices.tilt) config.devices.tilt = {};
        if (tilt === null) {
          delete config.devices.tilt[address];
        } else {
          config.devices.tilt[address] = tilt;
        }
      });
      getLogger().info(`Device ${address} tilt override set to ${tilt}. Restart required.`);
      this.sendJson(res, 200, { success: true, message: 'Saved. Restart bridge to apply.' });
    });
  }

  private readJsonBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (payload: any) => void
  ): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        handler(JSON.parse(body));
      } catch (err) {
        this.sendJson(res, 400, { error: `Invalid JSON: ${err}` });
      }
    });
  }

  private serveStatic(urlPath: string, res: http.ServerResponse): void {
    // Serve index.html for root
    if (urlPath === '/') {
      urlPath = '/index.html';
    }

    const filePath = path.resolve(this.staticDir, '.' + urlPath);

    // Path traversal protection
    if (!filePath.startsWith(this.staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  }
}
