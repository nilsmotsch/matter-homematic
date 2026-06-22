/**
 * Matter-Homematic Bridge - Main Entry Point
 *
 * A Matter bridge for Homematic CCU3/RaspberryMatic
 */

import { MatterHomematicBridge } from './bridge/MatterBridge';
import { WebServer } from './web/WebServer';
import { initLogger, getLogger } from './utils/Logger';
import { appVersion } from './utils/Version';
import * as fs from 'fs';
import * as path from 'path';
import { randomInt } from 'crypto';

// When running as a CCU/RaspberryMatic addon, the rc.d script sets
// MATTER_HOMEMATIC_DATA_DIR to a path that survives firmware and addon
// updates (e.g. /usr/local/etc/config/addons/matter-homematic). Config,
// Matter fabric, and logs all live there.
const DATA_DIR = process.env.MATTER_HOMEMATIC_DATA_DIR;

function buildDefaultConfig() {
  return {
    bridge: {
      name: "Matter-Homematic",
      port: 5540,
      passcode: 20242024,
      discriminator: 3840,
      vendorId: 0xFFF1,  // Test vendor ID
      productId: 0x8001,
      storagePath: DATA_DIR
        ? path.join(DATA_DIR, '.matter-homematic')
        : "./.matter-homematic",
      // Prefer IPv4 for operational Matter traffic. matter.js otherwise always
      // tries a controller's IPv6 address first (link-local, then global). On a
      // CCU whose LAN/router gives it no usable global IPv6 route, reports and
      // invoke confirmations sent to a controller's global IPv6 silently time
      // out — so commands appear to "fail" in Alexa even though they executed.
      // Defaults on for the addon (the CCU is the affected environment);
      // standalone installs with healthy IPv6 leave it off. Consumed by the
      // patched MdnsClient address sort via MATTER_HM_PREFER_IPV4.
      preferIpv4: !!DATA_DIR,
      // Optional: limit Matter mDNS to one interface (matterbridge's
      // -mdnsinterface). Empty = all interfaces. Set e.g. "eth0" if NodeJS
      // picks the wrong one on a multi-homed host.
      mdnsInterface: ""
    },
    ccu: {
      // As an addon the bridge runs on the CCU itself; standalone, the user
      // must point it at their CCU.
      host: DATA_DIR ? "127.0.0.1" : "192.168.1.100",
      interfaces: {
        "BidCos-RF": { enabled: true, port: 2001 },
        "HmIP-RF": { enabled: true, port: 2010 },
        "VirtualDevices": { enabled: false, port: 9292 },
        // shelly-homematic addon's virtual interface (Shelly devices as HM)
        "ShellyHM": { enabled: false, port: 2121 }
      },
      callbackPort: 9875,
      regaPort: 80,
      // Actual credentials come from CCU_USER / CCU_PASSWORD env vars —
      // never put real secrets here.
      user: "",
      password: ""
    },
    devices: {
      defaultExposed: false,
      exposed: {} as Record<string, boolean>
    },
    systemVariables: {
      // Opt-in per ReGa id (the Web UI's System Variables tab toggles these).
      exposed: {} as Record<string, boolean>
    },
    web: {
      // The CCU WebUI tile redirects to :8080, so we enable the web UI
      // by default when running as an addon.
      enabled: !!DATA_DIR,
      port: 8080
    },
    logging: {
      level: "info",
      file: DATA_DIR ? path.join(DATA_DIR, 'matter-homematic.log') : ""
    }
  };
}

const DEFAULT_CONFIG = buildDefaultConfig();

function resolveConfigPath(): string {
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  if (DATA_DIR) return path.join(DATA_DIR, 'config.json');
  return './config.json';
}

// Matter spec 5.1.7.1: setup passcodes are 00000001–99999998 minus a
// blocklist of trivially guessable values (00000000/99999999 fall outside
// the randomInt range already).
const INVALID_PASSCODES = new Set([
  11111111, 22222222, 33333333, 44444444, 55555555,
  66666666, 77777777, 88888888, 12345678, 87654321,
]);

function randomPasscode(): number {
  for (;;) {
    const passcode = randomInt(1, 99999999);
    if (!INVALID_PASSCODES.has(passcode)) return passcode;
  }
}

// 12-bit discriminator (Matter spec 5.1.1.5)
function randomDiscriminator(): number {
  return randomInt(0, 4096);
}

