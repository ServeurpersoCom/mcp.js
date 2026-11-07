/**
 * Memory Tools Module
 * Exposes the store as five tools, the whole surface of the memory protocol
 *
 * - memory_open: read the index, or the full body of the named entries with
 *   numbered lines
 * - memory_grep: find the lines that match a pattern across every entry
 * - memory_write: create an entry, edit its body, refresh its description
 * - memory_move: move whole lines between entries or within one, never deleting
 * - memory_drop: remove an entry
 *
 * A mutation reports the index line of the entry it touched, the model holding
 * the rest of the index from when it opened it, and the tool definitions stay
 * static
 *
 * memory_write anchors its edit on a unique string rather than rewriting the
 * whole body, which keeps concurrent edits of one entry composable and the
 * model output small
 *
 * memory_move addresses lines by the numbers memory_open shows, so text that
 * changes place never travels through the model and arrives byte identical
 */

const store = require('./store');
const { textResult } = require('../../../core/tool-result');

const GREP_MATCH_LIMIT = 200;
const GREP_LINE_CHARS = 240;
const GREP_LEAD_CHARS = 80;
const ELLIPSIS = '...';
const PREVIEW_CHARS = 60;

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

/**
 * Split a body into its lines, the trailing line breaks dropped, so the numbers
 * memory_open shows, memory_grep reports and memory_move takes are the same
 * @param {string} body
 * @returns {string[]}
 */
function bodyLines(body) {
	const text = body.replace(/\n+$/, '');
	return text.length === 0 ? [] : text.split('\n');
}

/**
 * Join lines back into a body
 * @param {string[]} lines
 * @returns {string}
 */
