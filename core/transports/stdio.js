/**
 * Stdio transport
 * One server instance bound to the process standard streams, the transport a
 * parent process spawns when it embeds a server as a child
 */

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const MCPServer = require('../server-core');

/**
 * Start the server on stdio
 * @param {object} server - Bundle returned by the registry
 */
function start(server) {
	const { config, toolsModule, promptsModule, log } = server;

	const mcpServer = new MCPServer(config, toolsModule, promptsModule);
	mcpServer.setupSignalHandlers();

	log('Starting stdio transport');
	log(`Tools available: ${mcpServer.toolsDefinitions.length}`);
	log(`Prompts available: ${mcpServer.promptsDefinitions.length}`);

	mcpServer.getServer().connect(new StdioServerTransport());
}

module.exports = { start };
