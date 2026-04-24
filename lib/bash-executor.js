/**
 * Bash Executor Module - Local execution without Podman
 * Handles direct bash command execution on the local system
 *
 * This module provides the low-level interface for executing bash commands
 * directly on the local system (no container isolation).
 *
 * Configuration is loaded from config.json:
 * - bash.timeout: Command execution timeout in seconds
 *
 * Security model:
 * 1. Commands are executed directly via bash
 * 2. Timeout protection prevents runaway processes
 * 3. No user context switching (runs as current user)
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
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function bashExec(script) {
	return new Promise((resolve) => {
		// Execute directly in bash with timeout
		const proc = spawn('bash', ['-c', `timeout ${TIMEOUT} bash <<'EOF'\n${script}\nEOF\n`], {
			env: process.env,
			shell: false
		});

		let stdout = '';
		let stderr = '';

		proc.stdout.on('data', (data) => {
			stdout += data.toString();
		});

		proc.stderr.on('data', (data) => {
			stderr += data.toString();
		});

		proc.on('close', (exitCode) => {
			resolve({
				stdout: stdout,
				stderr: stderr,
				exitCode: exitCode || 0
			});
		});

		proc.on('error', (err) => {
			resolve({
				stdout: '',
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

/**
 * Escape regex special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
	bashExec,
	escapeShell,
	escapeRegex
};
