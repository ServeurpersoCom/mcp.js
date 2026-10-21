/**
 * Stdio transport
 * The process standard streams, the transport a parent process spawns when it
 * embeds a server as a child. The opening exchange selects the era of the
 * connection, 2026-07-28 or a 2025 revision, and pins one server to it
 */

const { serveStdio } = require('@modelcontextprotocol/server/stdio');
const { createFactory } = require('../server-core');

/**
 * Start the server on stdio
 * @param {object} server Bundle returned by the registry
 */
function start(server) {
	const { toolsModule, promptsModule, log } = server;

	log('Starting stdio transport');
	log(`Tools available: ${toolsModule.TOOLS_DEFINITIONS.length}`);
	log(`Prompts available: ${promptsModule.PROMPTS_DEFINITIONS.length}`);

	serveStdio(createFactory(server));
}

module.exports = { start };
