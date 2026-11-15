/**
 * Sandbox Tools Module
 * Provides isolated code execution in a Podman container
 * Isomorphic to Anthropic's Claude computer-use tools, its results worded as
 * the tools of the KiSS backend word theirs
 *
 * - bash_tool: the command on stdin, the merged output back with the exit
 *   code and the duration, a kill at the timeout named
 * - view: a directory two levels deep with the size of all each entry holds,
 *   an image fitted within the limits after a line saying what it is and what
 *   was sent, a text file with numbered lines
 * - create_file: a file written whole, empty or not, its directories made
 * - str_replace: the one place a file holds a string, replaced in place
 *
 * The core checks the arguments of every call against the schema of its tool
 * before the handler runs
 *
 * A path is taken whole as given and one holding a NUL byte is refused. Files
 * travel as base64 in both directions, so no byte goes through a text decoder
 * and a file in any encoding keeps its bytes
 *
 * Long output keeps its head and its tail, cut on line ends, the bytes hidden
 * between them counted
 *
 * The internal scripts run under the C locale, so the reason a system call
 * gives comes back in plain ASCII, the way strerror words it
 */

const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { podmanExec, escapeShell } = require('./podman-executor');
const { imageType, imageResults } = require('../../../core/image');
const { textResult } = require('../../../core/tool-result');

// Load tools definitions from tools.json once at startup
const toolsDefinitionPath = path.join(__dirname, '..', 'tools.json');
const rawDefinitions = JSON.parse(fs.readFileSync(toolsDefinitionPath, 'utf8'));
const TOOLS_DEFINITIONS = rawDefinitions.map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

// The byte a line of output ends with
const NEWLINE = 0x0a;

// The pixels view decodes at most, and the longest side and the JPEG quality
// of an image it makes again
const IMAGE_LIMITS = {
	pixels: config.podman.maxMegapixels * 1000000,
	side: config.podman.maxDimension,
	quality: config.podman.jpegQuality
};

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
 * A size as du -h writes it: 512, 4.0K, 12K, 1.5M
 * @param {number} n Bytes
 * @returns {string}
 */
function human(n) {
	if (n < 1024) {
		return String(n);
	}
	const units = 'KMGTPE';
	let v = n / 1024;
	let u = 0;
	while (v >= 1024 && u < 5) {
		v /= 1024;
		u++;
	}
	const tenth = Math.ceil(v * 10) / 10;
	return tenth < 10 ? `${tenth.toFixed(1)}${units[u]}` : `${Math.ceil(v)}${units[u]}`;
}

/**
 * An entry the listing shows: no hidden part, nothing below node_modules
 * @param {string} rel Path relative to the listed directory, empty for itself
 * @returns {boolean}
 */
function shown(rel) {
	const parts = rel === '' ? [] : rel.split('/');
	const last = parts[parts.length - 1];
	return parts.every(
		(part) => !part.startsWith('.') && !(part === 'node_modules' && part !== last)
	);
}

/**
 * A path of the listed directory as the given path joins it
 * @param {string} given
 * @param {string} rel
 * @returns {string}
 */
function under(given, rel) {
	if (rel === '') {
		return given;
	}
	return given.endsWith('/') ? given + rel : `${given}/${rel}`;
}

/**
 * The line that counts the bytes a cut hides
 * @param {number} n
 * @returns {string}
 */
const hiddenLine = (n) => `Long output with ${n} bytes hidden from context\n`;

/**
 * The bytes past the whole lines at the front that hold n bytes or more, none
 * when no line ends there
 * @param {Buffer} bytes
 * @param {number} n
 * @returns {Buffer}
 */
function dropFront(bytes, n) {
	const at = bytes.indexOf(NEWLINE, n - 1);
	return at < 0 ? bytes.subarray(bytes.length) : bytes.subarray(at + 1);
}

/**
 * The bytes before the whole lines at the back that hold n bytes or more
 * @param {Buffer} bytes
 * @param {number} n
 * @returns {Buffer}
 */
