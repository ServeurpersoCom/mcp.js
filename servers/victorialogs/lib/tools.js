/**
 * VictoriaLogs Tools Module
 * Exposes a VictoriaLogs store to LogsQL queries
 *
 * - victorialogs_query: one LogsQL query, its rows one per line
 *
 * A raw log entry, the row carrying both _msg and _stream, reads as its time,
 * the values of its stream fields, its level and its message. Any other row,
 * the output of a pipe or an entry narrowed by fields, reads as key=value
 * pairs. Line breaks inside a value read as " / ", so a row stays one line
 */

const { query } = require('./api');
const { textResult } = require('../../../core/tool-result');

const config = require('../config.json').victorialogs;

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

/**
 * Turn a handler into a tool, a thrown error becoming an error result and the
 * text keeping its head when it exceeds the output limit
 * @param {function(object): Promise<string>} handler
 * @returns {function(object): Promise<object>}
 */
function tool(handler) {
	return async (args) => {
		try {
			let text = await handler(args);
			const bytes = Buffer.byteLength(text);
			if (bytes > config.outputLimitBytes) {
				text =
					Buffer.from(text).subarray(0, config.outputLimitBytes).toString() +
					`\n[cut at ${config.outputLimitBytes} of ${bytes} bytes]`;
			}
			return textResult(text);
		} catch (error) {
			return textResult(error.message, true);
		}
	};
}

/**
 * Check a row limit
 * @param {*} value
 * @returns {number}
 */
function rowLimit(value) {
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > config.maxLimit) {
		throw new Error(`Invalid limit "${value}", a whole number from 1 to ${config.maxLimit}`);
	}
	return limit;
}

/**
 * Put a value on one line
 * @param {*} value
 * @returns {string}
 */
function flat(value) {
	return String(value).replace(/\r?\n/g, ' / ');
}

/**
 * The values of a stream, in the order of its fields
 * @param {string} stream Like {host="a",app="b"}
 * @returns {string[]}
 */
function streamValues(stream) {
	return [...stream.matchAll(/="((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));
}

/**
 * One row as one line
 * @param {object} row
 * @returns {string}
 */
function line(row) {
	if (row._msg !== undefined && row._stream !== undefined) {
		const head = [row._time, ...streamValues(row._stream), row.level].filter(Boolean);
		return [...head, flat(row._msg)].join(' ');
	}
	return Object.entries(row)
		.map(([key, value]) => {
			const text = flat(value);
			return `${key}=${text === '' || /[\s="]/.test(text) ? JSON.stringify(text) : text}`;
		})
		.join(' ');
}

/**
 * Run a LogsQL query
 * @param {{query: string, limit?: number}} args
 */
async function run({ query: text, limit = config.defaultLimit }) {
	const max = rowLimit(limit);
	const rows = await query(text, max);
	if (!rows.length) {
		return 'No result';
	}
	const lines = rows.map(line);
	if (rows.length === max) {
		lines.push(`[limit of ${max} rows reached, more may match]`);
	}
	return lines.join('\n');
}

const TOOLS_MAPPING = {
	victorialogs_query: tool(run)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
