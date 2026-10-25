/**
 * Discord bot module
 * Exposes a bot account over the Discord REST API, no gateway
 *
 * - discord_bot_channels, discord_bot_threads, discord_bot_read,
 *   discord_bot_image: read
 * - discord_bot_post, discord_bot_edit, discord_bot_react,
 *   discord_bot_edit_thread: write
 *
 * What the bot may see and write is the permissions Discord grants its role,
 * set per channel in the guild settings; discord_bot_channels lists only the
 * channels those permissions let it view
 *
 * The bot token stays in config.json and never reaches the model. What the
 * bot writes pings the mentions in it as its role allows, everyone and roles
 * included only with the Mention Everyone permission. No tool deletes a
 * message, a reaction of the bot is the only thing it takes back
 *
 * A forum post opens a thread. Messages render as in discorduser, one line
 * each with names for ids, replies, files, stickers, embeds, polls, forwarded
 * messages and reactions
 *
 * Every handler renders compact lines, an API failure becoming an error result
 * that carries the status and the body, 429 and its retry_after included
 */

const { snowflake, request } = require('./api');
const { author, message } = require('./render');
const { imageType, imageResults } = require('../../../core/image');
const { textResult } = require('../../../core/tool-result');

const config = require('../config.json').discordbot;

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
const FORUM_TYPES = [15, 16];
const THREAD_TYPES = [10, 11, 12];
const THREAD_HOLDERS = [0, 5, 15, 16];
const NOT_VIEWABLE = [403, 404];
const ARCHIVED_PAGE = 100;
const MESSAGES_PAGE = 50;
const MESSAGES_MAX = 100;
const IMAGE_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
const IMAGE_LIMITS = {
	pixels: config.maxMegapixels * 1000000,
	side: config.maxDimension,
	quality: config.jpegQuality
};
const DISCORD_EPOCH = 1420070400000n;
const VIEW_CHANNEL = 1024n;
const ADMINISTRATOR = 8n;
const USER_MENTION = /<@!?(\d+)>/g;
const ROLE_MENTION = /<@&\d+>/;
const CHANNEL_LINK = /<#\d+>/;
const CUSTOM_EMOJI = /^\w+:\d{17,20}$/;
const EMOJI_NAME = /^\w+$/;

/**
 * Turn a handler into a tool, a thrown error becoming an error result and the
 * text keeping its head when it exceeds the output limit; results a handler
 * already made, an image, pass as they are
 * @param {function(object): Promise<string|object|object[]>} handler
 * @returns {function(object): Promise<object>}
 */
