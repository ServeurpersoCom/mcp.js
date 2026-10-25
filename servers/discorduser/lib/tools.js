/**
 * Discord user read module
 * Reads what the user's own Discord account sees, through the client the user
 * already runs, over its Chrome DevTools Protocol debugging port
 *
 * - discord_user_guilds: the servers, in the order of the account's guild bar
 * - discord_user_unread: the unread channels, with their unread and mention counts
 * - discord_user_channels: the channels of a guild, under their categories
 * - discord_user_threads: the threads of a forum or text channel
 * - discord_user_read: the messages of a channel or thread, oldest first
 *
 * Every tool is read only: the page runs frozen snippets that call only the
 * client read gestures, so nothing is posted, no reaction is added and no
 * channel is marked seen. The account never acts, it only reports what it sees
 *
 * With an ssh block the client runs on another machine and a local forward
 * reaches its loopback debugging port; without one the port is local. The key
 * and the host stay in config.json and never reach the model
 */

const { pageTarget, evaluate } = require('./cdp');
const { Tunnel } = require('./tunnel');
const snippets = require('./snippets');
const { textResult } = require('../../../core/tool-result');

const config = require('../config.json').discorduser;

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

const PAGE_URL = 'https://discord.com/';
const SNOWFLAKE = /^\d{17,20}$/;
const ARCHIVE_STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.+-]+$/;
const MESSAGES_PAGE = 50;
const MESSAGES_MAX = 100;

const tunnel = new Tunnel(config);

/**
 * Check a snowflake id, the form every channel and guild id takes
 * @param {*} value
 * @param {string} what Argument name for the error
 * @returns {string}
 */
function snowflake(value, what) {
	const text = value == null ? '' : String(value);
	if (!SNOWFLAKE.test(text)) {
		throw new Error(`Invalid ${what} "${text}", a Discord id`);
	}
	return text;
}

/**
 * Evaluate one snippet in the client page and return its text
 * @param {string} expression
 * @returns {Promise<string>}
 */
async function run(expression) {
	const origin = await tunnel.endpoint();
	const page = await pageTarget(origin, PAGE_URL, config.timeoutMs);
	const value = await evaluate(page.webSocketDebuggerUrl, expression, config.timeoutMs);
	return value == null ? '' : String(value);
}

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
					`\n[cut at ${config.outputLimitBytes} of ${bytes} bytes, page with before]`;
			}
			return textResult(text);
		} catch (error) {
			return textResult(error.message, true);
		}
	};
}

/**
 * The guilds the account is in, in the order of its own guild bar
 */
function guilds() {
	return run(snippets.GUILDS);
}

/**
 * The unread channels across guilds, with unread and mention counts
 */
function unread() {
	return run(snippets.UNREAD);
}

/**
 * The channels of a guild, grouped under their category
 * @param {{guild: string}} args
 */
function channels({ guild }) {
	return run(snippets.channels(JSON.stringify(snowflake(guild, 'guild'))));
}

/**
 * The active and archived threads of a forum or text channel
 * @param {{channel: string, before?: string}} args
 */
function threads({ channel, before }) {
	if (before != null && !ARCHIVE_STAMP.test(String(before))) {
		throw new Error(`Invalid before "${before}", the archive_timestamp from a more: line`);
	}
	return run(
		snippets.threads(
			JSON.stringify(snowflake(channel, 'channel')),
			before == null ? 'null' : JSON.stringify(String(before))
		)
	);
}

/**
 * One page of messages of a channel or thread, oldest first
 * @param {{channel: string, after?: string, before?: string, limit?: number}} args
 */
function read({ channel, after, before, limit = MESSAGES_PAGE }) {
	const count = Math.min(Math.max(Math.trunc(Number(limit)) || MESSAGES_PAGE, 1), MESSAGES_MAX);
	return run(
		snippets.read(
			JSON.stringify(snowflake(channel, 'channel')),
			after == null ? 'null' : JSON.stringify(snowflake(after, 'after')),
			before == null ? 'null' : JSON.stringify(snowflake(before, 'before')),
			count
		)
	);
}

const TOOLS_MAPPING = {
	discord_user_guilds: tool(guilds),
	discord_user_unread: tool(unread),
	discord_user_channels: tool(channels),
	discord_user_threads: tool(threads),
	discord_user_read: tool(read)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
