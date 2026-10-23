/**
 * Discord Tools Module
 * Exposes a bot account on one Discord guild over the REST API, no gateway
 *
 * - discord_channels, discord_threads, discord_read: read any channel of the
 *   configured guild
 * - discord_post, discord_edit: write, only in the channels listed in
 *   discord.writeChannels and in the threads they hold
 *
 * The bot token stays in config.json and never reaches the model. Every write
 * goes out with allowed_mentions empty, so nothing written pings a member, a
 * role or everyone. No tool deletes anything
 *
 * A forum post opens a thread, refused when a thread of the same name already
 * exists in that forum, active or archived
 *
 * Every handler renders compact lines, an API failure becoming an error result
 * that carries the status and the body, 429 and its retry_after included
 */

const { snowflake, request } = require('./api');
const { textResult } = require('../../../core/tool-result');

const config = require('../config.json').discord;

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

const TYPES = {
	0: 'text',
	2: 'voice',
	4: 'category',
	5: 'announcement',
	10: 'thread',
	11: 'thread',
	12: 'thread',
	13: 'stage',
	15: 'forum',
	16: 'media'
};
const THREAD_TYPES = [10, 11, 12];
const FORUM_TYPES = [15, 16];
const THREAD_HOLDERS = [0, 5, 15, 16];
const NO_MENTIONS = { parse: [] };
const ARCHIVED_PAGE = 100;
const MESSAGES_PAGE = 50;
const MESSAGES_MAX = 100;
const DISCORD_EPOCH = 1420070400000n;

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
 * Call the API, a non 2xx status throwing with its status and body
 * @param {string} method
 * @param {string} route
 * @param {{query?: object, body?: object}} [options]
 * @returns {Promise<*>} The response body
 */
async function call(method, route, options) {
	const res = await request(method, route, options);
	if (!res.ok) {
		const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
		throw new Error(`HTTP ${res.status} ${body}`);
	}
	return res.data;
}

/**
 * Creation time of a snowflake, as "YYYY-MM-DD HH:MM" in UTC
 * @param {string} id
 * @returns {string}
 */
