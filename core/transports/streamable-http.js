/**
 * Streamable HTTP transport
 * One server instance per MCP session, sessions keyed by the Mcp-Session-Id
 * header, guarded by the OAuth module built from the server configuration
 */

const http = require('http');
const { randomUUID } = require('crypto');
const {
	StreamableHTTPServerTransport
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const MCPServer = require('../server-core');
const { createOAuth } = require('../oauth');

const isInitializeRequest = (body) => {
	return body && body.method === 'initialize';
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

	const transports = {};

	const createServer = () => {
		const mcpServer = new MCPServer(config, toolsModule, promptsModule);
		return mcpServer.getServer();
	};

	const httpServer = http.createServer(async (req, res) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
		res.setHeader(
			'Access-Control-Allow-Headers',
			'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept'
		);
		res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

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

		if (req.method === 'POST') {
			let body = '';
			req.on('data', (chunk) => (body += chunk.toString()));
			req.on('end', async () => {
				let parsedBody;
				try {
					parsedBody = JSON.parse(body);
				} catch (e) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					return res.end(JSON.stringify({ error: 'Invalid JSON' }));
				}

				const sessionId = req.headers['mcp-session-id'];
				let transport;

				if (sessionId && transports[sessionId]) {
					transport = transports[sessionId];
				} else if (!sessionId && isInitializeRequest(parsedBody)) {
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (sid) => {
							log(`Session ${sid} initialized (${Object.keys(transports).length + 1} active)`);
							transports[sid] = transport;
						}
					});

					transport.onclose = () => {
						const sid = transport.sessionId;
						if (sid && transports[sid]) {
							log(`Session ${sid} closed (${Object.keys(transports).length - 1} active)`);
							delete transports[sid];
						}
					};

					const instance = createServer();
					await instance.connect(transport);
					await transport.handleRequest(req, res, parsedBody);
					return;
				} else if (sessionId && !transports[sessionId]) {
					// Session ID provided but unknown (server restarted)
					// MCP spec mandates 404 so the client reinitializes
					res.writeHead(404, { 'Content-Type': 'application/json' });
					return res.end(
						JSON.stringify({
							jsonrpc: '2.0',
							error: { code: -32600, message: 'Session not found' },
							id: null
						})
					);
				} else {
					// No session ID on a non initialize request, MCP spec returns 400
					res.writeHead(400, { 'Content-Type': 'application/json' });
					return res.end(
						JSON.stringify({
							jsonrpc: '2.0',
							error: { code: -32000, message: 'Bad Request: Mcp-Session-Id required' },
							id: null
						})
					);
				}

				await transport.handleRequest(req, res, parsedBody);
			});
			return;
		}

		if (req.method === 'GET') {
			const sessionId = req.headers['mcp-session-id'];

			if (!sessionId) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				return res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						error: { code: -32000, message: 'Bad Request: Mcp-Session-Id required' },
						id: null
					})
				);
			}

			if (!transports[sessionId]) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				return res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						error: { code: -32600, message: 'Session not found' },
						id: null
					})
				);
			}

			await transports[sessionId].handleRequest(req, res);
			return;
		}

		if (req.method === 'DELETE') {
			const sessionId = req.headers['mcp-session-id'];

			if (sessionId && transports[sessionId]) {
				await transports[sessionId].close();
			}

			res.writeHead(200);
			return res.end();
		}

		res.writeHead(405);
		res.end('Method Not Allowed');
	});

	httpServer.listen(port, host);

	httpServer.on('error', (error) => {
		log(`Server error: ${error.message}`);
		process.exit(1);
	});

	const shutdown = async () => {
		log('Shutting down...');
		for (const sessionId in transports) {
			await transports[sessionId].close();
		}
		process.exit(0);
	};

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

module.exports = { start };
