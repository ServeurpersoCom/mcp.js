/**
 * Debugging endpoint, local or through SSH
 * When config carries an ssh block, the debugging port lives on another machine
 * and loopback is the only interface it binds, so a local forward brings it here
 *
 * Each call opens its own forward on a port the system picks, and kills it when
 * the call ends. Nothing outlives a call, two calls never share or fight over a
 * port, and a remote that rebooted is simply reached again by the next call.
 * The forward is a single ssh -N process, which never reads its stdin and so
 * cannot notice its parent dying: the forwards still alive when this process
 * exits are killed on the way out
 *
 * Without an ssh block the port is local and no process is started
 */

const { spawn } = require('child_process');
const net = require('net');
const { version } = require('./cdp');

const POLL_MS = 25;
const live = new Set();

process.once('exit', () => {
	for (const proc of live) {
		proc.kill();
	}
});

/**
 * A free loopback port, picked by the system
 * @returns {Promise<number>}
 */
function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/**
 * Run fn with the debugging origin, through a forward opened for this call when
 * the port is remote
 * @param {object} cfg The discorduser config block
 * @param {function(string): Promise<*>} fn Receives http://host:port
 * @returns {Promise<*>}
 */
async function withEndpoint(cfg, fn) {
	const { cdp, ssh, timeoutMs } = cfg;
	if (!ssh) {
		return fn(`http://${cdp.host}:${cdp.port}`);
	}

	const port = await freePort();
	const proc = spawn(
		'ssh',
		[
			'-N',
			'-o', 'BatchMode=yes',
			'-o', 'IdentitiesOnly=yes',
			'-o', 'StrictHostKeyChecking=yes',
			'-o', `UserKnownHostsFile=${ssh.knownHosts}`,
			'-o', 'ExitOnForwardFailure=yes',
			'-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
			'-i', ssh.key,
			'-L', `127.0.0.1:${port}:${cdp.host}:${cdp.port}`,
			`${ssh.user}@${ssh.host}`
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] }
	);
	live.add(proc);

	let stderr = '';
	let failure = null;
	proc.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	proc.on('error', (error) => {
		failure = error.message;
	});
	proc.on('exit', () => {
		live.delete(proc);
		failure = failure || 'ssh exited';
	});

	try {
		const origin = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (failure) {
				const detail = stderr.trim().split('\n').pop();
				throw new Error(`Cannot reach ${ssh.host}: ${detail || failure}`);
			}
			if (Date.now() > deadline) {
				throw new Error(
					`No answer on port ${cdp.port} of ${ssh.host}, is the app running with --remote-debugging-port=${cdp.port}`
				);
			}
			try {
				await version(origin, timeoutMs);
				break;
			} catch {
				await new Promise((r) => setTimeout(r, POLL_MS));
			}
		}
		return await fn(origin);
	} finally {
		proc.kill();
	}
}

module.exports = { withEndpoint };
