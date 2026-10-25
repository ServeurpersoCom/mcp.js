/**
 * SSH tunnel to a remote debugging port
 * When config carries an ssh block, the debugging port lives on another machine
 * and loopback is the only interface it binds, so a local forward brings it here
 *
 * The forward is opened once and kept between calls, closed after an idle delay,
 * and reopened when it dies, for instance when the remote reboots. Without an ssh
 * block the port is local and this manager never starts a process, endpoint
 * handing back the plain loopback origin
 *
 * The forward is a single ssh -N process. It authenticates by key only, pins the
 * host key, and fails rather than binds anywhere but loopback
 */

const { spawn } = require('child_process');
const { version } = require('./cdp');

/**
 * A reusable tunnel, or a direct origin when no ssh block is configured
 */
class Tunnel {
	/**
	 * @param {object} cfg The discorduser config block
	 */
	constructor(cfg) {
		this.cdp = cfg.cdp;
		this.ssh = cfg.ssh;
		this.timeoutMs = cfg.timeoutMs;
		this.proc = null;
		this.idle = null;
	}

	/**
	 * The debugging origin to talk to, the forward opened first when remote
	 * @returns {Promise<string>}
	 */
	async endpoint() {
		if (!this.ssh) {
			return `http://${this.cdp.host}:${this.cdp.port}`;
		}
		await this.open();
		this.touch();
		return `http://127.0.0.1:${this.ssh.localPort}`;
	}

	/**
	 * Ensure the forward is up and the port answers behind it
	 * @returns {Promise<void>}
	 */
	async open() {
		if (this.proc) {
			return;
		}
		const ssh = this.ssh;
		const args = [
			'-N',
			'-o', 'BatchMode=yes',
			'-o', 'IdentitiesOnly=yes',
			'-o', 'StrictHostKeyChecking=yes',
			'-o', `UserKnownHostsFile=${ssh.knownHosts}`,
			'-o', 'ExitOnForwardFailure=yes',
			'-o', 'ServerAliveInterval=15',
			'-o', 'ServerAliveCountMax=3',
			'-i', ssh.key,
			'-L', `127.0.0.1:${ssh.localPort}:${this.cdp.host}:${this.cdp.port}`,
			`${ssh.user}@${ssh.host}`
		];
		const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
		this.proc = proc;

		let stderr = '';
		proc.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		proc.on('exit', () => {
			if (this.proc === proc) {
				this.proc = null;
			}
			this.clearIdle();
		});

		try {
			await this.ready(proc);
		} catch (error) {
			this.close();
			const detail = stderr.trim().split('\n').pop();
			throw new Error(`Cannot reach ${ssh.host}: ${detail || error.message}`);
		}
	}

	/**
	 * Wait until the forwarded port answers, or the ssh process dies
	 * @param {ChildProcess} proc
	 * @returns {Promise<void>}
	 */
	async ready(proc) {
		const origin = `http://127.0.0.1:${this.ssh.localPort}`;
		const deadline = Date.now() + this.timeoutMs;
		while (Date.now() < deadline) {
			if (proc.exitCode !== null) {
				throw new Error('ssh exited before the port answered');
			}
			try {
				await version(origin, 1000);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		throw new Error('timed out waiting for the forwarded port');
	}

	/**
	 * Push back the idle close
	 */
	touch() {
		this.clearIdle();
		if (this.ssh.idleMs > 0) {
			this.idle = setTimeout(() => this.close(), this.ssh.idleMs);
			this.idle.unref();
		}
	}

	/**
	 * Drop the idle timer
	 */
	clearIdle() {
		if (this.idle) {
			clearTimeout(this.idle);
			this.idle = null;
		}
	}

	/**
	 * Tear the forward down
	 */
	close() {
		this.clearIdle();
		if (this.proc) {
			this.proc.kill();
			this.proc = null;
		}
	}
}

module.exports = { Tunnel };
