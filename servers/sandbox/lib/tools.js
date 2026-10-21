/**
 * Sandbox Tools Module
 * Provides isolated code execution in a Podman container
 * Isomorphic to Anthropic's Claude computer-use tools
 *
 * This module implements four core tools for secure code execution:
 *
 * - bash_tool: Execute arbitrary bash commands in isolated container
 *   - Execution timing and exit code reporting, a kill at the timeout named
 *   - Long output kept as its head and its tail, cut on line boundaries
 *
 * - view: Read files or list directories, one container call each
 *   - Directory listing with size information (2 levels deep)
 *   - Filters hidden files and the contents of node_modules
 *   - Images (PNG, JPEG, GIF, WebP) recognized by their magic bytes
 *   - Binary file detection (a NUL byte in the first 64 KiB) and rejection
 *   - Line-numbered file display with an optional checked range
 *
 * - create_file: Create new files with automatic directory creation
 *   - Base64 transport, the bytes written as given
 *   - Automatic parent directory creation
 *
 * - str_replace: Replace unique strings in files with validation
 *   - Enforces string uniqueness (prevents ambiguous replacements)
 *   - Works on the bytes of the file, which come back unchanged around the
 *     replacement whatever their encoding
 *
 * A path is taken whole as given and one holding a NUL byte is refused. Files
 * travel as base64 in both directions, so no byte goes through a text decoder
 *
 * All tools execute commands via Podman in an isolated container environment,
 * providing security through containerization while maintaining full filesystem
 * access within the container boundaries.
 *
 * Configuration is managed through the podman-executor module, allowing
 * customization of container name, user, timeouts, and output limits.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { podmanExec, escapeShell } = require('./podman-executor');
const { textResult, imageResult } = require('../../../core/tool-result');

// Load tools definitions from tools.json once at startup
const toolsDefinitionPath = path.join(__dirname, '..', 'tools.json');
const rawDefinitions = JSON.parse(fs.readFileSync(toolsDefinitionPath, 'utf8'));
const TOOLS_DEFINITIONS = rawDefinitions.map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

// Bytes a binary file shows a NUL byte in
const BINARY_PROBE_BYTES = 65536;

// Base64 output of the largest file read, with room for the marker line
const FILE_CAP_BYTES = Math.ceil(config.podman.fileLimitBytes / 3) * 4 + 64;

/**
 * The first of names whose argument is not a non empty string
 * @param {object} args
 * @param {string[]} names
 * @returns {string|undefined}
 */
function missing(args, names) {
	return names.find((name) => typeof args[name] !== 'string' || args[name] === '');
}

/**
 * Refusal of an argument, the name capitalized
 * @param {string} name
 * @returns {object}
 */
function required(name) {
	return textResult(`❌ ${name[0].toUpperCase()}${name.slice(1)} argument required`, true);
}

/**
 * A head and a tail as one text, the bytes hidden between them counted, both
 * cuts on line ends when the kept bytes hold one so no line comes out split
 * @param {{head: Buffer, tail: Buffer, total: number, truncated: boolean}} kept
 * @returns {string}
 */
function bounded(kept) {
	if (!kept.truncated) {
		return Buffer.concat([kept.head, kept.tail]).toString().replace(/\n$/, '');
	}

	const end = kept.head.lastIndexOf(0x0a);
	const begin = kept.tail.indexOf(0x0a);
	const first = end < 0 ? kept.head : kept.head.subarray(0, end + 1);
	const last = begin < 0 ? kept.tail : kept.tail.subarray(begin + 1);
	const hidden = kept.total - first.length - last.length;

	return (
		first.toString() +
		(end < 0 ? '\n' : '') +
		`⚠️ Long output with ${hidden} bytes hidden from context\n` +
		last.toString().replace(/\n$/, '')
	);
}

/**
 * A whole buffer kept within the output limit, head and tail
 * @param {Buffer} buffer
 * @returns {string}
 */
