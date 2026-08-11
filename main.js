#!/usr/bin/env node
/**
 * Launcher
 * Binds one server from servers/ to one transport from core/transports/
 * Usage : node main.js <server> [transport]
 */

const { listServers, loadServer } = require('./core/registry');

const TRANSPORTS = ['stdio', 'streamable-http', 'websocket'];
const DEFAULT_TRANSPORT = 'stdio';

const [serverName, transportName = DEFAULT_TRANSPORT] = process.argv.slice(2);

function usage(message) {
	console.error(`[Launcher] ${message}`);
	console.error('[Launcher] Usage: node main.js <server> [transport]');
	console.error(`[Launcher] Servers: ${listServers().join(', ')}`);
	console.error(`[Launcher] Transports: ${TRANSPORTS.join(', ')} (default ${DEFAULT_TRANSPORT})`);
	process.exit(1);
}

if (!serverName) {
	usage('No server given');
}

if (!TRANSPORTS.includes(transportName)) {
	usage(`Unknown transport "${transportName}"`);
}

let server;
try {
	server = loadServer(serverName);
} catch (error) {
	usage(error.message);
}

require(`./core/transports/${transportName}`).start(server);
