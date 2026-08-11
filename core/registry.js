/**
 * Server registry
 * Resolves a server by name under servers/, loads its configuration, its tools
 * module and the prompts built from that configuration
 * A server directory holds config.json, tools.json and lib/tools.js, so adding
 * a server never touches the core
 *
 * The configuration is the root config.json overridden by the one of the server,
 * section by section, so credentials and protocol settings are written once and
 * a server only carries what makes it itself
 */

const fs = require('fs');
const path = require('path');
const { createPromptsModule } = require('./prompts');

const SERVERS_DIR = path.join(__dirname, '..', 'servers');
const ROOT_CONFIG = path.join(__dirname, '..', 'config.json');
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Merge a server configuration over the root defaults
 * Sections merge key by key, anything else is replaced, so a server never
 * inherits half of an array such as prompts or serverIcons
 * @param {object} defaults - Root configuration
 * @param {object} overrides - Server configuration
 * @returns {object}
 */
function mergeConfig(defaults, overrides) {
	const merged = { ...defaults };

	for (const [key, value] of Object.entries(overrides)) {
		const base = merged[key];
		const isSection = (candidate) =>
			candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);

		merged[key] = isSection(base) && isSection(value) ? { ...base, ...value } : value;
	}

	return merged;
}

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

	const defaults = fs.existsSync(ROOT_CONFIG) ? require(ROOT_CONFIG) : {};
	const config = mergeConfig(defaults, require(path.join(dir, 'config.json')));
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
