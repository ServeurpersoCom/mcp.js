/**
 * MCP server core
 * Builds the low level Server of the v2 SDK over the aggregated tools and
 * prompts. Every transport serves instances from one factory: a fresh one per
 * HTTP request, one per stdio connection, so no state outlives its exchange
 *
 * A call reaches its handler only once its arguments pass the law of its
 * schema, so a refusal reads the same for every tool of every server
 */

const { Server } = require('@modelcontextprotocol/server');
const { breach } = require('./tool-check');

// The notification a call streams its output by while it runs, to a client
// whose request declares partialResults among its capabilities and names a
// partialResultToken (SEP-2998)
const PARTIAL_RESULT = 'notifications/tools/partial_result';
const CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

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
 * What a handler shows of its output while it runs, when the request asks for
 * partial results: each text goes to the client as the next partial result of
 * the call; none when it asks nothing, so the handler streams nothing; the
 * result the handler returns stays whole
 * @param {object} request The tools/call request
 * @param {object} ctx Its context
 * @returns {function(string): void | undefined}
 */
function partials(request, ctx) {
	const token = request.params._meta?.partialResultToken;
	const capabilities = ctx.mcpReq.envelope?.[CAPABILITIES_META];
	if (token === undefined || !capabilities?.partialResults) {
		return undefined;
	}
	let seq = 0;
	return (text) => {
		const params = { partialResultToken: token, seq: seq++, content: [{ type: 'text', text }] };
		ctx.mcpReq.notify({ method: PARTIAL_RESULT, params }).catch(() => {});
	};
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
	const schemas = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
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

		server.setRequestHandler('tools/call', async (request, ctx) => {
			const { name, arguments: args } = request.params;
			if (!handlers[name]) {
				throw new Error(`Unknown tool: ${name}`);
			}
			const refused = breach(schemas[name], args ?? {});
			if (refused) {
				return { content: [{ type: 'text', text: refused }], isError: true };
			}

			let result;
			try {
				result = await handlers[name](args ?? {}, partials(request, ctx), ctx.mcpReq.signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Tool execution failed: ${message}`);
			}

			// A tool returns one typed result or a list of them, one content block each
			const results = Array.isArray(result) ? result : [result];
			if (
				results.length === 0 ||
				results.some((item) => !item || typeof item !== 'object' || !item.type)
			) {
				throw new Error('Tool returned invalid result. Expected typed objects.');
			}

			return {
				content: results.map(contentBlock),
				isError: results.some((item) => item.isError)
			};
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
