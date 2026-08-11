/**
 * Server registry
 * Aggregates every server under servers/ into the single bundle a transport
 * binds to, so one endpoint carries the tools and prompts of them all
 * A server directory holds config.json, tools.json and lib/tools.js, so adding
 * a server never touches the core
 *
 * The two configuration files hold disjoint things: the root config.json owns
 * the transport, the credentials and the identity the aggregate answers with,
 * a server config.json owns its prompts and its own settings block
 *
 * Two servers exposing the same tool or prompt name is a mistake in naming, and
 * the registry says so at startup rather than picking a winner
 */

const fs = require('fs');
const path = require('path');
const { createPromptsModule } = require('./prompts');

const SERVERS_DIR = path.join(__dirname, '..', 'servers');
const ROOT_CONFIG = path.join(__dirname, '..', 'config.json');
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
 * Load every server, aggregated into one bundle ready to be handed to a
 * transport
 * The logger carries the configured server name so transports stay generic
 * @returns {{names: string[], config: object, toolsModule: object, promptsModule: object, log: function}}
 */
function loadServers() {
	const names = listServers();
	if (names.length === 0) {
		throw new Error(`No server found in ${SERVERS_DIR}`);
	}

	const config = require(ROOT_CONFIG);

	const definitions = [];
	const mapping = {};
	const prompts = [];
	const toolOwner = {};
	const promptOwner = {};

	for (const name of names) {
		const dir = path.join(SERVERS_DIR, name);
		if (!fs.existsSync(path.join(dir, 'config.json'))) {
			throw new Error(`Server "${name}" has no config.json in ${dir}`);
		}

		const serverConfig = require(path.join(dir, 'config.json'));
		const toolsModule = require(path.join(dir, 'lib', 'tools.js'));

		for (const definition of toolsModule.TOOLS_DEFINITIONS) {
			if (toolOwner[definition.name]) {
				throw new Error(
					`Tool "${definition.name}" is exposed by both "${toolOwner[definition.name]}" and "${name}"`
				);
			}
			toolOwner[definition.name] = name;
			definitions.push(definition);
		}

		for (const [tool, handler] of Object.entries(toolsModule.TOOLS_MAPPING)) {
			mapping[tool] = handler;
		}

		for (const prompt of serverConfig.prompts || []) {
			if (promptOwner[prompt.name]) {
				throw new Error(
					`Prompt "${prompt.name}" is declared by both "${promptOwner[prompt.name]}" and "${name}"`
				);
			}
			promptOwner[prompt.name] = name;
			prompts.push(prompt);
		}
	}

	const label = `[${config.mcp.serverName}]`;

	return {
		names,
		config,
		toolsModule: { TOOLS_DEFINITIONS: definitions, TOOLS_MAPPING: mapping },
		promptsModule: createPromptsModule({ prompts }),
		log: (message) => console.error(`${label} ${message}`)
	};
}

module.exports = { listServers, loadServers };
