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
const { imageType, imageFit } = require('./image');
const { textResult, imageResult } = require('../../../core/tool-result');

// Load tools definitions from tools.json once at startup
const toolsDefinitionPath = path.join(__dirname, '..', 'tools.json');
const rawDefinitions = JSON.parse(fs.readFileSync(toolsDefinitionPath, 'utf8'));
const TOOLS_DEFINITIONS = rawDefinitions.map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

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
	return clipped(Buffer.from(lines.join(''))) + counted(sizes.size - 1, 'entry', 'entries') + tail;
}

/**
 * Tool: bash_tool
 * The command on stdin, the merged output back with the exit code
 * @param {object} args Tool arguments
 * @returns {Promise<object>} Tool result
 */
async function tool_bash(args = {}) {
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
		const sent = await imageFit(file.data, IMAGE_LIMITS);
		if (sent.error) {
			return textResult(sent.error, true);
		}
		const described = (mime, width, height, bytes) => `${mime} ${width}x${height}, ${bytes} bytes`;
		let line = `Image ${described(sent.sourceMime, sent.sourceWidth, sent.sourceHeight, file.data.length)}`;
		if (sent.made) {
			line += `, sent as ${described(sent.mime, sent.width, sent.height, sent.data.length)}`;
			line += sent.transparent ? ', its transparency laid on white' : '';
		}
		return [textResult(line), imageResult(sent.data.toString('base64'), sent.mime)];
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
