/**
 * Memory Tools Module
 * Exposes the store as three tools, the whole surface of the memory protocol
 *
 * - memory_open: read the index, or the full body of the named entries
 * - memory_write: create an entry, edit its body, refresh its description
 * - memory_drop: remove an entry
 *
 * A mutation reports the index line of the entry it touched, the model holding
 * the rest of the index from when it opened it, and the tool definitions stay
 * static
 *
 * memory_write anchors its edit on a unique string rather than rewriting the
 * whole body, which keeps concurrent edits of one entry composable and the
 * model output small
 */

const store = require('./store');
const { textResult } = require('../../../core/tool-result');

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

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
		blocks.push(
			`[${name}] [updated: ${entry.updated}] [size: ${entry.bytes} of ${store.limit} bytes, ${store.limit - entry.bytes} free]\n` +
				`${entry.description}\n\n${entry.body.trimEnd()}`
		);
	}

	return textResult(blocks.join('\n\n'), opened === 0);
}

const MEMORY_WRITE_KEYS = ['name', 'description', 'old_str', 'new_str'];

/**
 * Create an entry, edit its body, refresh its description
 * @param {{name: string, description?: string, old_str?: string, new_str?: string}} args
 * @returns {object}
 */
function tool_memory_write(args) {
	const name = args.name;
	const oldStr = args.old_str;
	const newStr = args.new_str;

	// An unknown key carries the text when its name is wrong, and the call
	// then removes old_str or does nothing at all
	const unknown = Object.keys(args).filter((key) => !MEMORY_WRITE_KEYS.includes(key));
	if (unknown.length > 0) {
		return textResult(
			`Unknown argument ${unknown.join(', ')}, the text goes in old_str and new_str`,
			true
		);
	}

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
	memory_write: tool_memory_write,
	memory_drop: tool_memory_drop
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