function clipped(buffer) {
	const headMax = Math.floor(config.podman.outputLimitBytes / 2);
	const tailMax = config.podman.outputLimitBytes - headMax;
	return bounded({
		head: buffer.subarray(0, headMax),
		tail: buffer.subarray(Math.max(headMax, buffer.length - tailMax)),
		total: buffer.length,
		truncated: buffer.length > headMax + tailMax
	});
}

/**
 * Shell lines that print a regular file as base64 then a FILE line, or one
 * line saying why not: BIG <size>, OTHER, NONE
 * @param {string} quoted Path quoted for the shell
 * @returns {string}
 */
function readScript(quoted) {
	return [
		`p=${quoted}`,
		'if [ -f "$p" ]; then',
		'  s=$(stat -c %s -- "$p")',
		`  if [ "$s" -gt ${config.podman.fileLimitBytes} ]; then echo "BIG $s"; else base64 -w 0 -- "$p" && echo && echo FILE; fi`,
		'elif [ -e "$p" ]; then echo OTHER',
		'else echo NONE',
		'fi'
	].join('\n');
}

/**
 * Split the output of a script on its last line, the marker
 * @param {{head: Buffer, tail: Buffer, truncated: boolean}} result
 * @returns {{marker: string, body: string}}
 */
function marked(result) {
	const text = Buffer.concat([result.head, result.tail]).toString().replace(/\n$/, '');
	const at = text.lastIndexOf('\n');
	return { marker: text.slice(at + 1), body: at < 0 ? '' : text.slice(0, at) };
}

/**
 * Read a regular file whole as bytes
 * @param {string} filepath
 * @returns {Promise<{data?: Buffer, error?: string}>}
 */
async function readFile(filepath) {
	const result = await podmanExec(readScript(escapeShell(filepath)), FILE_CAP_BYTES);
	return fileOf(filepath, result);
}

/**
 * The file a read script printed, or why there is none
 * @param {string} filepath
 * @param {{head: Buffer, tail: Buffer, truncated: boolean, exitCode: number}} result
 * @returns {{data?: Buffer, error?: string}}
 */
function fileOf(filepath, result) {
	const { marker, body } = marked(result);
	if (marker === 'FILE' && !result.truncated) {
		return { data: Buffer.from(body, 'base64') };
	}
	if (marker.startsWith('BIG ')) {
		return { error: `File ${filepath} exceeds ${config.podman.fileLimitBytes} bytes` };
	}
	if (marker === 'OTHER') {
		return { error: `Neither a regular file nor a directory: ${filepath}` };
	}
	if (marker === 'NONE') {
		return { error: `No such file or directory: ${filepath}` };
	}
	return { error: `Cannot read ${filepath}: ${bounded(result)}` };
}

/**
 * Image type of bytes, read from their magic numbers
 * @param {Buffer} data
 * @returns {string|undefined}
 */
function imageType(data) {
	if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return 'image/png';
	}
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
		return 'image/jpeg';
	}
	const ascii = data.subarray(0, 12).toString('latin1');
	if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
		return 'image/gif';
	}
	if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
		return 'image/webp';
	}
	return undefined;
}

/**
 * Tool: bash_tool
 * Execute bash command in container with head and tail output bounding
 * @param {object} args Tool arguments
 * @param {string} args.command Bash command to execute
 * @returns {Promise<object>} Tool result
 */
async function tool_bash(args = {}) {
	const absent = missing(args, ['command', 'description']);
	if (absent) {
		return required(absent);
	}
	const cmd = args.command;

	const t0 = Date.now();
	const result = await podmanExec(cmd);
	const elapsed = Date.now() - t0;

	const output = bounded(result);

	// timeout exits 124 when it kills the command, the elapsed time tells it
	// from a command that exits 124 itself
	const killed = result.exitCode === 124 && elapsed >= config.podman.timeout * 1000;
	const status = killed
		? `❌ Killed after ${config.podman.timeout} s`
		: `${result.exitCode === 0 ? '✅' : '❌'} Exit code ${result.exitCode} (${elapsed} ms)`;

	const newLine = output ? '\n' : '';
	const justification = `🎯 ${args.description}\n`;
	return textResult(
		`${output}${newLine}${justification}#️⃣ ${cmd}\n${status}`,
		result.exitCode !== 0
	);
}