/**
 * On first run inside an addon install, seed config.json from the bundled
 * config.example.json so the user has something editable in the WebUI.
 * Path-flavored fields (storagePath, logging.file) are stripped so the
 * DATA_DIR-aware defaults apply instead.
 */
function seedAddonConfigIfMissing(configPath: string): void {
  if (!DATA_DIR || fs.existsSync(configPath)) return;
  const example = path.resolve(__dirname, '..', 'config.example.json');
  if (!fs.existsSync(example)) return;
  try {
    const seed = JSON.parse(fs.readFileSync(example, 'utf-8'));
    if (seed.bridge) delete seed.bridge.storagePath;
    if (seed.logging) delete seed.logging.file;
    seed.web = { ...(seed.web || {}), enabled: true };
    // Running as an addon means running on the CCU — talk to it locally
    // instead of the example's placeholder IP.
    seed.ccu = { ...(seed.ccu || {}), host: '127.0.0.1' };
    // Each install/factory reset gets a fresh commissioning identity: the
    // example's fixed passcode is guessable, and reusing the previous
    // identity collides with stale accessory caches in controllers that
    // paired the old fabric ("Accessory not found" in Apple Home).
    seed.bridge = {
      ...(seed.bridge || {}),
      passcode: randomPasscode(),
      discriminator: randomDiscriminator(),
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(seed, null, 2));
    getLogger().info(`Seeded config at ${configPath} (discriminator ${seed.bridge.discriminator})`);
  } catch (err) {
    getLogger().error(`Failed to seed config at ${configPath}: ${err}`);
  }
}

/**
 * Merge file config over defaults, one level deep so users can override
 * individual fields without blowing away the rest of a section.
 */
function mergeConfig(
  defaults: typeof DEFAULT_CONFIG,
  override: Partial<typeof DEFAULT_CONFIG>
): typeof DEFAULT_CONFIG {
  const merged: any = { ...defaults };
  for (const key of Object.keys(override) as (keyof typeof DEFAULT_CONFIG)[]) {
    const a = (defaults as any)[key];
    const b = (override as any)[key];
    if (a && typeof a === 'object' && !Array.isArray(a) && b && typeof b === 'object' && !Array.isArray(b)) {
      merged[key] = { ...a, ...b };
    } else if (b !== undefined) {
      merged[key] = b;
    }
  }
  return merged;
}

/**
 * Load configuration from file or use defaults
 */
function loadConfig(): typeof DEFAULT_CONFIG {
  const log = getLogger();
  const configPath = resolveConfigPath();
  seedAddonConfigIfMissing(configPath);

  if (fs.existsSync(configPath)) {
    try {
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const fileConfig = JSON.parse(fileContent);
      log.info(`Loaded configuration from ${configPath}`);
      return mergeConfig(DEFAULT_CONFIG, fileConfig);
    } catch (err) {
      log.error(`Failed to load config from ${configPath}: ${err}`);
    }
  }

  log.info('Using default configuration');
  return DEFAULT_CONFIG;
}

/**
 * Parse command line arguments
 */
function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      args[key] = value || 'true';
    }
  }

  return args;
}

/**
 * Main function
 */
