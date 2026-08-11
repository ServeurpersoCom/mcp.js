#!/usr/bin/env node
/**
 * Launcher
 * Binds every server from servers/ to one transport from core/transports/
 * Usage : node main.js [transport]
 */

const { loadServers } = require('./core/registry');

const TRANSPORTS = ['stdio', 'streamable-http', 'websocket'];
const DEFAULT_TRANSPORT = 'stdio';

const [transportName = DEFAULT_TRANSPORT] = process.argv.slice(2);

function usage(message) {
	console.error(`[Launcher] ${message}`);
	console.error('[Launcher] Usage: node main.js [transport]');
	console.error(`[Launcher] Transports: ${TRANSPORTS.join(', ')} (default ${DEFAULT_TRANSPORT})`);
	process.exit(1);
}

if (!TRANSPORTS.includes(transportName)) {
	usage(`Unknown transport "${transportName}"`);
}

let server;
try {
	server = loadServers();
} catch (error) {
	usage(error.message);
}

require(`./core/transports/${transportName}`).start(server);