/**
 * Tool: view
 * Display file content or list directory
 * @param {object} args Tool arguments
 * @param {string} args.path File or directory path
 * @param {Array<number>} [args.view_range] Optional line range [start, end]
 * @returns {Promise<object>} Tool result
 */
async function tool_view(args = {}) {
	const absent = missing(args, ['path', 'description']);
	if (absent) {
		return required(absent);
	}
	const filepath = args.path;
	if (filepath.includes('\0')) {
		return textResult('❌ Path holds a NUL byte', true);
	}

	const range = args.view_range;
	const ranged = range !== undefined && range !== null;
	let first = 1;
	let last = -1;
	if (ranged) {
		if (
			!Array.isArray(range) ||
			range.length !== 2 ||
			!Number.isInteger(range[0]) ||
			!Number.isInteger(range[1])
		) {
			return textResult('❌ The view_range is not two line numbers, [start, end]', true);
		}
		first = Math.max(1, range[0]);
		last = range[1];
		if (last !== -1 && last < first) {
			return textResult('❌ The view_range ends before it starts', true);
		}
	}

	// One call: a directory listing then DIR, or the read script of a file
	const quoted = escapeShell(filepath);
	const script = [
		`if [ -d ${quoted} ]; then`,
		`  cd ${quoted} && find . -maxdepth 2 ! -path './.*' ! -path './*/.*' ! -path './node_modules/*' ! -path './*/node_modules/*' -exec du -sh {} \\; 2>/dev/null | sort -k2`,
		'  echo DIR',
		'else',
		readScript(quoted),
		'fi'
	].join('\n');
	const result = await podmanExec(script, FILE_CAP_BYTES);
	const justification = `🎯 ${args.description}\n`;

	const { marker, body } = marked(result);
	if (marker === 'DIR') {
		// find lists from inside the directory, each entry goes back under the given path
		const listing = body
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => {
				const tab = line.indexOf('\t');
				const rel = line.slice(tab + 1);
				return `${line.slice(0, tab)}\t${rel === '.' ? filepath : path.posix.join(filepath, rel)}`;
			})
			.join('\n');
		return textResult(
			`${clipped(Buffer.from(listing))}\n${justification}👁️ Directory listing of ${filepath}`
		);
	}

	const file = fileOf(filepath, result);
	if (file.error) {
		return textResult(`❌ ${file.error}`, true);
	}

	const mimeType = imageType(file.data);
	if (mimeType) {
		return imageResult(file.data.toString('base64'), mimeType);
	}

	if (file.data.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
		return textResult(`❌ Binary file ${filepath}`, true);
	}

	const text = file.data.toString();
	const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
	const totalLines = lines.length;

	if (ranged && first > totalLines) {
		return textResult(`❌ Line ${first} is past the end, the file has ${totalLines} lines`, true);
	}
	const endLine = last === -1 || last > totalLines ? totalLines : last;

	const numbered = lines
		.slice(first - 1, endLine)
		.map((line, idx) => `${first + idx}\t${line}`)
		.join('\n');
	const numberedLines = clipped(Buffer.from(numbered));

	if (ranged) {
		return textResult(
			`${numberedLines}\n${justification}👁️ File content of ${filepath} (lines ${first}-${endLine} out of ${totalLines})`
		);
	}

	return textResult(
		`${numberedLines}\n${justification}👁️ File content of ${filepath} (${totalLines} lines)`
	);
}

/**
 * Tool: create_file
 * Create new file with automatic directory creation and base64 safety
 * @param {object} args Tool arguments
 * @param {string} args.path File path
 * @param {string} args.file_text File contents, empty or not
 * @returns {Promise<object>} Tool result
 */