function tool(handler) {
	return async (args) => {
		try {
			let text = await handler(args);
			if (typeof text !== 'string') {
				return text;
			}
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
 * Call the API, a non 2xx status throwing an error that carries the status and
 * the body
 * @param {string} method
 * @param {string} route
 * @param {{query?: object, body?: object}} [options]
 * @returns {Promise<*>} The response body
 */
async function call(method, route, options) {
	const res = await request(method, route, options);
	if (!res.ok) {
		const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
		throw Object.assign(new Error(`HTTP ${res.status} ${body}`), { status: res.status });
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
 * A channel or thread the bot sees
 * @param {string} id
 * @returns {Promise<object>}
 */
async function channel(id) {
	const cid = snowflake(id, 'channel');
	try {
		return await call('GET', `/channels/${cid}`);
	} catch (error) {
		if (NOT_VIEWABLE.includes(error.status)) {
			throw new Error(`Channel ${cid} not found or not viewable`);
		}
		throw error;
	}
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
 * Tag ids of a forum for a list of tag names
 * @param {object} forum
 * @param {string[]} names
 * @returns {string[]}
 */
function tagIds(forum, names) {
	const ids = Object.fromEntries((forum.available_tags || []).map((tag) => [tag.name, tag.id]));
	return names.map((name) => {
		if (!ids[name]) {
			throw new Error(
				`Unknown tag "${name}" in #${forum.name}, tags: ${Object.keys(ids).join(' ') || 'none'}`
			);
		}
		return ids[name];
	});
}

/**
 * Path segment of a reaction emoji: a unicode emoji as is, a custom one as
 * name:id, or by its bare name, colons allowed, among the emojis of the guild
 * @param {string} emoji
 * @param {string} [gid]
 * @returns {Promise<string>}
 */
async function emojiSegment(emoji, gid) {
	const text = emoji.replace(/^:(.+):$/, '$1');
	if (CUSTOM_EMOJI.test(text) || !EMOJI_NAME.test(text)) {
		return encodeURIComponent(text);
	}
	const list = gid ? await call('GET', `/guilds/${gid}/emojis`) : [];
	const found = list.find((e) => e.name === text);
	if (!found) {
		throw new Error(`Unknown emoji "${emoji}", a unicode emoji or a custom one of this server`);
	}
	return encodeURIComponent(`${found.name}:${found.id}`);
}

/**
 * Names by id of a list of roles or channels
 * @param {object[]} list
 * @returns {Object<string, string>}
 */
function namesById(list) {
	return Object.fromEntries(list.map((x) => [x.id, x.name]));
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
	const data = await call('GET', `/guilds/${ch.guild_id}/threads/active`);
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
 * Channels the bot may view in every guild it is in, grouped under their
 * category
 */
async function channels() {
	const [me, guilds] = await Promise.all([
		call('GET', '/users/@me'),
		call('GET', '/users/@me/guilds')
	]);
	const blocks = [];
	for (const g of guilds) {
		blocks.push(`guild ${g.id} ${g.name}\n` + (await guildChannels(g.id, me.id)));
	}
	return blocks.join('\n') || 'No guild';
}

/**
 * The VIEW_CHANNEL test of a guild member, in Discord's order: the guild
 * permissions of everyone and of the member's roles, administrator granting
 * all, then the channel overwrites of everyone, of the member's roles together
 * and of the member
 * @param {string} gid
 * @param {object} member Guild member, user and roles
 * @param {object[]} roles Roles of the guild
 * @returns {function(object): boolean}
 */
function viewer(gid, member, roles) {
	const granted = Object.fromEntries(roles.map((r) => [r.id, BigInt(r.permissions)]));
	const base = member.roles.reduce((p, id) => p | (granted[id] || 0n), granted[gid] || 0n);
	if (base & ADMINISTRATOR) {
		return () => true;
	}
	return (c) => {
		const ow = Object.fromEntries((c.permission_overwrites || []).map((o) => [o.id, o]));
		const apply = (p, allow, deny) => (p & ~deny) | allow;
		let p = base;
		if (ow[gid]) {
			p = apply(p, BigInt(ow[gid].allow), BigInt(ow[gid].deny));
		}
		let allow = 0n;
		let deny = 0n;
		for (const id of member.roles) {
			if (ow[id]) {
				allow |= BigInt(ow[id].allow);
				deny |= BigInt(ow[id].deny);
			}
		}
		p = apply(p, allow, deny);
		const own = ow[member.user.id];
		if (own) {
			p = apply(p, BigInt(own.allow), BigInt(own.deny));
		}
		return (p & VIEW_CHANNEL) !== 0n;
	};
}

/**
 * Channels of one guild the bot may view, one line each, sorted by category
 * then position
 * @param {string} id
 * @param {string} me Bot user id
 * @returns {Promise<string>}
 */
async function guildChannels(id, me) {
	const [list, roles, member] = await Promise.all([
		call('GET', `/guilds/${id}/channels`),
		call('GET', `/guilds/${id}/roles`),
		call('GET', `/guilds/${id}/members/${me}`)
	]);
	const canView = viewer(id, member, roles);
	const byId = Object.fromEntries(list.map((c) => [c.id, c]));
	const rank = (c) => {
		const parent = byId[c.parent_id];
		return parent ? [parent.position, c.position] : [-1, c.position];
	};

	const lines = list
		.filter((c) => c.type !== 4 && canView(c))
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
				(tags.length ? ` | tags ${tags.join(' ')}` : '')
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
 * Name of a user, or null when the id names no user the bot can look up
 * @param {string} id
 * @returns {Promise<string|null>}
 */
async function userName(id) {
	try {
		return author(await call('GET', `/users/${id}`));
	} catch {
		return null;
	}
}

/**
 * Names a page of messages needs beyond what each message carries: every user
 * the page pings, the users it mentions without pinging them, and the roles
 * and channels of the guild when the page holds a role mention or a channel
 * link
 * @param {string} gid
 * @param {object[]} messages
 * @returns {Promise<{users: object, roles: object, channels: object}>}
 */
async function pageNames(gid, messages) {
	const raw = JSON.stringify(messages);
	const users = {};
	for (const u of messages.flatMap((m) => m.mentions || [])) {
		users[u.id] = author(u);
	}
	const missing = [...new Set([...raw.matchAll(USER_MENTION)].map((x) => x[1]))].filter(
		(id) => !users[id]
	);
	const [found, roles, channels] = await Promise.all([
		Promise.all(missing.map(async (id) => [id, await userName(id)])),
		gid && ROLE_MENTION.test(raw) ? call('GET', `/guilds/${gid}/roles`) : [],
		gid && CHANNEL_LINK.test(raw) ? call('GET', `/guilds/${gid}/channels`) : []
	]);
	for (const [id, name] of found) {
		if (name) {
			users[id] = name;
		}
	}
	return { users, roles: namesById(roles), channels: namesById(channels) };
}

/**
 * One page of messages of a channel or thread, oldest first: the newest page
 * by default, the page after a message, around it or before it
 * @param {{channel: string, after?: string, around?: string, before?: string, limit?: number}} args
 */
async function read({ channel: id, after, around, before, limit = MESSAGES_PAGE }) {
	const ch = await channel(id);
	const from = after == null ? null : snowflake(after, 'after');
	const mid = around == null ? null : snowflake(around, 'around');
	const to = before == null ? null : snowflake(before, 'before');
	const count = Math.min(Math.max(Math.trunc(Number(limit)) || MESSAGES_PAGE, 1), MESSAGES_MAX);
	const messages = await call('GET', `/channels/${ch.id}/messages`, {
		query: {
			limit: count,
			after: from,
			around: from == null ? mid : null,
			before: from == null && mid == null ? to : null
		}
	});

	const page = Object.fromEntries(messages.map((m) => [m.id, m]));
	const names = await pageNames(ch.guild_id, messages);
	const ordered = messages.slice().reverse();
	const lines = ordered.map((m) => message(m, page, names));
	if (messages.length === count && from == null) {
		lines.push(`more: before=${ordered[0].id}`);
	}
	if (messages.length === count && (from != null || mid != null)) {
		lines.push(`more: after=${ordered[ordered.length - 1].id}`);
	}
	return lines.join('\n') || `No message in #${ch.name}`;
}

/**
 * Post a message or a reply, or open a thread when the channel is a forum
 * @param {{channel: string, content: string, reply_to?: string, thread_name?: string, tags?: string[]}} args
 */
async function post({ channel: id, content, reply_to, thread_name, tags }) {
	tagList(tags);
	const ch = await channel(id);

	if (!FORUM_TYPES.includes(ch.type)) {
		if (thread_name != null || tags != null) {
			throw new Error(`Thread_name and tags only apply to a forum, #${ch.name} is not one`);
		}
		const body = { content };
		if (reply_to != null) {
			body.message_reference = { message_id: snowflake(reply_to, 'reply_to') };
		}
		const m = await call('POST', `/channels/${ch.id}/messages`, { body });
		return `Message ${m.id} posted in #${ch.name}`;
	}

	if (thread_name == null) {
		throw new Error(`Thread_name argument required, #${ch.name} is a forum`);
	}
	if (reply_to != null) {
		throw new Error('Reply_to does not apply to a forum, it opens a thread');
	}
	const applied = tagIds(ch, tags || []);
	const t = await call('POST', `/channels/${ch.id}/threads`, {
		body: {
			name: thread_name,
			applied_tags: applied,
			message: { content }
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
	const m = await call(
		'PATCH',
		`/channels/${ch.id}/messages/${snowflake(message_id, 'message_id')}`,
		{
			body: { content }
		}
	);
	return `Message ${m.id} edited in #${ch.name}`;
}

/**
 * Add a reaction of the bot to a message, or take it back with remove
 * @param {{channel: string, message_id: string, emoji: string, remove?: boolean}} args
 */
async function react({ channel: id, message_id, emoji, remove }) {
	const off = flag(remove, 'Remove');
	const ch = await channel(id);
	const mid = snowflake(message_id, 'message_id');
	const segment = await emojiSegment(emoji, ch.guild_id);
	await call(off ? 'DELETE' : 'PUT', `/channels/${ch.id}/messages/${mid}/reactions/${segment}/@me`);
	return `Reaction ${emoji} ${off ? 'removed from' : 'added to'} message ${mid} in #${ch.name}`;
}

/**
 * Rename, archive, lock or retag a thread
 * @param {{thread: string, name?: string, archived?: boolean, locked?: boolean, tags?: string[]}} args
 */
async function editThread({ thread, name, archived, locked, tags }) {
	const body = { name, archived: flag(archived, 'Archived'), locked: flag(locked, 'Locked') };
	tagList(tags);
	const t = await channel(thread);
	if (!THREAD_TYPES.includes(t.type)) {
		throw new Error(`#${t.name} is not a thread`);
	}
	if (tags != null) {
		body.applied_tags = tagIds(await channel(t.parent_id), tags);
	}
	if (Object.values(body).every((v) => v === undefined)) {
		throw new Error('Nothing to change, give name, archived, locked or tags');
	}
	const updated = await call('PATCH', `/channels/${t.id}`, { body });
	return `Thread ${updated.id} "${updated.name}" updated`;
}

/**
 * An image attached on Discord, as the model sees it: the url comes from a
 * read line, Discord hosts only and no redirect
 * @param {{url: string}} args
 */
async function image({ url }) {
	let u;
	try {
		u = new URL(url);
	} catch {
		u = null;
	}
	if (!u || u.protocol !== 'https:' || !IMAGE_HOSTS.includes(u.hostname)) {
		throw new Error(`Invalid url "${url}", a Discord attachment url from a read line`);
	}
	const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} ${res.statusText}`);
	}
	if (Number(res.headers.get('content-length')) > config.imageLimitBytes) {
		throw new Error(`Image larger than ${config.imageLimitBytes} bytes`);
	}
	const bytes = Buffer.from(await res.arrayBuffer());
	if (bytes.length > config.imageLimitBytes) {
		throw new Error(`Image larger than ${config.imageLimitBytes} bytes`);
	}
	if (!imageType(bytes)) {
		throw new Error('Not an image, only PNG, JPEG, GIF and WebP are shown');
	}
	return imageResults(bytes, IMAGE_LIMITS);
}

const TOOLS_MAPPING = {
	discord_bot_channels: tool(channels),
	discord_bot_threads: tool(threads),
	discord_bot_read: tool(read),
	discord_bot_post: tool(post),
	discord_bot_edit: tool(edit),
	discord_bot_react: tool(react),
	discord_bot_edit_thread: tool(editThread),
	discord_bot_image: tool(image)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