async function main(): Promise<void> {
  // Parse arguments first to check for --help
  const args = parseArgs();

  if (args.help) {
    console.log('Usage: matter-homematic [options]');
    console.log('');
    console.log('Options:');
    console.log('  --config=PATH     Path to configuration file');
    console.log('  --ccu=HOST        CCU IP address');
    console.log('  --port=PORT       Matter port (default: 5540)');
    console.log('  --passcode=CODE   Pairing passcode (default: random, seeded at install)');
    console.log('  --help            Show this help');
    console.log('');
    process.exit(0);
  }

  // Load configuration
  if (args.config) {
    process.env.CONFIG_PATH = args.config;
  }

  // Initialize logging with the environment-derived defaults *before*
  // loading config, so even the config-loading messages go to the right
  // place (as a daemon, a premature console logger would write colored
  // lines into the redirected log file).
  initLogger(DEFAULT_CONFIG.logging);
  const config = loadConfig();

  // Re-init in case the loaded config overrides logging settings
  initLogger(config.logging);
  const log = getLogger();

  log.info('╔═══════════════════════════════════════════╗');
  log.info(`║  Matter-Homematic Bridge v${appVersion()}`.padEnd(44) + '║');
  log.info('║  Expose Homematic devices via Matter      ║');
  log.info('╚═══════════════════════════════════════════╝');

  // Override with command line arguments
  if (args.ccu) {
    config.ccu.host = args.ccu;
  }
  if (args.port) {
    config.bridge.port = parseInt(args.port, 10);
  }
  if (args.passcode) {
    config.bridge.passcode = parseInt(args.passcode, 10);
  }

  // CCU WebUI credentials come from the environment — never put them in
  // config.json so config files can be committed/shared safely.
  if (process.env.CCU_USER) config.ccu.user = process.env.CCU_USER;
  if (process.env.CCU_PASSWORD) config.ccu.password = process.env.CCU_PASSWORD;

  log.info(`CCU Host: ${config.ccu.host}`);
  log.info(`Matter Port: ${config.bridge.port}`);

  // Tell the patched matter.js mDNS resolver to rank IPv4 ahead of IPv6 when
  // choosing a controller's operational address (see bridge.preferIpv4). Must
  // be set before the bridge opens its Matter sockets.
  if (config.bridge.preferIpv4) {
    process.env.MATTER_HM_PREFER_IPV4 = '1';
    log.info('Operational address preference: IPv4 first (preferIpv4)');
  }

  // Hold the bridge instance in a mutable ref so the Web UI can replace it
  // during restart while the web server stays alive.
  const bridgeRef: { bridge: MatterHomematicBridge } = {
    bridge: new MatterHomematicBridge(config),
  };
  let webServer: WebServer | undefined;

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    if (webServer) await webServer.stop();
    await bridgeRef.bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Log uncaught errors but keep the process alive so the web UI stays reachable
  // (matter.js sometimes throws from deep async stacks during device add errors)
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.message}`);
    log.error(err.stack || '');
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason}`);
  });

  const restartBridge = async (beforeReload?: () => void): Promise<void> => {
    log.info('Restarting bridge in-process...');
    try {
      await bridgeRef.bridge.stop();
    } catch (err) {
      log.error(`Error stopping bridge: ${err}`);
    }
    // Runs while the bridge is fully down — factory reset deletes config
    // and Matter storage here (deleting storage under a live matter.js
    // node makes its commits fail and aborts the shutdown half-way).
    beforeReload?.();
    const freshConfig = loadConfig();
    if (args.ccu) freshConfig.ccu.host = args.ccu;
    if (args.port) freshConfig.bridge.port = parseInt(args.port, 10);
    if (args.passcode) freshConfig.bridge.passcode = parseInt(args.passcode, 10);
    bridgeRef.bridge = new MatterHomematicBridge(freshConfig);
    await bridgeRef.bridge.start();
    log.info('Bridge restarted.');
  };

  // Start web UI first (if enabled) so it stays available even if bridge startup fails
  if (config.web?.enabled) {
    const configPath = resolveConfigPath();
    webServer = new WebServer(config.web.port || 8080, {
      getDevices: () => bridgeRef.bridge.getDeviceMapper().getAllMappedDevices(),
      getChannels: () => bridgeRef.bridge.getCcuConnector().getChannels(),
      isDiscoveryComplete: () => bridgeRef.bridge.getCcuConnector().isDiscoveryComplete(),
      isCcuConnected: () => bridgeRef.bridge.getCcuConnector().isConnected(),
      getMatterEndpointCount: () => bridgeRef.bridge.getMatterEndpointCount(),
      getBridgeConfig: () => bridgeRef.bridge.getBridgeConfig(),
      getCcuHost: () => bridgeRef.bridge.getCcuHost(),
      getCcuInterfaces: () => bridgeRef.bridge.getCcuInterfaces(),
      configPath,
      storagePath: config.bridge.storagePath,
      restartBridge,
      setDeviceExposed: (address, exposed) => bridgeRef.bridge.setDeviceExposed(address, exposed),
      getSystemVariables: () => bridgeRef.bridge.getSystemVariables(),
      setSystemVariableExposed: (id, exposed) => bridgeRef.bridge.setSystemVariableExposed(id, exposed),
      getPairingInfo: () => bridgeRef.bridge.getPairingInfo(),
      logFilePath: config.logging?.file || '',
    });
    try {
      await webServer.start();
    } catch (err) {
      log.error(`Failed to start web server: ${err}`);
    }
  }

  try {
    await bridgeRef.bridge.start();
  } catch (err) {
    log.error(`Failed to start bridge: ${err}`);
    process.exit(1);
  }
}

// Run
main().catch(err => {
  const log = getLogger();
  log.error(`Fatal error: ${err}`);
  process.exit(1);
});