function dropBack(bytes, n) {
	const room = Math.max(bytes.length - n, 0);
	const at = room === 0 ? -1 : bytes.lastIndexOf(NEWLINE, room - 1);
	return bytes.subarray(0, at + 1);
}

/**
 * A head and a tail as one text, the bytes hidden between them counted, both
 * cuts on line ends when the kept bytes hold one, the head, the line and the
 * tail within the budget together, so a client that cuts it again within the
 * same budget changes nothing
 * @param {{head: Buffer, tail: Buffer, total: number, truncated: boolean}} kept
 * @param {number} [budget] Bytes of the text at most
 * @returns {string}
 */
function bounded(kept, budget = config.podman.outputLimitBytes) {
	if (!kept.truncated) {
		return Buffer.concat([kept.head, kept.tail]).toString();
	}
	const end = kept.head.lastIndexOf(NEWLINE);
	const begin = kept.tail.indexOf(NEWLINE);
	let first = Buffer.from(end < 0 ? `${kept.head}\n` : kept.head.subarray(0, end + 1).toString());
	let last = Buffer.from((begin < 0 ? kept.tail : kept.tail.subarray(begin + 1)).toString());
	// The bytes of the output the head and the tail still show
	let shownFirst = end < 0 ? kept.head.length : end + 1;
	let shownLast = begin < 0 ? kept.tail.length : kept.tail.length - begin - 1;
	// Whole lines go from the larger of the head and the tail, the head on a
	// tie, so the end of the output, and the line that closes it, stays
	for (;;) {
		const line = Buffer.from(hiddenLine(kept.total - shownFirst - shownLast));
		const size = first.length + line.length + last.length;
		if (size <= budget || (!first.length && !last.length)) {
			return Buffer.concat([first, line, last]).toString();
		}
		if (first.length && first.length >= last.length) {
			const rest = dropBack(first, size - budget);
			shownFirst = rest.length ? shownFirst - Math.min(first.length - rest.length, shownFirst) : 0;
			first = rest;
		} else {
			const rest = dropFront(last, size - budget);
			shownLast = rest.length ? shownLast - Math.min(last.length - rest.length, shownLast) : 0;
			last = rest;
		}
	}
}

/**
 * A whole buffer kept as a head and a tail within the output limit
 * @param {Buffer} buffer
 * @returns {{head: Buffer, tail: Buffer, total: number, truncated: boolean}}
 */
function held(buffer) {
	const headMax = Math.floor(config.podman.outputLimitBytes / 2);
	const tailMax = config.podman.outputLimitBytes - headMax;
	return {
		head: buffer.subarray(0, headMax),
		tail: buffer.subarray(Math.max(headMax, buffer.length - tailMax)),
		total: buffer.length,
		truncated: buffer.length > headMax + tailMax
	};
}

/**
 * The output with a closing line after it, on a line of its own, kept within
 * the output limit as the output is
 * @param {{head: Buffer, tail: Buffer, total: number, truncated: boolean}} output
 * @param {string} line
 * @returns {{head: Buffer, tail: Buffer, total: number, truncated: boolean}}
 */
function closed(output, line) {
	const end = output.tail.length ? output.tail.at(-1) : output.head.at(-1);
	const added = Buffer.from((output.total && end !== NEWLINE ? '\n' : '') + line);
	if (!output.truncated) {
		return held(Buffer.concat([output.head, output.tail, added]));
	}
	const tailMax = config.podman.outputLimitBytes - Math.floor(config.podman.outputLimitBytes / 2);
	const tail = Buffer.concat([output.tail, added]);
	return {
		head: output.head,
		tail: tail.subarray(Math.max(0, tail.length - tailMax)),
		total: output.total + added.length,
		truncated: true
	};
}

/**
 * A whole buffer and its closing line within the output limit, head and tail
 * @param {Buffer} buffer
 * @param {string} line
 * @returns {string}
 */
function clipped(buffer, line) {
	return bounded(closed(held(buffer), line));
}

/**
 * Shell lines that print a regular file as base64 then a FILE line, or one
 * line saying why not: BIG <first bytes in base64>, OTHER, NONE
 * @param {string} quoted Path quoted for the shell
 * @returns {string}
 */
