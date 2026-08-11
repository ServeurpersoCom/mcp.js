/**
 * Server registry
 * Resolves a server by name under servers/, loads its configuration, its tools
 * module and the prompts built from that configuration
 * A server directory holds config.json, tools.json and lib/tools.js, so adding
 * a server never touches the core
 */

const fs = require('fs');
const path = require('path');
const { createPromptsModule } = require('./prompts');

const SERVERS_DIR = path.join(__dirname, '..', 'servers');
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * List the server names available under servers/
 * @returns {string[]}
 */
function listServers() {
	return fs
		.readdirSync(SERVERS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && NAME_PATTERN.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

/**
 * Load a server bundle ready to be handed to a transport
 * The logger carries the configured server name so transports stay generic
 * @param {string} name - Directory name under servers/
 * @returns {{name: string, dir: string, config: object, toolsModule: object, promptsModule: object, log: function}}
 */
function loadServer(name) {
	if (!NAME_PATTERN.test(name || '')) {
		throw new Error(`Invalid server name "${name}"`);
	}

	const dir = path.join(SERVERS_DIR, name);
	if (!fs.existsSync(path.join(dir, 'config.json'))) {
		throw new Error(`Server "${name}" has no config.json in ${dir}`);
	}

	const config = require(path.join(dir, 'config.json'));
	const toolsModule = require(path.join(dir, 'lib', 'tools.js'));
	const promptsModule = createPromptsModule(config);
	const label = `[${config.mcp.serverName}]`;

	return {
		name,
		dir,
		config,
		toolsModule,
		promptsModule,
		log: (message) => console.error(`${label} ${message}`)
	};
}

module.exports = { listServers, loadServer };
