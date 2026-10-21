/**
 * MCP server core
 * Builds the low level Server of the v2 SDK over the aggregated tools and
 * prompts. Every transport serves instances from one factory: a fresh one per
 * HTTP request, one per stdio connection, so no state outlives its exchange
 */

const { Server } = require('@modelcontextprotocol/server');

/**
 * Content block of a typed tool result
 * @param {{type: string, text?: string, data?: string, mimeType?: string}} result
 * @returns {object}
 */
function contentBlock(result) {
	if (result.type === 'text') {
		return {
			type: 'text',
			text: typeof result.text === 'string' ? result.text : JSON.stringify(result.text ?? '')
		};
	}

	if (result.type === 'image') {
		return {
			type: 'image',
			data: typeof result.data === 'string' ? result.data : '',
			mimeType: result.mimeType || 'application/octet-stream'
		};
	}

	throw new Error(`Unsupported tool result type: ${result.type}`);
}

/**
 * Factory of servers for one bundle, the identity of the aggregate riding
 * into initialize on 2025 connections and into result _meta on 2026 ones
 * @param {object} bundle Bundle returned by the registry
 * @returns {function(): Server}
 */
function createFactory(bundle) {
	const { config, toolsModule, promptsModule } = bundle;
	const tools = toolsModule.TOOLS_DEFINITIONS;
	const handlers = toolsModule.TOOLS_MAPPING;
	const prompts = promptsModule.PROMPTS_DEFINITIONS;
	const templates = promptsModule.PROMPTS_MAPPING;

	const info = {
		name: config.mcp.serverName,
		version: config.mcp.serverVersion,
		...(config.mcp.serverIcons && { icons: config.mcp.serverIcons })
	};
	const capabilities = prompts.length > 0 ? { tools: {}, prompts: {} } : { tools: {} };

	return () => {
		const server = new Server(info, { capabilities });

		server.setRequestHandler('tools/list', async () => ({ tools }));

		server.setRequestHandler('tools/call', async (request) => {
			const { name, arguments: args } = request.params;
			if (!handlers[name]) {
				throw new Error(`Unknown tool: ${name}`);
			}

			let result;
			try {
				result = await handlers[name](args ?? {});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Tool execution failed: ${message}`);
			}
			if (!result || typeof result !== 'object' || !result.type) {
				throw new Error('Tool returned invalid result. Expected typed object.');
			}

			return { content: [contentBlock(result)], isError: Boolean(result.isError) };
		});

		if (prompts.length === 0) {
			return server;
		}

		server.setRequestHandler('prompts/list', async () => ({ prompts }));

		server.setRequestHandler('prompts/get', async (request) => {
			const { name, arguments: values } = request.params;
			const prompt = templates[name];
			if (!prompt) {
				throw new Error(`Unknown prompt: ${name}`);
			}

			// {{key}} placeholders of a text message take the value of the argument key
			const messages = prompt.messages.map((msg) => {
				if (msg.content?.type !== 'text' || !values) {
					return msg;
				}
				let text = msg.content.text;
				for (const [key, value] of Object.entries(values)) {
					text = text.split(`{{${key}}}`).join(value);
				}
				return { role: msg.role, content: { type: 'text', text } };
			});

			return { description: prompt.description, messages };
		});

		return server;
	};
}

module.exports = { createFactory };
