/**
 * WebSocket transport
 * One server instance per connection, authenticated with the static bearer
 * during the HTTP upgrade handshake so no socket is opened unauthenticated
 */

const WebSocket = require('ws');
const MCPServer = require('../server-core');
const { createAuth } = require('../auth');

/**
 * Start the server on WebSocket
 * @param {object} server - Bundle returned by the registry
 */
function start(server) {
	const { config, toolsModule, promptsModule, log } = server;
	const { AUTH_ENABLED, verifyAuthHeader } = createAuth(config);
	const { host, port } = config.websocket;

	log('Starting WebSocket transport');
	log(`Listening on ws://${host}:${port}`);
	log(`Tools available: ${toolsModule.TOOLS_DEFINITIONS.length}`);
	log(`Prompts available: ${promptsModule.PROMPTS_DEFINITIONS.length}`);

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

		log(`Connection ${connectionId} from ${clientIP} (${wss.clients.size} active)`);

		const mcpServer = new MCPServer(config, toolsModule, promptsModule);
		const instance = mcpServer.getServer();

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
		instance.connect(transport);

		ws.on('message', (data) => {
			try {
				const message = JSON.parse(data.toString());

				if (transport.onmessage) {
					transport.onmessage(message);
				}
			} catch (error) {
				log(`Connection ${connectionId} parse error: ${error.message}`);

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
			log(`Connection ${connectionId} closed (code=${code}, ${wss.clients.size} active)`);

			if (transport.onclose) {
				transport.onclose();
			}
		});

		ws.on('error', (error) => {
			log(`Connection ${connectionId} error: ${error.message}`);

			if (transport.onerror) {
				transport.onerror(error);
			}
		});

		ws.on('ping', () => {
			ws.pong();
		});
	});

	wss.on('error', (error) => {
		log(`Server error: ${error.message}`);
		process.exit(1);
	});

	const shutdown = () => {
		log('Shutting down...');

		wss.clients.forEach((ws) => {
			ws.close(1001, 'Server shutting down');
		});

		wss.close(() => {
			log('Server closed');
			process.exit(0);
		});
	};

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

module.exports = { start };