function readScript(quoted) {
	return [
		'export LC_ALL=C',
		`p=${quoted}`,
		'if [ -f "$p" ]; then',
		'  s=$(stat -c %s -- "$p")',
		`  if [ "$s" -gt ${config.podman.fileLimitBytes} ]; then echo "BIG $(head -c 16 -- "$p" | base64 -w 0)"; else base64 -w 0 -- "$p" && echo && echo FILE; fi`,
		'elif [ -e "$p" ]; then echo OTHER',
		'else echo NONE',
		'fi'
	].join('\n');
}

/**
 * Shell lines that write base64 bytes to a file, its directory made, ending
 * on MKDIR <reason> or WRITE <reason> when the system refuses
 * @param {string} quoted Path quoted for the shell
 * @param {Buffer} bytes
 * @returns {string}
 */
function writeScript(quoted, bytes) {
	return [
		'export LC_ALL=C',
		`p=${quoted}`,
		'if ! m=$(mkdir -p -- "$(dirname -- "$p")" 2>&1); then echo "MKDIR ${m##*: }"; exit 1; fi',
		`if ! w=$( { echo '${bytes.toString('base64')}' | base64 -d > "$p"; } 2>&1 ); then echo "WRITE \${w##*: }"; exit 1; fi`
	].join('\n');
}

/**
 * Why a write script failed, worded as KiSS words it
 * @param {{head: Buffer, tail: Buffer, total: number, truncated: boolean}} result
 * @returns {string}
 */