function joinLines(lines) {
	return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/**
 * Parse a line selection such as "12-15,22" against a body of total lines
 * @param {string} spec
 * @param {number} total
 * @returns {number[]} Sorted 1-based line numbers, each once
 */
function parseLines(spec, total) {
	const picked = new Set();

	for (const part of String(spec || '').split(',')) {
		const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
		if (!match) {
			throw new Error(`Invalid line selection "${spec}", expected for instance "12-15,22"`);
		}
		const first = Number(match[1]);
		const last = match[2] == null ? first : Number(match[2]);
		if (first < 1 || last < first || last > total) {
			throw new Error(`Lines "${part.trim()}" fall outside 1-${total}`);
		}
		for (let n = first; n <= last; n++) {
			picked.add(n);
		}
	}

	return [...picked].sort((a, b) => a - b);
}

/**
 * Cut a long matched line to a window around the match
 * @param {string} text
 * @param {number} at - Index of the match
 * @returns {string}
 */
function clip(text, at) {
	if (text.length <= GREP_LINE_CHARS) {
		return text;
	}
	const start = Math.max(0, at - GREP_LEAD_CHARS);
	const end = Math.min(text.length, start + GREP_LINE_CHARS);
	return `${start > 0 ? ELLIPSIS : ''}${text.slice(start, end)}${end < text.length ? ELLIPSIS : ''}`;
}

/**
 * Report a mutation, followed by the index line of the entry it touched
 * @param {string} text
 * @param {object} entry - Entry as stored
 * @returns {object}
 */
function withLine(text, entry) {
	return textResult(`${text}\n${store.line(entry)}`);
}

/**
 * Read the index, or the full body of the named entries
 * @param {{names?: string[]}} args
 * @returns {object}
 */
function tool_memory_open(args) {
	const names = Array.isArray(args.names) ? args.names : [];

	if (names.length === 0) {
		return textResult(store.index());
	}

	const blocks = [];
	let opened = 0;

	for (const name of names) {
		let entry;
		try {
			entry = store.read(name);
		} catch (error) {
			blocks.push(`${name}: ${error.message}`);
			continue;
		}

		if (!entry) {
			blocks.push(`${name}: no such entry`);
			continue;
		}

		opened++;
		const numbered = bodyLines(entry.body)
			.map((text, idx) => `${idx + 1}\t${text}`)
			.join('\n');
		blocks.push(
			`[${name}] [updated: ${entry.updated}] [size: ${entry.bytes} of ${store.limit} bytes, ${store.limit - entry.bytes} free]\n` +
				`${entry.description}\n\n${numbered}`
		);
	}

	return textResult(blocks.join('\n\n'), opened === 0);
}

/**
 * Find the lines that match a pattern across every entry, descriptions included
 * @param {{pattern: string}} args
 * @returns {object}
 */
function tool_memory_grep(args) {
	let regex;
	try {
		regex = new RegExp(String(args.pattern ?? ''));
	} catch (error) {
		return textResult(`Invalid pattern: ${error.message}`, true);
	}

	const found = [];
	let total = 0;

	for (const name of store.list()) {
		const entry = store.read(name);
		if (!entry) {
			continue;
		}
		const rows = [['description', entry.description]].concat(
			bodyLines(entry.body).map((text, idx) => [String(idx + 1), text])
		);
		for (const [where, text] of rows) {
			const match = regex.exec(text);
			if (!match) {
				continue;
			}
			total++;
			if (found.length < GREP_MATCH_LIMIT) {
				found.push(`${name}:${where}: ${clip(text, match.index)}`);
			}
		}
	}

	if (total === 0) {
		return textResult('No match');
	}
	const more =
		total > found.length ? `\n${total - found.length} more matches, narrow the pattern` : '';
	return textResult(`${found.join('\n')}${more}`);
}

/**
 * Create an entry, edit its body, refresh its description
 * @param {{name: string, description?: string, old_str?: string, new_str?: string}} args
 * @returns {object}
 */
function tool_memory_write(args) {
	const name = args.name;
	const oldStr = args.old_str;
	const newStr = args.new_str;

	let entry;
	try {
		entry = store.read(name);
	} catch (error) {
		return textResult(error.message, true);
	}

	if (!entry) {
		if (oldStr != null) {
			return textResult(`No such entry "${name}", nothing to replace`, true);
		}
		if (!args.description) {
			return textResult(`Creating "${name}" needs a description`, true);
		}
		let created;
		try {
			created = store.write({
				name,
				description: args.description,
				body: newStr == null ? '' : newStr
			});
		} catch (error) {
			return textResult(error.message, true);
		}
		return withLine(`Created ${name}`, created);
	}

	let body = entry.body;
	const done = [];

	if (oldStr != null) {
		const at = body.indexOf(oldStr);
		if (at < 0) {
			return textResult(`String not found in ${name}, nothing written`, true);
		}

		const end = at + oldStr.length;
		if (body.indexOf(oldStr, end) >= 0) {
			return textResult(
				`String found ${body.split(oldStr).length - 1} times in ${name}, must be unique, nothing written`,
				true
			);
		}

		if (newStr == null) {
			body = body.slice(0, at) + body.slice(body[end] === '\n' ? end + 1 : end);
			done.push('removed');
		} else {
			body = body.slice(0, at) + newStr + body.slice(end);
			done.push('replaced');
		}
	} else if (newStr != null) {
		body = body.length === 0 || body.endsWith('\n') ? `${body}${newStr}\n` : `${body}\n${newStr}\n`;
		done.push('appended');
	}

	const description = args.description == null ? entry.description : args.description;
	if (args.description != null && args.description !== entry.description) {
		done.push('description refreshed');
	}

	if (done.length === 0) {
		return textResult(`Nothing to do on ${name}`, true);
	}

	let stored;
	try {
		stored = store.write({ name, description, body });
	} catch (error) {
		return textResult(error.message, true);
	}
	return withLine(`${name}: ${done.join(', ')}`, stored);
}

/**
 * Move whole lines from one entry to another, or within one entry
 * A move never deletes: every line lands somewhere, and the destination is
 * written before the source, so an interruption between the two writes leaves
 * the lines twice, never nowhere
 * @param {{from: string, lines: string, to: string, after_str?: string}} args
 * @returns {object}
 */
function tool_memory_move(args) {
	const from = args.from;
	const to = args.to;
	const same = to === from;

	let source;
	let target;
	try {
		source = store.read(from);
		target = same ? null : store.read(to);
	} catch (error) {
		return textResult(error.message, true);
	}
	if (!source) {
		return textResult(`No such entry "${from}"`, true);
	}
	if (!same && !target) {
		return textResult(`No such entry "${to}", create it with memory_write first`, true);
	}

	const sourceLines = bodyLines(source.body);
	let picked;
	try {
		picked = parseLines(args.lines, sourceLines.length);
	} catch (error) {
		return textResult(error.message, true);
	}
	const moved = picked.map((n) => sourceLines[n - 1]);
	const taken = new Set(picked);
	const kept = sourceLines.filter((_, idx) => !taken.has(idx + 1));

	const destLines = same ? kept : bodyLines(target.body);
	let at = destLines.length;
	if (args.after_str != null) {
		const destBody = joinLines(destLines);
		const pos = destBody.indexOf(args.after_str);
		if (pos < 0) {
			return textResult(`after_str not found in ${to}, nothing written`, true);
		}
		if (destBody.indexOf(args.after_str, pos + args.after_str.length) >= 0) {
			return textResult(
				`after_str found more than once in ${to}, must be unique, nothing written`,
				true
			);
		}
		at = destBody
			.slice(0, pos + args.after_str.length)
			.replace(/\n$/, '')
			.split('\n').length;
	}

	const writes = [
		{
			name: to,
			description: (same ? source : target).description,
			body: joinLines([...destLines.slice(0, at), ...moved, ...destLines.slice(at)])
		}
	];
	if (!same) {
		writes.push({ name: from, description: source.description, body: joinLines(kept) });
	}

	const stored = [];
	try {
		for (const entry of writes) {
			stored.push(store.write(entry));
		}
	} catch (error) {
		const done = stored.length === 0 ? 'nothing written' : `${stored[0].name} already written`;
		return textResult(`${error.message}, ${done}`, true);
	}

	const preview = picked
		.map(
			(n, idx) =>
				`${n}\t${moved[idx].slice(0, PREVIEW_CHARS)}${moved[idx].length > PREVIEW_CHARS ? ELLIPSIS : ''}`
		)
		.join('\n');
	const lines = stored.map((entry) => store.line(entry)).join('\n');
	const count = `${picked.length} ${picked.length === 1 ? 'line' : 'lines'}`;
	return textResult(`Moved ${count} from ${from} to ${to}\n${preview}\n${lines}`);
}

/**
 * Remove an entry
 * @param {{name: string}} args
 * @returns {object}
 */
function tool_memory_drop(args) {
	let removed;
	try {
		removed = store.drop(args.name);
	} catch (error) {
		return textResult(error.message, true);
	}

	if (!removed) {
		return textResult(`No such entry "${args.name}"`, true);
	}

	return textResult(`Dropped ${args.name}`);
}

const TOOLS_MAPPING = {
	memory_open: tool_memory_open,
	memory_grep: tool_memory_grep,
	memory_write: tool_memory_write,
	memory_move: tool_memory_move,
	memory_drop: tool_memory_drop
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
