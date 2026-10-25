/**
 * Discord user module
 * Acts as the user's own Discord account, through the client the user already
 * runs, over its Chrome DevTools Protocol debugging port
 *
 * - discord_user_guilds: the direct messages as @me, then the servers in the
 *   order of the account's guild bar
 * - discord_user_unread: the unread conversations, with unread and mention counts
 * - discord_user_channels: the viewable channels of a guild under their
 *   categories, or the direct messages for @me
 * - discord_user_threads: the threads of a forum or text channel
 * - discord_user_read: the messages of a channel or thread, oldest first,
 *   marking them read as the client does
 * - discord_user_search: the messages a search finds in a server or a direct
 *   message
 * - discord_user_post: a message, a reply, or a thread when the channel is a
 *   forum
 * - discord_user_edit: new content for a message of the account
 * - discord_user_react: a reaction of the account, added or taken back
 * - discord_user_edit_thread: a thread renamed, archived, locked or retagged
 *
 * Reading through these tools is the user reading, so a read acks what it
 * shows, and what is posted is the user writing, mentions included. The page
 * runs frozen snippets fed only with checked, JSON encoded values
 *
 * With an ssh block the client runs on another machine and each call opens a
 * forward to its loopback debugging port; without one the port is local. The
 * key and the host stay in config.json and never reach the model
 */

const { pageTarget, evaluate } = require('./cdp');
const { withEndpoint } = require('./tunnel');
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
const SEARCH_PAGE = 25;
const SEARCH_OFFSET_MAX = 9975;
const DM_GUILD = '@me';

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
 * An optional snowflake as a snippet argument, the literal null when absent
 * @param {*} value
 * @param {string} what Argument name for the error
 * @returns {string}
 */
function optional(value, what) {
	return value == null ? 'null' : JSON.stringify(snowflake(value, what));
}

/**
 * Check an optional boolean argument
 * @param {*} value
 * @param {string} what Argument name for the error
 * @returns {boolean|undefined}
 */
function flag(value, what) {
	if (value != null && typeof value !== 'boolean') {
		throw new Error(`${what} argument is not a boolean`);
	}
	return value == null ? undefined : value;
}

/**
 * Check an optional list of tag names
 * @param {*} tags
 */
function tagList(tags) {
	if (tags != null && (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string'))) {
		throw new Error('Tags argument is not a list of names');
	}
}

/**
 * Evaluate one snippet in the client page and return its text, through a
 * forward opened for this call when the port is remote; the error a snippet
 * resolves to is thrown with its message
 * @param {string} expression
 * @returns {Promise<string>}
 */
function run(expression) {
	return withEndpoint(config, async (origin) => {
		const page = await pageTarget(origin, PAGE_URL, config.timeoutMs);
		const value = await evaluate(page.webSocketDebuggerUrl, expression, config.timeoutMs);
		if (value && value.error != null) {
			throw new Error(value.error);
		}
		return value == null ? '' : String(value);
	});
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
 * The direct messages as @me, then the guilds in the order of the guild bar
 */
function guilds() {
	return run(snippets.GUILDS);
}

/**
 * The unread conversations, direct messages first, with unread and mention
 * counts
 */
function unread() {
	return run(snippets.UNREAD);
}

/**
 * The viewable channels of a guild under their category, or the direct
 * messages for @me
 * @param {{guild: string}} args
 */
function channels({ guild }) {
	const id = guild === DM_GUILD ? DM_GUILD : snowflake(guild, 'guild');
	return run(snippets.channels(JSON.stringify(id)));
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
 * One page of messages of a channel or thread, oldest first: the newest page
 * by default, the page after a message, around it or before it
 * @param {{channel: string, after?: string, around?: string, before?: string, limit?: number}} args
 */
function read({ channel, after, around, before, limit = MESSAGES_PAGE }) {
	const count = Math.min(Math.max(Math.trunc(Number(limit)) || MESSAGES_PAGE, 1), MESSAGES_MAX);
	return run(
		snippets.read(
			JSON.stringify(snowflake(channel, 'channel')),
			optional(after, 'after'),
			optional(around, 'around'),
			optional(before, 'before'),
			count
		)
	);
}

/**
 * One page of the messages a search finds, newest first
 * @param {{guild: string, query: string, channel?: string, author?: string, offset?: number}} args
 */
function search({ guild, query, channel, author, offset }) {
	const gid = guild === DM_GUILD ? DM_GUILD : snowflake(guild, 'guild');
	if (gid === DM_GUILD && channel == null) {
		throw new Error('Channel argument required, a direct message search names its conversation');
	}
	const q = { content: query };
	if (channel != null) {
		q.channel_id = snowflake(channel, 'channel');
	}
	if (author != null) {
		q.author_id = snowflake(author, 'author');
	}
	const from = Math.min(Math.max(Math.trunc(Number(offset)) || 0, 0), SEARCH_OFFSET_MAX);
	if (from) {
		q.offset = from;
	}
	return run(snippets.search(JSON.stringify(gid), JSON.stringify(q), SEARCH_PAGE));
}

/**
 * Post a message or a reply, or open a thread when the channel is a forum
 * @param {{channel: string, content: string, reply_to?: string, thread_name?: string, tags?: string[]}} args
 */
function post({ channel, content, reply_to, thread_name, tags }) {
	tagList(tags);
	return run(
		snippets.post(
			JSON.stringify(snowflake(channel, 'channel')),
			JSON.stringify(String(content)),
			optional(reply_to, 'reply_to'),
			thread_name == null ? 'null' : JSON.stringify(String(thread_name)),
			tags == null ? 'null' : JSON.stringify(tags)
		)
	);
}

/**
 * Replace the content of a message of the account
 * @param {{channel: string, message_id: string, content: string}} args
 */
function edit({ channel, message_id, content }) {
	return run(
		snippets.edit(
			JSON.stringify(snowflake(channel, 'channel')),
			JSON.stringify(snowflake(message_id, 'message_id')),
			JSON.stringify(String(content))
		)
	);
}

/**
 * Add a reaction of the account to a message, or take it back with remove
 * @param {{channel: string, message_id: string, emoji: string, remove?: boolean}} args
 */
function react({ channel, message_id, emoji, remove }) {
	const off = flag(remove, 'Remove');
	return run(
		snippets.react(
			JSON.stringify(snowflake(channel, 'channel')),
			JSON.stringify(snowflake(message_id, 'message_id')),
			JSON.stringify(String(emoji)),
			off === true
		)
	);
}

/**
 * Rename, archive, lock or retag a thread
 * @param {{thread: string, name?: string, archived?: boolean, locked?: boolean, tags?: string[]}} args
 */
function editThread({ thread, name, archived, locked, tags }) {
	const changes = { name, archived: flag(archived, 'Archived'), locked: flag(locked, 'Locked') };
	tagList(tags);
	return run(
		snippets.editThread(
			JSON.stringify(snowflake(thread, 'thread')),
			JSON.stringify(changes),
			tags == null ? 'null' : JSON.stringify(tags)
		)
	);
}

const TOOLS_MAPPING = {
	discord_user_guilds: tool(guilds),
	discord_user_unread: tool(unread),
	discord_user_channels: tool(channels),
	discord_user_threads: tool(threads),
	discord_user_read: tool(read),
	discord_user_search: tool(search),
	discord_user_post: tool(post),
	discord_user_edit: tool(edit),
	discord_user_react: tool(react),
	discord_user_edit_thread: tool(editThread)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
