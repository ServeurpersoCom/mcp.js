/**
 * Page snippets
 * The expressions evaluated inside the client, frozen here and parameterized
 * only through values JSON encoded by the caller, so the page runs read gestures
 * and never caller supplied code
 *
 * PRELUDE reaches the webpack runtime that holds the Flux stores and the REST
 * client, then exposes read helpers: stores by their stable getName, the request
 * module by its exact get/post/put/patch/del shape, and the renderers that turn
 * ids into the names a reader needs. Only req.get is ever called, so a snippet
 * reads and never writes, reacts or marks anything seen
 */

const PRELUDE = `
const __rt = (() => {
	const seen = [];
	const chunk = (window.webpackChunkdiscord_app = window.webpackChunkdiscord_app || []);
	chunk.push([[Symbol('mcp')], {}, (r) => { seen.push(r); }]);
	chunk.pop();
	const withCache = seen.filter((r) => r && r.c);
	if (!withCache.length) throw new Error('webpack runtime not found, the client changed');
	return withCache.sort((a, b) => Object.keys(b.c).length - Object.keys(a.c).length)[0];
})();

const __stores = {};
let __http = null;
{
	const seen = new Set();
	for (const mod of Object.values(__rt.c)) {
		const ex = mod && mod.exports;
		if (!ex || (typeof ex !== 'object' && typeof ex !== 'function')) continue;
		for (const v of [ex, ...Object.values(ex)]) {
			if (!v || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) continue;
			seen.add(v);
			try {
				const name = typeof v.getName === 'function' && v.constructor && v.constructor.displayName ? v.getName() : null;
				if (name && !__stores[name]) __stores[name] = v;
			} catch {}
			if (!__http) {
				const keys = Object.keys(v);
				if (keys.length === 5 && ['get', 'post', 'put', 'patch', 'del'].every((k) => typeof v[k] === 'function')) __http = v;
			}
		}
	}
}

const __store = (name) => {
	const s = __stores[name];
	if (!s) throw new Error(name + ' not found, the client changed');
	return s;
};

const __get = async (url, query) => {
	if (!__http) throw new Error('REST client not found, the client changed');
	const res = await __http.get({ url, query });
	return res.body;
};

const CTYPE = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 10: 'thread', 11: 'thread', 12: 'thread', 13: 'stage', 15: 'forum', 16: 'media' };

const __userName = (id) => {
	try {
		const u = __store('UserStore').getUser(id);
		if (u) return u.globalName || u.username;
	} catch {}
	return null;
};
const __channelName = (id) => {
	try {
		const c = __store('ChannelStore').getChannel(id);
		if (c) return c.name;
	} catch {}
	return null;
};
const __roleName = (gid, id) => {
	try {
		const g = __store('GuildStore').getGuild(gid);
		if (g && g.roles && g.roles[id]) return g.roles[id].name;
	} catch {}
	return null;
};

const __stamp = (iso) => (iso || '').slice(0, 16).replace('T', ' ');

// Mentions, channel links, custom emojis and plain newlines turned into text a
// reader hears or reads on one line, ids kept when a name is unknown
const __plain = (content, guildId) => {
	let text = content || '';
	text = text.replace(/<@!?(\\d+)>/g, (_, id) => '@' + (__userName(id) || id));
	text = text.replace(/<@&(\\d+)>/g, (_, id) => '@' + (__roleName(guildId, id) || id));
	text = text.replace(/<#(\\d+)>/g, (_, id) => '#' + (__channelName(id) || id));
	text = text.replace(/<a?:(\\w+):\\d+>/g, (_, n) => ':' + n + ':');
	text = text.replace(/\\r?\\n/g, ' / ');
	return text.trim();
};

const __message = (m) => {
	const author = m.author ? m.author.global_name || m.author.username : 'unknown';
	const parts = [m.id, __stamp(m.timestamp), author + ':'];
	const body = __plain(m.content, m.guild_id);
	if (body) parts.push(body);
	if (m.referenced_message) {
		const r = m.referenced_message;
		const ra = r.author ? r.author.global_name || r.author.username : 'unknown';
		parts.push('| reply to ' + ra);
	}
	for (const a of m.attachments || []) parts.push('| file ' + a.filename + ' ' + a.size + 'B ' + a.url);
	for (const e of m.embeds || []) {
		if (e.title || e.url) parts.push('| embed ' + [e.title, e.url].filter(Boolean).join(' '));
	}
	for (const r of m.reactions || []) {
		const name = r.emoji && (r.emoji.name || r.emoji.id);
		if (name) parts.push('| react ' + name + ' x' + r.count);
	}
	return parts.join(' ');
};
`;

/**
 * Wrap a snippet body as one awaited expression, prelude included
 * @param {string} body A block that returns a value
 * @returns {string}
 */
function expr(body) {
	return `(async () => {\n${PRELUDE}\n${body}\n})()`;
}

/**
 * The guilds the account is in, in the order of its own guild bar
 */
const GUILDS = expr(`
	const G = __store('GuildStore');
	const order = __store('SortedGuildStore').getFlattenedGuildIds();
	const lines = order.map((id) => {
		const g = G.getGuild(id);
		return g ? g.id + ' ' + g.name : null;
	}).filter(Boolean);
	return lines.join('\\n') || 'No guild';
`);

