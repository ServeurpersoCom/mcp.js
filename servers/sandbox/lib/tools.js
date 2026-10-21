/**
 * Sandbox Tools Module
 * Provides isolated code execution in a Podman container
 * Isomorphic to Anthropic's Claude computer-use tools, its results worded as
 * the tools of the KiSS backend word theirs
 *
 * - bash_tool: the command on stdin, the merged output back with the exit
 *   code and the duration, a kill at the timeout named
 * - view: a directory two levels deep with the size of each entry, an image
 *   with a line saying what it is, a text file with numbered lines
 * - create_file: a file written whole, empty or not, its directories made
 * - str_replace: the one place a file holds a string, replaced in place
 *
 * Every call first passes the law of its schema: no unknown argument, every
 * required one present, a string where the schema says string and never
 * shorter than its minLength
 *
 * A path is taken whole as given and one holding a NUL byte is refused. Files
 * travel as base64 in both directions, so no byte goes through a text decoder
 * and a file in any encoding keeps its bytes
 *
 * Long output keeps its head and its tail, cut on line ends, the bytes hidden
 * between them counted
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

const SCHEMAS = Object.fromEntries(TOOLS_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema]));

// Bytes a binary file shows a NUL byte in
const BINARY_PROBE_BYTES = 65536;

// Base64 output of the largest file read, with room for the marker lines
const FILE_CAP_BYTES = Math.ceil(config.podman.fileLimitBytes / 3) * 4 + 64;

/**
 * A count with its noun: 1 line, 3 lines
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function counted(n, one, many) {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * The first breach of the schema of a tool by its arguments, or null
 * @param {string} tool
 * @param {object} args
 * @returns {string|null}
 */
function breach(tool, args) {
	const { properties, required } = SCHEMAS[tool];
	const capital = (name) => name[0].toUpperCase() + name.slice(1);

	const unknown = Object.keys(args).filter((key) => !(key in properties));
	if (unknown.length > 0) {
		return `Unknown argument ${unknown.join(', ')}`;
	}
	for (const name of required) {
		if (args[name] === undefined) {
			return `${capital(name)} argument required`;
		}
	}
	for (const [name, value] of Object.entries(args)) {
		if (properties[name].type !== 'string') {
			continue;
		}
		if (typeof value !== 'string') {
			return `${capital(name)} argument is not a string`;
		}
		if (value.length < (properties[name].minLength || 0)) {
			return `${capital(name)} argument required`;
		}
	}
	return null;
}

/**
 * A head and a tail as one text ending on a line end, the bytes hidden
 * between them counted, both cuts on line ends when the kept bytes hold one
 * @param {{head: Buffer, tail: Buffer, total: number, truncated: boolean}} kept
 * @returns {string} Empty, or text ending with a newline
 */
