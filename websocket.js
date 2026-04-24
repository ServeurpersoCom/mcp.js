#!/usr/bin/env node
const WebSocket = require('ws');
const MCPServer = require('./lib/server-core');
const config = require('./config.json');
const toolsModule = require('./lib/tools');
const { createPromptsModule } = require('./lib/prompts');
const { AUTH_ENABLED, verifyAuthHeader } = require('./lib/auth');

const promptsModule = createPromptsModule(config);

const { host, port } = config.websocket;

console.error('[Bash MCP] Starting WebSocket transport');
console.error(`[Bash MCP] Listening on ws://${host}:${port}`);
console.error(`[Bash MCP] Tools available: ${toolsModule.TOOLS_DEFINITIONS.length}`);
console.error(`[Bash MCP] Prompts available: ${promptsModule.PROMPTS_DEFINITIONS.length}`);

// verifyClient runs during the HTTP upgrade handshake
// Returning false makes ws reply with 401 before the socket is opened
const wss = new WebSocket.Server({
	host,
	port,
	verifyClient: ({ req }) => !AUTH_ENABLED || verifyAuthHeader(req.headers.authorization)
});

let connectionCount = 0;

wss.on('connection', async (ws, req) => {
	const clientIP = req.socket.remoteAddress;
	const connectionId = ++connectionCount;

	console.error(
		`[Bash MCP] Connection ${connectionId} from ${clientIP} (${wss.clients.size} active)`
	);

	const mcpServer = new MCPServer(config, toolsModule, promptsModule);
	const server = mcpServer.getServer();

	const transport = {
		async start() {
			return Promise.resolve();
		},

		async send(message) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify(message));
			}
		},

		async close() {
			ws.close();
		},

		onclose: null,
		onerror: null,
		onmessage: null
	};

	await transport.start();
	server.connect(transport);

	ws.on('message', (data) => {
		try {
			const message = JSON.parse(data.toString());

			if (transport.onmessage) {
				transport.onmessage(message);
			}
		} catch (error) {
			console.error(`[Bash MCP] Connection ${connectionId} parse error: ${error.message}`);

			if (ws.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({
						jsonrpc: '2.0',
						error: { code: -32700, message: 'Parse error' },
						id: null
					})
				);
			}
		}
	});

	ws.on('close', (code) => {
		console.error(
			`[Bash MCP] Connection ${connectionId} closed (code=${code}, ${wss.clients.size} active)`
		);

		if (transport.onclose) {
			transport.onclose();
		}
	});

	ws.on('error', (error) => {
		console.error(`[Bash MCP] Connection ${connectionId} error: ${error.message}`);

		if (transport.onerror) {
			transport.onerror(error);
		}
	});

	ws.on('ping', () => {
		ws.pong();
	});
});

wss.on('error', (error) => {
	console.error(`[Bash MCP] Server error: ${error.message}`);
	process.exit(1);
});

const shutdown = () => {
	console.error('[Bash MCP] Shutting down...');

	wss.clients.forEach((ws) => {
		ws.close(1001, 'Server shutting down');
	});

	wss.close(() => {
		console.error('[Bash MCP] Server closed');
		process.exit(0);
	});
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
