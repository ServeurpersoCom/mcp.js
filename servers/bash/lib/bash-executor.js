/**
 * Bash Executor Module - Local execution without Podman
 * Handles direct bash command execution on the local system
 *
 * The bash script travels over stdin of the spawned bash, so the argv stays
 * constant size regardless of script length (immune to the kernel
 * MAX_ARG_STRLEN limit) and the payload never crosses a shell parser
 *
 * Stdout is collected in a ring of chunks bounded by the caller supplied cap,
 * so memory stays flat however much the command emits, the newest bytes
 * survive, the truncated flag and the true byte total let the caller either
 * report a tail cut or refuse an incomplete payload
 *
 * Configuration is loaded from config.json:
 * - bash.timeout: Command execution timeout in seconds
 * - bash.outputLimitBytes: Retained output tail (bytes)
 * - bash.fileLimitBytes: Full read ceiling for file consumers (bytes)
 *
 * Command stderr merges into stdout inside the child, the stderr field only
 * carries spawn level failures of the wrapper itself
 *
 * Security model:
 * 1. Commands are executed directly via bash
 * 2. Timeout protection prevents runaway processes
 * 3. Bounded output collection prevents memory exhaustion
 * 4. No user context switching (runs as current user)
 *
 * ⚠️ WARNING: This module executes commands directly on the host system
 * without containerization. Use only in trusted environments with controlled access.
 */

const { spawn } = require('child_process');
const config = require('../config.json');

// Get timeout from config
const TIMEOUT = config.bash?.timeout || 30;

/**
 * Execute command directly in local bash
 * @param {string} script - Bash script to execute
 * @param {number} [capBytes] - Retained stdout bytes, defaults to twice the bash tail
 * @returns {Promise<{stdout: string, stdoutTotalBytes: number, truncated: boolean, stderr: string, exitCode: number}>}
 */
async function bashExec(script, capBytes = config.bash.outputLimitBytes * 2) {
	return new Promise((resolve) => {
		// The inner bash reads the script from its stdin, exec collapses the
		// wrapper, stderr merges into stdout so diagnostics reach the caller in
		// chronological order like a terminal
		const proc = spawn('bash', ['-c', `exec timeout ${TIMEOUT} bash 2>&1`], {
			env: process.env,
			shell: false
		});

		// Ring of chunks keeping the newest capBytes, so memory stays bounded by
		// the caller and the truncated flag tells when older bytes were dropped
		const chunks = [];
		let kept = 0;
		let total = 0;

		proc.stdout.on('data', (data) => {
			total += data.length;
			chunks.push(data);
			kept += data.length;
			while (kept - chunks[0].length >= capBytes) {
				kept -= chunks.shift().length;
			}
		});

		let stderr = '';
		proc.stderr.on('data', (data) => {
			if (stderr.length < capBytes) {
				stderr += data.toString();
			}
		});

		// A child that exits before draining its stdin raises EPIPE on the pipe,
		// the close handler already carries the outcome so the event is consumed
		proc.stdin.on('error', () => {});
		proc.stdin.end(script);

		proc.on('close', (exitCode) => {
			resolve({
				stdout: Buffer.concat(chunks).toString(),
				stdoutTotalBytes: total,
				truncated: kept < total,
				stderr: stderr,
				exitCode: exitCode || 0
			});
		});

		proc.on('error', (err) => {
			resolve({
				stdout: '',
				stdoutTotalBytes: 0,
				truncated: false,
				stderr: err.message,
				exitCode: 1
			});
		});
	});
}

/**
 * Escape shell argument
 * @param {string} arg - Argument to escape
 * @returns {string} Escaped argument
 */
function escapeShell(arg) {
	return "'" + arg.replace(/'/g, "'\"'\"'") + "'";
}

module.exports = {
	bashExec,
	escapeShell
};
