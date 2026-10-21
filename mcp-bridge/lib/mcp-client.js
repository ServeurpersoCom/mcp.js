/**
 * MCP Client wrapper using the v2 client SDK
 * Manages multiple MCP servers over stdio or Streamable HTTP, each connection
 * negotiating its era: 2026-07-28 when the server speaks it, else 2025
 */

const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const path = require('path');

// Stdio children inherit this working directory, so the command and args in
// config.json are relative to the repository root, not to the launch directory
const ROOT_DIR = path.join(__dirname, '..', '..');

class MCPClient {
	constructor(config) {
		if (!config || !config.servers) {
			throw new Error('MCPClient requires config.servers');
		}

		this.config = config;
		this.clients = new Map(); // serverName -> { client, tools }
	}

	/**
	 * Initialize all MCP servers
	 */
	async initialize() {
		console.log('[MCP] Initializing MCP servers...');

		for (const [name, serverConfig] of Object.entries(this.config.servers)) {
			console.log(`[MCP] Connecting to server "${name}"...`);

			const transport = this._createTransport(name, serverConfig);
			const client = new Client(
				{
					name: 'llama-mcp-bridge',
					version: '1.0.0'
				},
				{ versionNegotiation: { mode: 'auto' } }
			);

			await client.connect(transport);

			// List tools
			const toolsResponse = await client.listTools();
			const tools = toolsResponse.tools || [];

			this.clients.set(name, { client, tools });

			console.log(`[MCP] Server "${name}" connected (${tools.length} tools)`);
		}

		const totalTools = Array.from(this.clients.values()).reduce(
			(sum, { tools }) => sum + tools.length,
			0
		);
		console.log(`[MCP] Total tools discovered: ${totalTools}`);
	}

	/**
	 * Execute tool call (OpenAI format)
	 */
	async execute(toolCall) {
		const toolName = toolCall.function.name;

		// Find server that has this tool
		let targetServer = null;
		for (const [serverName, { tools }] of this.clients) {
			if (tools.some((t) => t.name === toolName)) {
				targetServer = serverName;
				break;
			}
		}

		if (!targetServer) {
			throw new Error(`Tool "${toolName}" not found in any MCP server`);
		}

		// Parse arguments
		let args = toolCall.function.arguments;
		if (typeof args === 'string') {
			try {
				args = JSON.parse(args);
			} catch (e) {
				throw new Error(`Failed to parse tool arguments: ${e.message}`);
			}
		}

		// Call tool via SDK
		const { client } = this.clients.get(targetServer);
		const response = await client.callTool({
			name: toolName,
			arguments: args
		});

		// Extract content from MCP response
		if (response && response.content) {
			const contentItems = Array.isArray(response.content) ? response.content : [response.content];

			const flattened = contentItems
				.map((item) => {
					if (item == null) return '';
					if (typeof item === 'string') return item;
					if (typeof item === 'object') {
						if (item.type === 'text' && typeof item.text === 'string') {
							return item.text;
						}
						if (item.type === 'resource' && item.resource) {
							if (typeof item.resource.text === 'string') {
								return item.resource.text;
							}
							return JSON.stringify(item.resource);
						}
						if (item.type === 'image' && item.data) {
							const mimeType = item.mimeType || 'application/octet-stream';
							return `data:${mimeType};base64,${item.data}`;
						}
						if (typeof item.text === 'string') {
							return item.text;
						}
						return JSON.stringify(item);
					}
					return String(item);
				})
				.filter(Boolean)
				.join('\n');

			if (flattened) {
				return flattened;
			}
		}

		return '';
	}

	/**
	 * Get OpenAI-compatible tools definition
	 */
	async getToolsDefinition() {
		const tools = [];

		for (const [serverName, { tools: serverTools }] of this.clients) {
			for (const tool of serverTools) {
				tools.push({
					type: 'function',
					function: {
						name: tool.name,
						description: tool.description,
						parameters: tool.inputSchema || {
							type: 'object',
							properties: {},
							required: []
						}
					}
				});
			}
		}

		return tools;
	}

	/**
	 * List all tool names
	 */
	listTools() {
		const names = [];
		for (const { tools } of this.clients.values()) {
			names.push(...tools.map((t) => t.name));
		}
		return names;
	}

	/**
	 * Shutdown all servers
	 */
	async shutdown() {
		console.log('[MCP] Shutting down all servers...');
		for (const [name, { client }] of this.clients) {
			await client.close();
			console.log(`[MCP] Server "${name}" stopped`);
		}
	}

	// Private methods

	// A server with a command runs as a stdio child, one with a url is reached
	// over Streamable HTTP, its headers sent with every request
	_createTransport(serverName, serverConfig) {
		if (serverConfig.command) {
			return new StdioClientTransport({
				command: serverConfig.command,
				args: serverConfig.args || [],
				env: serverConfig.env,
				cwd: ROOT_DIR
			});
		}

		if (serverConfig.url) {
			const url = new URL(serverConfig.url);
			console.log(`[MCP] Creating Streamable HTTP transport for ${serverName} (${url.href})`);
			return new StreamableHTTPClientTransport(url, {
				requestInit: serverConfig.headers ? { headers: serverConfig.headers } : {}
			});
		}

		throw new Error(`Server "${serverName}" needs a command or a url`);
	}
}

module.exports = MCPClient;