/**
 * The channels of a guild, grouped under their category, with ids and types
 * @param {string} guild Guild id, JSON encoded by the caller
 */
function channels(guild) {
	return expr(`
	const gid = ${guild};
	const g = __store('GuildStore').getGuild(gid);
	if (!g) throw new Error('Guild ' + gid + ' not found, the account is not in it');
	const byId = {};
	for (const c of __store('ChannelStore').getMutableGuildChannelsForGuild(gid) ? Object.values(__store('ChannelStore').getMutableGuildChannelsForGuild(gid)) : []) byId[c.id] = c;
	const all = Object.values(byId);
	const rank = (c) => { const p = byId[c.parent_id]; return p ? [p.position, c.position] : [-1, c.position]; };
	const lines = all
		.filter((c) => c.type !== 4)
		.sort((a, b) => { const [pa, ca] = rank(a); const [pb, cb] = rank(b); return pa - pb || ca - cb; })
		.map((c) => {
			const p = byId[c.parent_id];
			const tags = (c.availableTags || []).map((t) => t.name);
			return c.id + ' ' + (CTYPE[c.type] || c.type) + ' #' + c.name + (p ? ' | in ' + p.name : '') + (tags.length ? ' | tags ' + tags.join(' ') : '');
		});
	return 'guild ' + g.id + ' ' + g.name + '\\n' + (lines.join('\\n') || 'No channel');
`);
}

/**
 * The unread channels across guilds, with unread and mention counts
 */
const UNREAD = expr(`
	const RS = __store('ReadStateStore');
	const CH = __store('ChannelStore');
	const GC = __store('GuildChannelStore');
	const G = __store('GuildStore');
	const order = __store('SortedGuildStore').getFlattenedGuildIds();
	const blocks = [];
	for (const gid of order) {
		const g = G.getGuild(gid);
		if (!g) continue;
		const ids = GC.getSelectableChannelIds ? GC.getSelectableChannelIds(gid) : [];
		const lines = [];
		for (const id of ids) {
			if (!RS.hasUnread(id)) continue;
			const count = RS.getUnreadCount(id);
			const mentions = RS.getMentionCount(id);
			if (!count && !mentions) continue;
			const c = CH.getChannel(id);
			lines.push('  ' + id + ' #' + (c ? c.name : id) + ' | ' + count + ' unread' + (mentions ? ' | ' + mentions + ' mentions' : ''));
		}
		if (lines.length) blocks.push(g.name + '\\n' + lines.join('\\n'));
	}
	return blocks.join('\\n') || 'Nothing unread';
`);

/**
 * The active and archived threads of a channel
 * @param {string} channel Channel id, JSON encoded by the caller
 * @param {string} before archive_timestamp or the literal null, JSON encoded
 */
function threads(channel, before) {
	return expr(`
	const cid = ${channel};
	const before = ${before};
	const ch = __store('ChannelStore').getChannel(cid);
	if (!ch) throw new Error('Channel ' + cid + ' not found');
	const tagName = {};
	for (const t of ch.availableTags || []) tagName[t.id] = t.name;
	const line = (t, archived) => {
		const applied = (t.appliedTags || []).map((id) => tagName[id] || id);
		return t.id + ' ' + t.name + ' | ' + __stamp(new Date(Number((BigInt(t.id) >> 22n) + 1420070400000n)).toISOString()) + (applied.length ? ' | tags ' + applied.join(' ') : '') + (archived ? ' | archived' : '');
	};
	const lines = [];
	if (before == null) {
		const active = __store('ActiveThreadsStore').getThreadsForParent ? __store('ActiveThreadsStore').getThreadsForParent(cid) : [];
		for (const t of (Array.isArray(active) ? active : Object.values(active || {}))) lines.push(line(t, false));
	}
	const page = await __get('/channels/' + cid + '/threads/archived/public', { limit: 100, before: before == null ? undefined : before });
	for (const t of page.threads || []) lines.push(line(t, true));
	if (page.has_more && page.threads && page.threads.length) {
		lines.push('more: before=' + page.threads[page.threads.length - 1].thread_metadata.archive_timestamp);
	}
	return lines.join('\\n') || 'No thread in this channel';
`);
}

/**
 * One page of messages, oldest first
 * @param {string} channel Channel id, JSON encoded by the caller
 * @param {string} after Message id or the literal null, JSON encoded
 * @param {string} before Message id or the literal null, JSON encoded
 * @param {number} limit 1..100, already clamped by the caller
 */
function read(channel, after, before, limit) {
	return expr(`
	const cid = ${channel};
	const after = ${after};
	const before = ${before};
	const query = { limit: ${limit} };
	if (after != null) query.after = after;
	else if (before != null) query.before = before;
	const messages = await __get('/channels/' + cid + '/messages', query);
	if (!Array.isArray(messages)) throw new Error('Channel ' + cid + ' returned no messages, is it readable');
	const ordered = messages.slice().reverse();
	const lines = ordered.map(__message);
	if (messages.length === ${limit}) {
		lines.push(after != null ? 'more: after=' + ordered[ordered.length - 1].id : 'more: before=' + ordered[0].id);
	}
	return lines.join('\\n') || 'No message';
`);
}

module.exports = { GUILDS, UNREAD, channels, threads, read };