function bounded(kept) {
	let text;
	if (!kept.truncated) {
		text = Buffer.concat([kept.head, kept.tail]).toString();
	} else {
		const end = kept.head.lastIndexOf(0x0a);
		const begin = kept.tail.indexOf(0x0a);
		const first =
			end < 0 ? Buffer.concat([kept.head, Buffer.from('\n')]) : kept.head.subarray(0, end + 1);
		const last = begin < 0 ? kept.tail : kept.tail.subarray(begin + 1);
		const hidden = kept.total - Math.min(kept.head.length, first.length) - last.length;
		text = `${first}Long output with ${hidden} bytes hidden from context\n${last}`;
	}
	return text === '' || text.endsWith('\n') ? text : text + '\n';
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
 * @param {{head: Buffer, tail: Buffer}} result
 * @returns {{marker: string, body: string}}
 */
function marked(result) {
	const text = Buffer.concat([result.head, result.tail]).toString().replace(/\n$/, '');
	const at = text.lastIndexOf('\n');
	return { marker: text.slice(at + 1), body: at < 0 ? '' : text.slice(0, at) };
}

/**
 * The file a read script printed, or why there is none
 * @param {string} filepath
 * @param {{head: Buffer, tail: Buffer, total: number, truncated: boolean}} result
 * @param {string} other What a path that is neither a file nor missing is called
 * @returns {{data?: Buffer, error?: string}}
 */
function fileOf(filepath, result, other) {
	const { marker, body } = marked(result);
	if (marker === 'FILE' && !result.truncated) {
		return { data: Buffer.from(body, 'base64') };
	}
	if (marker.startsWith('BIG ')) {
		return { error: `File larger than ${config.podman.fileLimitBytes} bytes` };
	}
	if (marker === 'OTHER') {
		return { error: `${other}: ${filepath}` };
	}
	if (marker === 'NONE') {
		return { error: `No such file or directory: ${filepath}` };
	}
	return { error: `Cannot read the file: ${bounded(result).trimEnd()}` };
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
 * Width and height an image header declares, 0 x 0 when it declares none
 * @param {Buffer} data
 * @param {string} mime
 * @returns {{width: number, height: number}}
 */
function imageSize(data, mime) {
	if (mime === 'image/png' && data.length >= 24) {
		return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
	}
	if (mime === 'image/gif' && data.length >= 10) {
		return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
	}
	if (mime === 'image/webp' && data.length >= 30) {
		const chunk = data.toString('latin1', 12, 16);
		if (chunk === 'VP8X') {
			return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
		}
		if (chunk === 'VP8L') {
			const bits = data.readUInt32LE(21);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		if (chunk === 'VP8 ') {
			return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
		}
	}
	if (mime === 'image/jpeg') {
		// The frame header of a start of frame segment, SOF0 to SOF15 but DHT, JPG and DAC
		for (let at = 2; at + 9 <= data.length && data[at] === 0xff;) {
			const marker = data[at + 1];
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
				return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
			}
			at += 2 + data.readUInt16BE(at + 2);
		}
	}
	return { width: 0, height: 0 };
}

/**
 * Tool: bash_tool
 * The command on stdin, the merged output back with the exit code
 * @param {object} args Tool arguments
 * @returns {Promise<object>} Tool result
 */
async function tool_bash(args = {}) {
	const refused = breach('bash_tool', args);
	if (refused) {
		return textResult(refused, true);
	}

	const t0 = Date.now();
	const result = await podmanExec(args.command);
	const elapsed = Date.now() - t0;
	const output = bounded(result);

	// timeout exits 124 when it kills the command, the elapsed time tells it
	// from a command that exits 124 itself
	if (result.exitCode === 124 && elapsed >= config.podman.timeout * 1000) {
		return textResult(`${output}Killed after ${config.podman.timeout} s`, true);
	}
	return textResult(`${output}Exit code ${result.exitCode} (${elapsed} ms)`, result.exitCode !== 0);
}

/**
 * Tool: view
 * A directory listing, an image, or a text file with numbered lines
 * @param {object} args Tool arguments
 * @returns {Promise<object|object[]>} Tool result
 */
async function tool_view(args = {}) {
	const refused = breach('view', args);
	if (refused) {
		return textResult(refused, true);
	}
	const filepath = args.path;
	if (filepath.includes('\0')) {
		return textResult('Path holds a NUL byte', true);
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
			return textResult('The view_range is not two line numbers, [start, end]', true);
		}
		first = Math.max(1, range[0]);
		last = range[1];
		if (last !== -1 && last < first) {
			return textResult('The view_range ends before it starts', true);
		}
	}

	// One call: a directory listing then its hidden count and DIR, or the read script of a file
	const quoted = escapeShell(filepath);
	const script = [
		`if [ -d ${quoted} ]; then`,
		`  cd ${quoted} || exit 1`,
		"  find . -maxdepth 2 ! -path './.*' ! -path './*/.*' ! -path './node_modules/*' ! -path './*/node_modules/*' -exec du -sh {} \\; 2>/dev/null | sort -k2",
		"  echo \"HIDDEN $(find . -mindepth 1 -maxdepth 2 -name '.*' ! -path './.*/*' ! -path './node_modules/*' | wc -l)\"",
		'  echo DIR',
		'else',
		readScript(quoted),
		'fi'
	].join('\n');
	const result = await podmanExec(script, FILE_CAP_BYTES);

	const { marker, body } = marked(result);
	if (marker === 'DIR') {
		const lines = body.split('\n');
		const hidden = Number(lines.pop().replace('HIDDEN ', ''));
		// find lists from inside the directory, each entry goes back under the given path
		const listing = lines
			.filter((line) => line !== '')
			.map((line) => {
				const tab = line.indexOf('\t');
				const rel = line.slice(tab + 1);
				return `${line.slice(0, tab)}\t${rel === '.' ? filepath : path.posix.join(filepath, rel)}\n`;
			});
		const tail = hidden > 0 ? `, ${hidden} hidden` : '';
		return textResult(
			clipped(Buffer.from(listing.join(''))) +
				counted(Math.max(0, listing.length - 1), 'entry', 'entries') +
				tail
		);
	}

	const file = fileOf(filepath, result, 'Neither a regular file nor a directory');
	if (file.error) {
		return textResult(file.error, true);
	}

	const mime = imageType(file.data);
	if (mime) {
		const { width, height } = imageSize(file.data, mime);
		return [
			textResult(`Image ${mime} ${width}x${height}, ${file.data.length} bytes`),
			imageResult(file.data.toString('base64'), mime)
		];
	}

	if (file.data.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
		return textResult('Binary file', true);
	}

	const text = file.data.toString();
	const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
	const total = lines.length;
	if (ranged && first > total) {
		return textResult(
			`Line ${first} is past the end, the file has ${counted(total, 'line', 'lines')}`,
			true
		);
	}
	const end = last === -1 || last > total ? total : last;
	const numbered = lines
		.slice(first - 1, end)
		.map((line, idx) => `${first + idx}\t${line}\n`)
		.join('');
	const summary = ranged ? `Lines ${first}-${end} of ${total}` : counted(total, 'line', 'lines');
	return textResult(clipped(Buffer.from(numbered)) + summary);
}

/**
 * Tool: create_file
 * A file written whole with the text given, its parent directories made, a
 * file already there written over
 * @param {object} args Tool arguments
 * @returns {Promise<object>} Tool result
 */
async function tool_create_file(args = {}) {
	const refused = breach('create_file', args);
	if (refused) {
		return textResult(refused, true);
	}
	const filepath = args.path;
	if (filepath.includes('\0')) {
		return textResult('Path holds a NUL byte', true);
	}

	const text = args.file_text;
	const quoted = escapeShell(filepath);
	const script = [
		`if [ -e ${quoted} ]; then echo THERE; fi`,
		`mkdir -p -- "$(dirname -- ${quoted})" && echo '${Buffer.from(text).toString('base64')}' | base64 -d > ${quoted}`
	].join('\n');
	const result = await podmanExec(script);
	const output = bounded(result);
	if (result.exitCode !== 0) {
		return textResult(`Cannot write the file: ${output.replace(/^THERE\n/, '').trimEnd()}`, true);
	}

	const lines = text.split('\n').length - 1 + (text !== '' && !text.endsWith('\n') ? 1 : 0);
	const verb = output.startsWith('THERE') ? 'Overwrote' : 'Created';
	return textResult(
		`${verb} ${filepath}, ${counted(lines, 'line', 'lines')}, ${counted(Buffer.byteLength(text), 'byte', 'bytes')}`
	);
}

/**
 * Tool: str_replace
 * The one place a text file holds a string, replaced by another, the file
 * written in place, its other bytes untouched
 * @param {object} args Tool arguments
 * @returns {Promise<object>} Tool result
 */
async function tool_str_replace(args = {}) {
	const refused = breach('str_replace', args);
	if (refused) {
		return textResult(refused, true);
	}
	const filepath = args.path;
	if (filepath.includes('\0')) {
		return textResult('Path holds a NUL byte', true);
	}

	const read = await podmanExec(readScript(escapeShell(filepath)), FILE_CAP_BYTES);
	const file = fileOf(filepath, read, 'Not a regular file');
	if (file.error) {
		return textResult(file.error, true);
	}
	const content = file.data;
	if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
		return textResult('Binary file', true);
	}

	const oldBytes = Buffer.from(args.old_str);
	const at = content.indexOf(oldBytes);
	if (at < 0) {
		return textResult(`Not found in ${filepath}`, true);
	}
	let count = 0;
	for (let i = at; i >= 0; i = content.indexOf(oldBytes, i + oldBytes.length)) {
		count++;
	}
	if (count > 1) {
		return textResult(`Found ${count} times in ${filepath}, old_str must be unique`, true);
	}

	let line = 1;
	for (let i = content.indexOf(0x0a); i >= 0 && i < at; i = content.indexOf(0x0a, i + 1)) {
		line++;
	}

	const newBytes = Buffer.from(args.new_str);
	const written = Buffer.concat([
		content.subarray(0, at),
		newBytes,
		content.subarray(at + oldBytes.length)
	]);
	const write = await podmanExec(
		`echo '${written.toString('base64')}' | base64 -d > ${escapeShell(filepath)}`
	);
	if (write.exitCode !== 0) {
		return textResult(`Cannot write the file: ${bounded(write).trimEnd()}`, true);
	}

	return textResult(
		`Replaced at line ${line} of ${filepath}, ${oldBytes.length} -> ${newBytes.length} bytes`
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