async function tool_create_file(args = {}) {
	const absent = missing(args, ['path', 'description']);
	if (absent) {
		return required(absent);
	}
	if (typeof args.file_text !== 'string') {
		return required('file_text');
	}
	const filepath = args.path;
	if (filepath.includes('\0')) {
		return textResult('❌ Path holds a NUL byte', true);
	}

	const b64 = Buffer.from(args.file_text).toString('base64');
	const quoted = escapeShell(filepath);
	const script = `mkdir -p -- "$(dirname -- ${quoted})" && echo '${b64}' | base64 -d > ${quoted}`;
	const result = await podmanExec(script);

	if (result.exitCode !== 0) {
		return textResult(`${bounded(result)}\n❌ Error creating file ${filepath}`, true);
	}

	const size = Buffer.byteLength(args.file_text);
	const justification = `🎯 ${args.description}\n`;
	return textResult(`${justification}✨ File ${filepath} created (${size} bytes)`);
}

const STR_REPLACE_KEYS = ['description', 'path', 'old_str', 'new_str'];

/**
 * Tool: str_replace
 * Replace unique string in file with validation and base64-safe write
 * @param {object} args Tool arguments
 * @param {string} args.path File path
 * @param {string} args.old_str String to replace, not empty
 * @param {string} args.new_str Replacement string, empty to delete
 * @returns {Promise<object>} Tool result
 */
async function tool_str_replace(args = {}) {
	// An unknown key carries the replacement when its name is wrong
	const unknown = Object.keys(args).filter((key) => !STR_REPLACE_KEYS.includes(key));
	if (unknown.length > 0) {
		return textResult(
			`❌ Unknown argument ${unknown.join(', ')}, the replacement goes in new_str`,
			true
		);
	}

	const absent = missing(args, ['path', 'old_str', 'description']);
	if (absent) {
		return required(absent);
	}
	if (typeof args.new_str !== 'string') {
		return required('new_str');
	}
	const filepath = args.path;
	if (filepath.includes('\0')) {
		return textResult('❌ Path holds a NUL byte', true);
	}

	const file = await readFile(filepath);
	if (file.error) {
		return textResult(`❌ ${file.error}`, true);
	}
	const content = file.data;
	if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
		return textResult(`❌ Binary file ${filepath}`, true);
	}

	const oldBytes = Buffer.from(args.old_str);
	const at = content.indexOf(oldBytes);
	if (at < 0) {
		return textResult(`❌ String not found in ${filepath}`, true);
	}

	let count = 0;
	for (let i = at; i >= 0; i = content.indexOf(oldBytes, i + oldBytes.length)) {
		count++;
	}
	if (count > 1) {
		return textResult(`❌ String found ${count} times in ${filepath} (must be unique)`, true);
	}

	let line = 1;
	for (let i = content.indexOf(0x0a); i >= 0 && i < at; i = content.indexOf(0x0a, i + 1)) {
		line++;
	}

	const newBytes = Buffer.from(args.new_str);
	const newContent = Buffer.concat([
		content.subarray(0, at),
		newBytes,
		content.subarray(at + oldBytes.length)
	]);
	const writeScript = `echo '${newContent.toString('base64')}' | base64 -d > ${escapeShell(filepath)}`;
	const writeResult = await podmanExec(writeScript);

	if (writeResult.exitCode !== 0) {
		return textResult(`${bounded(writeResult)}\n❌ Error writing file ${filepath}`, true);
	}

	const justification = `🎯 ${args.description}\n`;
	return textResult(
		`${justification}🔄 Replacement done at line ${line} of ${filepath} (${oldBytes.length} -> ${newBytes.length} bytes)`
	);
}

const TOOLS_MAPPING = {
	bash_tool: tool_bash,
	view: tool_view,
	create_file: tool_create_file,
	str_replace: tool_str_replace
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