function writeFailure(result) {
	const { marker } = marked(result);
	if (marker.startsWith('MKDIR ')) {
		return `Cannot make the directory: ${marker.slice(6)}`;
	}
	if (marker.startsWith('WRITE ')) {
		return `Cannot write the file: ${marker.slice(6)}`;
	}
	return `Cannot write the file: ${bounded(result).trimEnd()}`;
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
 * @param {boolean} images Whether an image too large is named an image
 * @returns {{data?: Buffer, error?: string}}
 */
function fileOf(filepath, result, other, images) {
	const { marker, body } = marked(result);
	if (marker === 'FILE' && !result.truncated) {
		return { data: Buffer.from(body, 'base64') };
	}
	if (marker.startsWith('BIG ')) {
		const kind = images && imageType(Buffer.from(marker.slice(4), 'base64')) ? 'Image' : 'File';
		return { error: `${kind} larger than ${config.podman.fileLimitBytes} bytes` };
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
 * A directory as KiSS lists it: every entry two levels deep sorted by path,
 * each with the size of all the regular files it holds, then the count of the
 * entries and of the hidden ones
 * @param {string} given The path as the call gave it
 * @param {string} body E and F records the directory script printed
 * @returns {string}
 */
function listing(given, body) {
	const sizes = new Map([['', 0]]);
	let hidden = 0;
	const files = [];
	for (const record of body.split('\0')) {
		if (record.startsWith('E')) {
			const rel = record.slice(1);
			const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
			const name = rel.slice(rel.lastIndexOf('/') + 1);
			if (shown(rel)) {
				sizes.set(rel, 0);
			} else if (
				name.startsWith('.') &&
				shown(parent) &&
				parent.slice(parent.lastIndexOf('/') + 1) !== 'node_modules'
			) {
				hidden++;
			}
		} else if (record.startsWith('F')) {
			const space = record.indexOf(' ');
			files.push([Number(record.slice(1, space)), record.slice(space + 1)]);
		}
	}

	// A file counts in the root and in its two first ancestors, itself included
	for (const [size, rel] of files) {
		sizes.set('', sizes.get('') + size);
		const parts = rel.split('/');
		for (let depth = 1; depth <= Math.min(2, parts.length); depth++) {
			const prefix = parts.slice(0, depth).join('/');
			if (sizes.has(prefix)) {
				sizes.set(prefix, sizes.get(prefix) + size);
			}
		}
	}

	const lines = [...sizes.keys()]
		.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		.map((rel) => `${human(sizes.get(rel))} ${under(given, rel)}\n`);
	const tail = hidden > 0 ? `, ${hidden} hidden` : '';
	return clipped(Buffer.from(lines.join('')), counted(sizes.size - 1, 'entry', 'entries') + tail);
}

/**
 * Tool: bash_tool
 * The command on stdin, the merged output back with the exit code, its lines
 * shown to the client as they come
 * @param {object} args Tool arguments
 * @param {function(string): void} [partial] Takes the output as it comes, none for a call that streams nothing
 * @param {AbortSignal} signal Ends the command once its client cancels the call
 * @returns {Promise<object>} Tool result
 */
async function tool_bash(args = {}, partial, signal) {
	const t0 = Date.now();
	const result = await podmanExec(args.command, undefined, partial, signal);
	const elapsed = Date.now() - t0;

	// timeout exits 124 when it kills the command, the elapsed time tells it
	// from a command that exits 124 itself; the line that tells how the call
	// ended closes the output, within the output limit
	if (result.exitCode === 124 && elapsed >= config.podman.timeout * 1000) {
		return textResult(bounded(closed(result, `Killed after ${config.podman.timeout} s`)), true);
	}
	return textResult(
		bounded(closed(result, `Exit code ${result.exitCode} (${elapsed} ms)`)),
		result.exitCode !== 0
	);
}

/**
 * Tool: view
 * A directory listing, an image, or a text file with numbered lines
 * @param {object} args Tool arguments
 * @returns {Promise<object|object[]>} Tool result
 */
async function tool_view(args = {}) {
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

	// One call: for a directory, its entries two levels deep (E) and every regular
	// file below it with its size (F), NUL separated, then DIR; else the read script
	const quoted = escapeShell(filepath);
	const script = [
		'export LC_ALL=C',
		`if [ -d ${quoted} ]; then`,
		`  cd ${quoted} || exit 1`,
		"  find . -mindepth 1 -maxdepth 2 -printf 'E%P\\0' 2>/dev/null",
		"  find . -type f -printf 'F%s %P\\0' 2>/dev/null",
		'  echo',
		'  echo DIR',
		'else',
		readScript(quoted),
		'fi'
	].join('\n');
	const result = await podmanExec(script, FILE_CAP_BYTES);

	const { marker, body } = marked(result);
	if (marker === 'DIR') {
		if (result.truncated) {
			return textResult(`Directory too large to list: ${filepath}`, true);
		}
		return textResult(listing(filepath, body));
	}

	const file = fileOf(filepath, result, 'Neither a regular file nor a directory', true);
	if (file.error) {
		return textResult(file.error, true);
	}

	if (imageType(file.data)) {
		return imageResults(file.data, IMAGE_LIMITS);
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
	return textResult(clipped(Buffer.from(numbered), summary));
}

/**
 * Tool: create_file
 * A file written whole with the text given, its parent directories made, a
 * file already there written over
 * @param {object} args Tool arguments
 * @returns {Promise<object>} Tool result
 */
async function tool_create_file(args = {}) {
	const filepath = args.path;
	if (filepath.includes('\0')) {
		return textResult('Path holds a NUL byte', true);
	}

	const text = args.file_text;
	const quoted = escapeShell(filepath);
	const script = `if [ -e ${quoted} ]; then echo THERE; fi\n${writeScript(quoted, Buffer.from(text))}`;
	const result = await podmanExec(script);
	if (result.exitCode !== 0) {
		return textResult(writeFailure(result), true);
	}

	const lines = text.split('\n').length - 1 + (text !== '' && !text.endsWith('\n') ? 1 : 0);
	const verb = bounded(result).startsWith('THERE') ? 'Overwrote' : 'Created';
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
	const filepath = args.path;
	if (filepath.includes('\0')) {
		return textResult('Path holds a NUL byte', true);
	}

	const read = await podmanExec(readScript(escapeShell(filepath)), FILE_CAP_BYTES);
	const file = fileOf(filepath, read, 'Not a regular file', false);
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
	const write = await podmanExec(writeScript(escapeShell(filepath), written));
	if (write.exitCode !== 0) {
		return textResult(writeFailure(write), true);
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
