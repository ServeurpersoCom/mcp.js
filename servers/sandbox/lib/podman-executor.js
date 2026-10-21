/**
 * Podman Executor Module
 * Handles command execution in Podman containers
 *
 * The bash script travels over stdin of the podman exec pipeline, so the argv
 * of the host command stays constant size regardless of script length (immune
 * to the kernel MAX_ARG_STRLEN limit), and the payload never crosses a shell
 * parser (nothing to escape or encode)
 *
 * The output of the container and of podman itself is kept as a head and a
 * tail bounded by the caller supplied cap, so memory stays flat however much
 * the command emits: the head holds the first half of the cap, a ring of
 * chunks the last half. The truncated flag and the true byte total let the
 * caller report the bytes hidden between them or refuse an incomplete payload
 *
 * Configuration is loaded from config.json:
 * - podman.hostUser: System user that owns the Podman process
 * - podman.podName: Name of the pod
 * - podman.containerName: Name of the container (inside pod)
 * - podman.containerUser: User inside container for command execution
 * - podman.outputLimitBytes: Output kept for the model (bytes)
 * - podman.timeout: Command execution timeout in seconds
 *
 * Security model:
 * 1. Execution happens via 'su - <user>' for proper user context
 * 2. The script transits as inert stdin data, never as host shell source
 * 3. Timeout protection prevents runaway processes
 * 4. Bounded output collection prevents memory exhaustion
 */

const { spawn } = require('child_process');
const config = require('../config.json');

// Construct full container name (pod-container)
const fullContainerName = `${config.podman.podName}-${config.podman.containerName}`;

/**
 * Execute command in Podman container
 * @param {string} script Bash script to execute
 * @param {number} [capBytes] Output bytes kept, head and tail, defaults to the output limit
 * @returns {Promise<{head: Buffer, tail: Buffer, total: number, truncated: boolean, exitCode: number}>}
 */
async function podmanExec(script, capBytes = config.podman.outputLimitBytes) {
	return new Promise((resolve) => {
		// The inner bash reads the script from its stdin, exec collapses the wrapper
		const podmanCmd = `podman exec -i -u ${config.podman.containerUser} ${fullContainerName} bash -c "exec timeout ${config.podman.timeout} bash 2>&1"`;
		const proc = spawn('su', ['-', config.podman.hostUser, '-c', podmanCmd]);

		const headMax = Math.floor(capBytes / 2);
		const tailMax = capBytes - headMax;
		const head = [];
		let headBytes = 0;
		const chunks = [];
		let kept = 0;
		let total = 0;

		// The first headMax bytes go to the head, the rest to a ring of chunks
		// that drops its oldest ones once it holds tailMax bytes without them
		const collect = (data) => {
			total += data.length;
			const take = Math.min(data.length, headMax - headBytes);
			if (take > 0) {
				head.push(data.subarray(0, take));
				headBytes += take;
				data = data.subarray(take);
			}
			if (data.length === 0) {
				return;
			}
			chunks.push(data);
			kept += data.length;
			while (kept - chunks[0].length >= tailMax) {
				kept -= chunks.shift().length;
			}
		};

		proc.stdout.on('data', collect);
		proc.stderr.on('data', collect);

		// A child that exits before draining its stdin raises EPIPE on the pipe,
		// the close handler already carries the outcome so the event is consumed
		proc.stdin.on('error', () => {});
		proc.stdin.end(script);

		// A process ended by a signal has no exit code, it reads as a failure
		proc.on('close', (exitCode) => {
			const ring = Buffer.concat(chunks);
			const tail = ring.subarray(Math.max(0, ring.length - tailMax));
			resolve({
				head: Buffer.concat(head),
				tail,
				total,
				truncated: total > headBytes + tail.length,
				exitCode: exitCode === null ? 1 : exitCode
			});
		});

		proc.on('error', (err) => {
			const message = Buffer.from(`Cannot start podman: ${err.message}`);
			resolve({
				head: message,
				tail: Buffer.alloc(0),
				total: message.length,
				truncated: false,
				exitCode: 1
			});
		});
	});
}

/**
 * Escape shell argument
 * @param {string} arg Argument to escape
 * @returns {string} Escaped argument
 */
function escapeShell(arg) {
	return "'" + arg.replace(/'/g, "'\"'\"'") + "'";
}

module.exports = {
	podmanExec,
	escapeShell
};
