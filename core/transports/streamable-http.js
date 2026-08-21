/**
 * Streamable HTTP transport
 * One server instance and one transport per POST, so a JSON-RPC id maps to the
 * stream of its own request and to nothing else, guarded by the OAuth module
 * built from the server configuration
 * The endpoint carries no session: an Mcp-Session-Id sent by a client is
 * ignored, GET and DELETE answer 405, and a restart stays invisible to clients
 */

const http = require('http');
const {
	StreamableHTTPServerTransport
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const MCPServer = require('../server-core');
const { createOAuth } = require('../oauth');

const sendJsonError = (res, status, code, message, headers = {}) => {
	res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
	res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
};

// One log line per POST, method and id only, arguments stay out of the log
const describe = (message) => {
	const first = Array.isArray(message) ? message[0] : message;
	return `${first?.method ?? 'message'} id=${first?.id ?? '-'}`;
};

/**
 * Start the server on Streamable HTTP
 * @param {object} server - Bundle returned by the registry
 */
function start(server) {
	const { config, toolsModule, promptsModule, log } = server;
	const oauth = createOAuth(config);
	const { host, port } = config.streamable_http;

	log('Starting Streamable HTTP transport');
	log(`Listening on http://${host}:${port}`);
	log(`Tools available: ${toolsModule.TOOLS_DEFINITIONS.length}`);
	log(`Prompts available: ${promptsModule.PROMPTS_DEFINITIONS.length}`);

	const httpServer = http.createServer(async (req, res) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
		res.setHeader(
			'Access-Control-Allow-Headers',
			'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept'
		);

		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			return res.end();
		}

		// OAuth spoof endpoints (register / authorize / token), handled then done
		if (await oauth.handle(req, res)) {
			return;
		}

		// MCP endpoint requires a live access token, else a 401 discovery challenge
		if (!oauth.guard(req, res)) {
			return;
		}

		// The endpoint serves JSON-RPC over POST alone, which the MCP spec allows a
		// server offering neither a standalone SSE stream nor session termination
		if (req.method !== 'POST') {
			return sendJsonError(res, 405, -32000, 'Method Not Allowed', { Allow: 'POST' });
		}

		let body = '';
		req.on('data', (chunk) => (body += chunk.toString()));
		req.on('end', async () => {
			let parsedBody;
			try {
				parsedBody = JSON.parse(body);
			} catch (e) {
				return sendJsonError(res, 400, -32700, 'Parse error: Invalid JSON');
			}

			log(`${describe(parsedBody)} from ${req.socket.remoteAddress}`);

			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			const mcpServer = new MCPServer(config, toolsModule, promptsModule);
			const instance = mcpServer.getServer();

			// Closing the server closes the transport it carries, so the pair dies
			// with the response whether it completed or the client went away
			res.on('close', () => {
				instance.close();
			});

			try {
				await instance.connect(transport);
				await transport.handleRequest(req, res, parsedBody);
			} catch (error) {
				log(`Request failed: ${error.message}`);
				if (!res.headersSent) {
					sendJsonError(res, 500, -32603, 'Internal error');
				}
			}
		});
	});

	httpServer.listen(port, host);

	httpServer.on('error', (error) => {
		log(`Server error: ${error.message}`);
		process.exit(1);
	});

	const shutdown = () => {
		log('Shutting down...');
		httpServer.close(() => {
			process.exit(0);
		});
	};

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

module.exports = { start };
