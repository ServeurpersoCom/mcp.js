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
 * caller report the bytes hidden between them or refuse an incomplete payload.
 * The whole output also goes to the caller as it comes, line by line, up to
 * shownLimitBytes, for a client to show while the call runs. Every process
 * of a call carries a variable naming it, so a call its client cancels ends
 * inside the container, its whole tree with it
 *
 * Configuration is loaded from config.json:
 * - podman.hostUser: System user that owns the Podman process
 * - podman.podName: Name of the pod
 * - podman.containerName: Name of the container (inside pod)
 * - podman.containerUser: User inside container for command execution
 * - podman.outputLimitBytes: Output kept for the model (bytes)
 * - podman.shownLimitBytes: Output shown while a call runs (bytes)
 * - podman.timeout: Command execution timeout in seconds
 *
 * Security model:
 * 1. Execution happens via 'su - <user>' for proper user context
 * 2. The script transits as inert stdin data, never as host shell source
 * 3. Timeout protection prevents runaway processes
 * 4. Bounded output collection prevents memory exhaustion
 */

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const config = require('../config.json');

// The byte a line of output ends with
const NEWLINE = 0x0a;

// The line that ends what a call shows while it runs once it shows
// shownLimitBytes, the rest showing once the call ends
const OUTPUT_SHOWN = 'The rest of the output shows once the call ends\n';

/**
 * The whole lines of an output as they come, for whoever shows it while it
 * runs: at most max bytes of them, then OUTPUT_SHOWN, then nothing
 * @param {number} max Bytes shown at most
 * @param {function(string): void} give Takes the lines each chunk completes
 * @returns {function(Buffer): void} Takes each chunk of the output
 */
function shownLines(max, give) {
	let pending = Buffer.alloc(0);
	let shown = 0;
	let full = false;
	return (data) => {
		if (full) {
			return;
		}
		pending = Buffer.concat([pending, data]);
		const room = max - shown;
		const end = pending.lastIndexOf(NEWLINE);
		// The whole lines that fit, the line that ends the show when the rest
		// does not: a line past the room, or one still open that already fills it
		const fits =
			end < 0 ? -1 : end < room ? end : room === 0 ? -1 : pending.lastIndexOf(NEWLINE, room - 1);
		let out = fits < 0 ? '' : pending.subarray(0, fits + 1).toString();
		shown += fits + 1;
		pending = pending.subarray(fits + 1);
		if ((end >= 0 && fits !== end) || pending.length > max - shown) {
			full = true;
			pending = Buffer.alloc(0);
			out += OUTPUT_SHOWN;
		}
		if (out) {
			give(out);
		}
	};
}

// The variable every process of a call inherits, its value naming the call
const CALL_VARIABLE = 'MCP_CALL';

// The rounds a kill makes, a process forked while one runs dying in the next
const KILL_ROUNDS = 5;

/**
 * The script that kills inside the container every process of a call, found
 * by the variable it inherited, until none is left
 * @param {string} call The value naming the call
 * @returns {string}
 */
function killScript(call) {
	return `for i in $(seq ${KILL_ROUNDS}); do
	found=$(grep -l -a ${CALL_VARIABLE}=${call} /proc/[0-9]*/environ 2>/dev/null) || break
	for f in $found; do p=\${f#/proc/}; kill -KILL \${p%/environ} 2>/dev/null; done
done
`;
}

// Construct full container name (pod-container)
const fullContainerName = `${config.podman.podName}-${config.podman.containerName}`;

/**
 * Execute command in Podman container
 * @param {string} script Bash script to execute
 * @param {number} [capBytes] Output bytes kept, head and tail, defaults to the output limit
 * @param {function(string): void} [partial] Takes the whole lines of the output as they come, none for a call that streams nothing
 * @param {AbortSignal} [signal] Ends the command and every process it started,
 * one aborted already starting nothing
 * @returns {Promise<{head: Buffer, tail: Buffer, total: number, truncated: boolean, exitCode: number}>}
 */
async function podmanExec(
	script,
	capBytes = config.podman.outputLimitBytes,
	partial = undefined,
	signal = undefined
) {
	signal?.throwIfAborted();
	return new Promise((resolve) => {
		// The inner bash reads the script from its stdin, exec collapses the wrapper
		const call = randomUUID();
		const podmanCmd = `podman exec -i -e ${CALL_VARIABLE}=${call} -u ${config.podman.containerUser} ${fullContainerName} bash -c "exec timeout ${config.podman.timeout} bash 2>&1"`;
		const proc = spawn('su', ['-', config.podman.hostUser, '-c', podmanCmd]);

		// Ending the host side leaves the container side running: the kill
		// goes inside, by a second exec reading its script on stdin
		const stop = () => {
			const killCmd = `podman exec -i -u ${config.podman.containerUser} ${fullContainerName} sh`;
			const kill = spawn('su', ['-', config.podman.hostUser, '-c', killCmd]);
			kill.on('error', () => {});
			kill.stdin.on('error', () => {});
			kill.stdin.end(killScript(call));
		};
		signal?.addEventListener('abort', stop, { once: true });

		const headMax = Math.floor(capBytes / 2);
		const tailMax = capBytes - headMax;
		const head = [];
		let headBytes = 0;
		const show = partial && shownLines(config.podman.shownLimitBytes, partial);
		const chunks = [];
		let kept = 0;
		let total = 0;

		// The first headMax bytes go to the head, the rest to a ring of chunks
		// that drops its oldest ones once it holds tailMax bytes without them
		const collect = (data) => {
			show?.(data);
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
			signal?.removeEventListener('abort', stop);
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
