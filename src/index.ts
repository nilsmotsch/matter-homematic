/**
 * Matter-Homematic Bridge - Main Entry Point
 *
 * A Matter bridge for Homematic CCU3/RaspberryMatic
 */

import { MatterHomematicBridge } from './bridge/MatterBridge';
import { initLogger, getLogger } from './utils/Logger';
import * as fs from 'fs';

// Default configuration
const DEFAULT_CONFIG = {
  bridge: {
    name: "Matter-Homematic",
    port: 5540,
    passcode: 20242024,
    discriminator: 3840,
    vendorId: 0xFFF1,  // Test vendor ID
    productId: 0x8001,
    storagePath: "./.matter-homematic"
  },
  ccu: {
    host: "192.168.1.100",  // <-- Change this to your CCU IP
    interfaces: {
      "BidCos-RF": { enabled: true, port: 2001 },
      "HmIP-RF": { enabled: true, port: 2010 },
      "VirtualDevices": { enabled: false, port: 9292 }
    },
    callbackPort: 9875
  },
  logging: {
    level: "info",
    file: ""
  }
};

/**
 * Load configuration from file or use defaults
 */
function loadConfig(): typeof DEFAULT_CONFIG {
  const log = getLogger();
  const configPath = process.env.CONFIG_PATH || './config.json';

  if (fs.existsSync(configPath)) {
    try {
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const fileConfig = JSON.parse(fileContent);
      log.info(`Loaded configuration from ${configPath}`);
      return { ...DEFAULT_CONFIG, ...fileConfig };
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

  const config = loadConfig();

  // Re-init logger with config settings
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

  log.info(`CCU Host: ${config.ccu.host}`);
  log.info(`Matter Port: ${config.bridge.port}`);

  // Create and start bridge
  const bridge = new MatterHomematicBridge(config);

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
    await bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await bridge.start();
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
