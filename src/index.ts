/**
 * Matter-Homematic Bridge - Main Entry Point
 *
 * A Matter bridge for Homematic CCU3/RaspberryMatic
 */

import { MatterHomematicBridge } from './bridge/MatterBridge';
import { WebServer } from './web/WebServer';
import { initLogger, getLogger } from './utils/Logger';
import * as fs from 'fs';
import * as path from 'path';

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
        : "./.matter-homematic"
    },
    ccu: {
      // As an addon the bridge runs on the CCU itself; standalone, the user
      // must point it at their CCU.
      host: DATA_DIR ? "127.0.0.1" : "192.168.1.100",
      interfaces: {
        "BidCos-RF": { enabled: true, port: 2001 },
        "HmIP-RF": { enabled: true, port: 2010 },
        "VirtualDevices": { enabled: false, port: 9292 }
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
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(seed, null, 2));
    getLogger().info(`Seeded config at ${configPath}`);
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
    console.log('  --passcode=CODE   Pairing passcode (default: 20242024)');
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
  log.info('║       Matter-Homematic Bridge v1.0        ║');
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

  const restartBridge = async (): Promise<void> => {
    log.info('Restarting bridge in-process...');
    try {
      await bridgeRef.bridge.stop();
    } catch (err) {
      log.error(`Error stopping bridge: ${err}`);
    }
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
      isCcuConnected: () => bridgeRef.bridge.getCcuConnector().isConnected(),
      getMatterEndpointCount: () => bridgeRef.bridge.getMatterEndpointCount(),
      getBridgeConfig: () => bridgeRef.bridge.getBridgeConfig(),
      getCcuHost: () => bridgeRef.bridge.getCcuHost(),
      configPath,
      restartBridge,
      setDeviceExposed: (address, exposed) => bridgeRef.bridge.setDeviceExposed(address, exposed),
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