function when(id) {
	const ms = Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
	return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * The guild id of config.json
 * @returns {string}
 */
function guild() {
	return snowflake(config.guildId, 'discord.guildId');
}

/**
 * A channel or thread of the configured guild
 * @param {string} id
 * @returns {Promise<object>}
 */
async function channel(id) {
	const ch = await call('GET', `/channels/${snowflake(id, 'channel')}`);
	if (ch.guild_id !== guild()) {
		throw new Error(`Channel ${id} is not in the configured guild`);
	}
	return ch;
}

/**
 * Whether the bot may write in a channel: listed in discord.writeChannels, or
 * a thread of a listed channel
 * @param {object} ch
 * @returns {boolean}
 */
function writable(ch) {
	const list = config.writeChannels;
	return list.includes(ch.id) || (THREAD_TYPES.includes(ch.type) && list.includes(ch.parent_id));
}

/**
 * Tag names of a forum, by id
 * @param {object} ch
 * @returns {Object<string, string>}
 */
function tagNames(ch) {
	return Object.fromEntries((ch.available_tags || []).map((tag) => [tag.id, tag.name]));
}

/**
 * One line per thread
 * @param {object} t
 * @param {Object<string, string>} tags
 * @param {boolean} archived
 * @returns {string}
 */
function threadLine(t, tags, archived) {
	const applied = (t.applied_tags || []).map((id) => tags[id] || id);
	return (
		`${t.id} ${t.name} | ${when(t.id)} | ${t.message_count} msgs` +
		(applied.length ? ` | tags ${applied.join(' ')}` : '') +
		(archived ? ' | archived' : '')
	);
}

/**
 * Active threads of a channel, newest first
 * @param {object} ch
 * @returns {Promise<object[]>}
 */
async function activeThreads(ch) {
	const data = await call('GET', `/guilds/${guild()}/threads/active`);
	return data.threads
		.filter((t) => t.parent_id === ch.id)
		.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
}

/**
 * One page of the public archived threads of a channel
 * @param {object} ch
 * @param {string} [before] archive_timestamp the page ends before
 * @returns {Promise<{threads: object[], has_more: boolean}>}
 */
function archivedThreads(ch, before) {
	return call('GET', `/channels/${ch.id}/threads/archived/public`, {
		query: { limit: ARCHIVED_PAGE, before }
	});
}

/**
 * Id of the thread of a channel bearing exactly this name, active or archived
 * @param {object} ch
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function findThread(ch, name) {
	const active = (await activeThreads(ch)).find((t) => t.name === name);
	if (active) {
		return active.id;
	}
	let before;
	for (;;) {
		const page = await archivedThreads(ch, before);
		const found = page.threads.find((t) => t.name === name);
		if (found) {
			return found.id;
		}
		if (!page.has_more || page.threads.length === 0) {
			return null;
		}
		before = page.threads[page.threads.length - 1].thread_metadata.archive_timestamp;
	}
}

/**
 * Channels of the guild, grouped under their category
 */
async function channels() {
	const list = await call('GET', `/guilds/${guild()}/channels`);
	const byId = Object.fromEntries(list.map((c) => [c.id, c]));
	const rank = (c) => {
		const parent = byId[c.parent_id];
		return parent ? [parent.position, c.position] : [-1, c.position];
	};

	const lines = list
		.filter((c) => c.type !== 4)
		.sort((a, b) => {
			const [pa, ca] = rank(a);
			const [pb, cb] = rank(b);
			return pa - pb || ca - cb;
		})
		.map((c) => {
			const parent = byId[c.parent_id];
			const tags = Object.values(tagNames(c));
			return (
				`${c.id} ${TYPES[c.type] || c.type} #${c.name}` +
				(parent ? ` | in ${parent.name}` : '') +
				(tags.length ? ` | tags ${tags.join(' ')}` : '') +
				(writable(c) ? ' | write' : '')
			);
		});
	return lines.join('\n') || 'No channel';
}

/**
 * Threads of a forum or text channel: the active ones and a page of archives
 * on the first call, the next archive page when before is given
 * @param {{channel: string, before?: string}} args
 */
async function threads({ channel: id, before }) {
	const ch = await channel(id);
	if (!THREAD_HOLDERS.includes(ch.type)) {
		throw new Error(`#${ch.name} holds no threads`);
	}
	const tags = tagNames(ch);

	const lines = [];
	if (!before) {
		for (const t of await activeThreads(ch)) {
			lines.push(threadLine(t, tags, false));
		}
	}
	const page = await archivedThreads(ch, before);
	for (const t of page.threads) {
		lines.push(threadLine(t, tags, true));
	}
	if (page.has_more && page.threads.length) {
		const last = page.threads[page.threads.length - 1];
		lines.push(`more: before=${last.thread_metadata.archive_timestamp}`);
	}
	return lines.join('\n') || `No thread in #${ch.name}`;
}

/**
 * Messages of a channel or thread, oldest first, the newest page by default
 * @param {{channel: string, before?: string, limit?: number}} args
 */
async function read({ channel: id, before, limit = MESSAGES_PAGE }) {
	const ch = await channel(id);
	const count = Math.min(Math.max(Math.trunc(Number(limit)) || MESSAGES_PAGE, 1), MESSAGES_MAX);
	const messages = await call('GET', `/channels/${ch.id}/messages`, {
		query: { limit: count, before: before == null ? undefined : snowflake(before, 'before') }
	});

	const lines = messages.reverse().map((m) => {
		const files = (m.attachments || []).map((a) => ` [file ${a.filename}]`).join('');
		const embeds = m.embeds && m.embeds.length ? ` [${m.embeds.length} embeds]` : '';
		return `${m.id} ${when(m.id)} ${m.author.username}: ${m.content}${files}${embeds}`;
	});
	if (messages.length === count) {
		lines.push(`more: before=${messages[0].id}`);
	}
	return lines.join('\n') || `No message in #${ch.name}`;
}

/**
 * Post a message, or open a thread when the channel is a forum
 * @param {{channel: string, content: string, thread_name?: string, tags?: string[]}} args
 */
async function post({ channel: id, content, thread_name, tags }) {
	const ch = await channel(id);
	if (!writable(ch)) {
		throw new Error(`#${ch.name} is not writable, see discord.writeChannels`);
	}

	if (!FORUM_TYPES.includes(ch.type)) {
		if (thread_name != null || tags != null) {
			throw new Error(`Thread_name and tags only apply to a forum, #${ch.name} is not one`);
		}
		const m = await call('POST', `/channels/${ch.id}/messages`, {
			body: { content, allowed_mentions: NO_MENTIONS }
		});
		return `Message ${m.id} posted in #${ch.name}`;
	}

	if (!thread_name) {
		throw new Error(`Thread_name argument required, #${ch.name} is a forum`);
	}
	if (tags != null && !Array.isArray(tags)) {
		throw new Error('Tags argument is not a list');
	}
	const ids = Object.fromEntries((ch.available_tags || []).map((tag) => [tag.name, tag.id]));
	const applied = (tags || []).map((name) => {
		if (!ids[name]) {
			throw new Error(`Unknown tag "${name}" in #${ch.name}, tags: ${Object.keys(ids).join(' ')}`);
		}
		return ids[name];
	});

	const existing = await findThread(ch, thread_name);
	if (existing) {
		throw new Error(`Thread "${thread_name}" already exists in #${ch.name}: ${existing}`);
	}

	const t = await call('POST', `/channels/${ch.id}/threads`, {
		body: {
			name: thread_name,
			applied_tags: applied,
			message: { content, allowed_mentions: NO_MENTIONS }
		}
	});
	return `Thread ${t.id} "${t.name}" created in #${ch.name}`;
}

/**
 * Edit a message of the bot
 * @param {{channel: string, message_id: string, content: string}} args
 */
async function edit({ channel: id, message_id, content }) {
	const ch = await channel(id);
	if (!writable(ch)) {
		throw new Error(`#${ch.name} is not writable, see discord.writeChannels`);
	}
	const m = await call(
		'PATCH',
		`/channels/${ch.id}/messages/${snowflake(message_id, 'message_id')}`,
		{
			body: { content, allowed_mentions: NO_MENTIONS }
		}
	);
	return `Message ${m.id} edited in #${ch.name}`;
}

const TOOLS_MAPPING = {
	discord_channels: tool(channels),
	discord_threads: tool(threads),
	discord_read: tool(read),
	discord_post: tool(post),
	discord_edit: tool(edit)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
