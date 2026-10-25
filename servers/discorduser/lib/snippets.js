/**
 * Page snippets
 * The expressions evaluated inside the client, frozen here and parameterized
 * only through values JSON encoded by the caller, so the page runs the gestures
 * of the account and never caller supplied code
 *
 * PRELUDE reaches the webpack runtime that holds the Flux stores and the REST
 * client, then exposes helpers: stores by their stable getName, the request
 * module by its exact get/post/put/patch/del shape behind __get, __post and
 * __patch, and the renderers that turn ids into the names a reader needs
 *
 * Reading a page acks its newest message when it is newer than the read state,
 * as opening the channel does, so the unread counts follow what was read and
 * paging through older history never moves them back. Posting and editing go
 * through the same requests the client sends when the user types
 *
 * What a snippet lists is what the account may view: guild channels pass the
 * VIEW_CHANNEL permission, and direct messages sit under the pseudo guild @me
 *
 * A snippet resolves to its text, or to {error} carrying the message of what
 * it threw
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

// A refused request rejects with the response, turned here into an error that
// carries its status and body
const __send = async (method, options) => {
	if (!__http) throw new Error('REST client not found, the client changed');
	try {
		const res = await __http[method](options);
		return res.body;
	} catch (e) {
		if (e && e.status) throw Object.assign(new Error('HTTP ' + e.status + ' ' + JSON.stringify(e.body)), { status: e.status });
		throw e;
	}
};
const __get = (url, query) => __send('get', { url, query });
const __post = (url, body) => __send('post', { url, body });
const __patch = (url, body) => __send('patch', { url, body });
const __put = (url) => __send('put', { url });
const __del = (url) => __send('del', { url });

// The nonce the client stamps on what it sends, a snowflake of the moment
const __nonce = () => String((BigInt(Date.now()) - 1420070400000n) << 22n);

// A channel the client holds passes its VIEW_CHANNEL test, any other one, an
// archived thread say, comes from the API that refuses what the account may
// not view
const __channel = async (cid) => {
	const ch = __store('ChannelStore').getChannel(cid);
	if (ch && ch.guild_id && !__canView(ch)) throw new Error('Channel ' + cid + ' not found or not viewable');
	if (ch) return ch;
	try {
		return await __get('/channels/' + cid);
	} catch (e) {
		if (NOT_VIEWABLE.includes(e.status)) throw new Error('Channel ' + cid + ' not found or not viewable');
		throw e;
	}
};
const __label = (ch) => (ch.guild_id ? '#' + ch.name : __dmName(ch));

const VIEW_CHANNEL = 1024n;
const FORUM_TYPES = [15, 16];
const NOT_VIEWABLE = [403, 404];
const THREAD_HOLDERS = [0, 5, 15, 16];
const THREAD_TYPES = [10, 11, 12];
const CUSTOM_EMOJI = /^\\w+:\\d{17,20}$/;
const EMOJI_NAME = /^\\w+$/;

// Forum tags of a channel the client holds or of one the API returned
const __tags = (ch) => ch.availableTags || ch.available_tags || [];
const __tagIds = (forum, names) => {
	const ids = {};
	for (const t of __tags(forum)) ids[t.name] = t.id;
	return names.map((n) => {
		if (!ids[n]) throw new Error('Unknown tag "' + n + '" in ' + __label(forum) + ', tags: ' + (Object.keys(ids).join(' ') || 'none'));
		return ids[n];
	});
};

// Path segment of a reaction emoji: a unicode emoji as is, a custom one as
// name:id, or by its bare name, colons allowed, among the emojis of the guild
const __emoji = async (emoji, gid) => {
	const text = emoji.replace(/^:(.+):$/, '$1');
	if (CUSTOM_EMOJI.test(text) || !EMOJI_NAME.test(text)) return encodeURIComponent(text);
	const list = gid ? await __get('/guilds/' + gid + '/emojis') : [];
	const found = list.find((e) => e.name === text);
	if (!found) throw new Error('Unknown emoji "' + emoji + '", a unicode emoji or a custom one of this server');
	return encodeURIComponent(found.name + ':' + found.id);
};
const CTYPE = { 0: 'text', 1: 'dm', 2: 'voice', 3: 'group', 4: 'category', 5: 'announcement', 10: 'thread', 11: 'thread', 12: 'thread', 13: 'stage', 15: 'forum', 16: 'media' };
const SYSTEM = { 1: 'added someone to the group', 2: 'removed someone from the group', 6: 'pinned a message', 7: 'joined the server', 8: 'boosted the server', 9: 'boosted the server', 10: 'boosted the server', 11: 'boosted the server', 12: 'followed a channel here', 18: 'started a thread' };
const EMBED_TEXT = 500;

const __canView = (c) => {
	try {
		return __store('PermissionStore').can(VIEW_CHANNEL, c);
	} catch {
		return false;
	}
};

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
		if (c) return c.name || __dmName(c);
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

// A direct message has no name of its own: its recipients name it
const __dmName = (c) => {
	if (c.name) return c.name;
	const names = (c.recipients || []).map((id) => __userName(id) || id);
	return names.join(', ') || c.id;
};

const __stamp = (iso) => (iso || '').slice(0, 16).replace('T', ' ');
const __idStamp = (id) => __stamp(new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString());
const __author = (u) => (u ? u.global_name || u.username : 'unknown');
// The name of who wrote a message, an app, bot or webhook, marked as Discord badges it
const __speaker = (u) => __author(u) + (u && u.bot ? ' [APP]' : '');
const __clip = (text, n) => (text.length > n ? text.slice(0, n) + '...' : text);

// Mentions, channel links, custom emojis and plain newlines turned into text a
// reader hears or reads on one line. A user mention takes its name from the
// message itself first, which carries every user it mentions, then from the
// client cache, the id staying only when both miss
const __plain = (content, guildId, names) => {
	let text = content || '';
	text = text.replace(/<@!?(\\d+)>/g, (_, id) => '@' + (names[id] || __userName(id) || id));
	text = text.replace(/<@&(\\d+)>/g, (_, id) => '@' + (__roleName(guildId, id) || id));
	text = text.replace(/<#(\\d+)>/g, (_, id) => '#' + (__channelName(id) || id));
	text = text.replace(/<a?:(\\w+):\\d+>/g, (_, n) => ':' + n + ':');
	text = text.replace(/\\r?\\n/g, ' / ');
	return text.trim();
};

// Files, stickers, embeds and polls of a message or of a forwarded snapshot
const __extras = (m, guildId, names, content) => {
	const parts = [];
	for (const a of m.attachments || []) parts.push('| file ' + a.filename + ' ' + a.size + 'B ' + a.url);
	for (const s of m.sticker_items || []) parts.push('| sticker ' + s.name);
	for (const e of m.embeds || []) {
		const title = e.title || (e.author && e.author.name) || '';
		const url = e.url && !(content || '').includes(e.url) ? e.url : '';
		const text = !content && e.description ? __clip(__plain(e.description, guildId, names), EMBED_TEXT) : '';
		const embed = [title, url, text].filter(Boolean).join(' ');
		if (embed) parts.push('| embed ' + embed);
	}
	if (m.poll) {
		const answers = (m.poll.answers || []).map((a) => a.poll_media && a.poll_media.text).filter(Boolean);
		parts.push('| poll ' + ((m.poll.question && m.poll.question.text) || '') + ': ' + answers.join(' / '));
	}
	return parts;
};

// The author a reply answers: the API joins the answered message only now and
// then, so the page being read and the client cache stand in, and the answered
// id is given when none of them has it
const __replyTo = (m, page) => {
	const ref = m.message_reference && m.message_reference.message_id;
	if (!ref) return null;
	if (m.referenced_message) return __speaker(m.referenced_message.author);
	if (page[ref]) return __speaker(page[ref].author);
	try {
		const cached = __store('MessageStore').getMessage(m.channel_id, ref);
		if (cached && cached.author) return (cached.author.globalName || cached.author.username) + (cached.author.bot ? ' [APP]' : '');
	} catch {}
	return 'message ' + ref;
};

// A message fetched over REST carries no guild id: the channel read gives it
const __message = (m, page, guildId) => {
	const names = {};
	for (const u of m.mentions || []) names[u.id] = __author(u);
	const author = __speaker(m.author);
	const parts = [m.id, __stamp(m.timestamp)];

	if (SYSTEM[m.type]) {
		parts.push('* ' + author + ' ' + SYSTEM[m.type]);
		if (m.content) parts.push(__plain(m.content, guildId, names));
		return parts.join(' ');
	}

	parts.push(author + ':');
	const body = __plain(m.content, guildId, names);
	if (body) parts.push(body);
	const to = m.type === 19 ? __replyTo(m, page) : null;
	if (to) parts.push('| reply to ' + to);
	parts.push(...__extras(m, guildId, names, m.content));
	for (const snap of m.message_snapshots || []) {
		const f = snap.message || {};
		const fwd = __plain(f.content, guildId, names);
		parts.push('| forwarded' + (fwd ? ': ' + fwd : ''));
		parts.push(...__extras(f, guildId, names, f.content));
	}
	for (const r of m.reactions || []) {
		const name = r.emoji && (r.emoji.name || r.emoji.id);
		if (name) parts.push('| react ' + name + ' x' + r.count + (r.me ? ' mine' : ''));
	}
	return parts.join(' ');
};
`;

/**
 * Wrap a snippet body as one awaited expression, prelude included, a thrown
 * error resolving to {error}
 * @param {string} body A block that returns a value
 * @returns {string}
 */
function expr(body) {
	return `(async () => {\ntry {\n${PRELUDE}\n${body}\n} catch (e) {\nreturn { error: String((e && e.message) || e) };\n}\n})()`;
}

/**
 * The direct messages, then the guilds in the order of the account's guild bar
 */
const GUILDS = expr(`
	const G = __store('GuildStore');
	const dms = __store('ChannelStore').getSortedPrivateChannels();
	const lines = ['@me Direct messages (' + dms.length + ')'];
	for (const id of __store('SortedGuildStore').getFlattenedGuildIds()) {
		const g = G.getGuild(id);
		if (g) lines.push(g.id + ' ' + g.name);
	}
	return lines.join('\\n');
`);

/**
 * The channels of a guild the account may view, grouped under their category,
 * or the direct messages, latest conversation first, for @me
 * @param {string} guild Guild id or @me, JSON encoded by the caller
 */
function channels(guild) {
	return expr(`
	const gid = ${guild};
	const CH = __store('ChannelStore');
	if (gid === '@me') {
		const lines = CH.getSortedPrivateChannels().map((c) => c.id + ' ' + (CTYPE[c.type] || c.type) + ' ' + __dmName(c));
		return 'Direct messages\\n' + (lines.join('\\n') || 'No conversation');
	}
	const g = __store('GuildStore').getGuild(gid);
	if (!g) throw new Error('Guild ' + gid + ' not found, the account is not in it');
	const byId = CH.getMutableGuildChannelsForGuild(gid) || {};
	const rank = (c) => { const p = byId[c.parent_id]; return p ? [p.position, c.position] : [-1, c.position]; };
	const lines = Object.values(byId)
		.filter((c) => c.type !== 4 && __canView(c))
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
 * The unread conversations and viewable channels, with unread and mention
 * counts, direct messages first
 */
const UNREAD = expr(`
	const RS = __store('ReadStateStore');
	const CH = __store('ChannelStore');
	const GC = __store('GuildChannelStore');
	const G = __store('GuildStore');
	const line = (id, label) => {
		if (!RS.hasUnread(id)) return null;
		const count = RS.getUnreadCount(id);
		const mentions = RS.getMentionCount(id);
		if (!count && !mentions) return null;
		return '  ' + id + ' ' + label + ' | ' + count + ' unread' + (mentions ? ' | ' + mentions + ' mentions' : '');
	};
	const blocks = [];
	const dms = CH.getSortedPrivateChannels().map((c) => line(c.id, __dmName(c))).filter(Boolean);
	if (dms.length) blocks.push('@me Direct messages\\n' + dms.join('\\n'));
	for (const gid of __store('SortedGuildStore').getFlattenedGuildIds()) {
		const g = G.getGuild(gid);
		if (!g) continue;
		const lines = [];
		for (const id of GC.getSelectableChannelIds(gid)) {
			const c = CH.getChannel(id);
			if (!c || !__canView(c)) continue;
			const l = line(id, '#' + c.name);
			if (l) lines.push(l);
		}
		if (lines.length) blocks.push(g.id + ' ' + g.name + '\\n' + lines.join('\\n'));
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
	const ch = await __channel(cid);
	if (!THREAD_HOLDERS.includes(ch.type)) throw new Error(__label(ch) + ' holds no threads');
	const tagName = {};
	for (const t of __tags(ch)) tagName[t.id] = t.name;
	const line = (t, archived) => {
		const applied = (t.appliedTags || t.applied_tags || []).map((id) => tagName[id] || id);
		const count = t.messageCount != null ? t.messageCount : t.message_count;
		return t.id + ' ' + t.name + ' | ' + __idStamp(t.id) + (count != null ? ' | ' + count + ' msgs' : '') + (applied.length ? ' | tags ' + applied.join(' ') : '') + (archived ? ' | archived' : '');
	};
	const lines = [];
	if (before == null) {
		const active = __store('ActiveThreadsStore').getThreadsForParent(ch.guild_id, cid) || {};
		const CH = __store('ChannelStore');
		for (const id of Object.keys(active).sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1))) {
			const t = CH.getChannel(id) || active[id];
			if (t) lines.push(line(t, false));
		}
	}
	const page = await __get('/channels/' + cid + '/threads/archived/public', { limit: 100, before: before == null ? undefined : before });
	for (const t of (page && page.threads) || []) lines.push(line(t, true));
	if (page && page.has_more && page.threads.length) {
		lines.push('more: before=' + page.threads[page.threads.length - 1].thread_metadata.archive_timestamp);
	}
	return lines.join('\\n') || 'No thread in ' + __label(ch);
`);
}

/**
 * One page of messages, oldest first: the newest page by default, the page
 * after a message, around it or before it
 * @param {string} channel Channel id, JSON encoded by the caller
 * @param {string} after Message id or the literal null, JSON encoded
 * @param {string} around Message id or the literal null, JSON encoded
 * @param {string} before Message id or the literal null, JSON encoded
 * @param {number} limit 1..100, already clamped by the caller
 */
function read(channel, after, around, before, limit) {
	return expr(`
	const cid = ${channel};
	const after = ${after};
	const around = ${around};
	const before = ${before};
	const ch = await __channel(cid);
	const query = { limit: ${limit} };
	if (after != null) query.after = after;
	else if (around != null) query.around = around;
	else if (before != null) query.before = before;
	const messages = await __get('/channels/' + cid + '/messages', query);
	const ordered = messages.slice().reverse();
	const page = {};
	for (const m of messages) page[m.id] = m;
	const lines = ordered.map((m) => __message(m, page, ch.guild_id));
	if (messages.length === ${limit} && after == null) lines.push('more: before=' + ordered[0].id);
	if (messages.length === ${limit} && (after != null || around != null)) lines.push('more: after=' + ordered[ordered.length - 1].id);
	const newest = messages.length ? messages[0].id : null;
	const acked = __store('ReadStateStore').ackMessageId(cid);
	if (newest && (!acked || BigInt(newest) > BigInt(acked))) {
		try {
			await __post('/channels/' + cid + '/messages/' + newest + '/ack', { token: null });
		} catch (e) {
			lines.push('ack failed: ' + e.message);
		}
	}
	return lines.join('\\n') || 'No message in ' + __label(ch);
`);
}

/**
 * Post a message, or open a thread when the channel is a forum
 * @param {string} channel Channel, forum, thread or direct message id, JSON encoded
 * @param {string} content JSON encoded
 * @param {string} reply Message id or the literal null, JSON encoded
 * @param {string} name Thread name or the literal null, JSON encoded
 * @param {string} tags Tag names list or the literal null, JSON encoded
 */
function post(channel, content, reply, name, tags) {
	return expr(`
	const cid = ${channel};
	const content = ${content};
	const reply = ${reply};
	const name = ${name};
	const tags = ${tags};
	const ch = await __channel(cid);
	const message = { content, nonce: __nonce(), tts: false, flags: 0 };
	if (!FORUM_TYPES.includes(ch.type)) {
		if (name != null || tags != null) throw new Error('Thread_name and tags only apply to a forum, ' + __label(ch) + ' is not one');
		if (reply != null) message.message_reference = { message_id: reply };
		const m = await __post('/channels/' + cid + '/messages', message);
		return 'Message ' + m.id + ' posted in ' + __label(ch);
	}
	if (name == null) throw new Error('Thread_name argument required, ' + __label(ch) + ' is a forum');
	if (reply != null) throw new Error('Reply_to does not apply to a forum, it opens a thread');
	const applied = __tagIds(ch, tags || []);
	const t = await __post('/channels/' + cid + '/threads', { name, applied_tags: applied, message });
	return 'Thread ' + t.id + ' "' + t.name + '" created in ' + __label(ch);
`);
}

/**
 * Replace the content of a message of the account
 * @param {string} channel Channel or thread id, JSON encoded
 * @param {string} message Message id, JSON encoded
 * @param {string} content JSON encoded
 */
function edit(channel, message, content) {
	return expr(`
	const cid = ${channel};
	const ch = await __channel(cid);
	const m = await __patch('/channels/' + cid + '/messages/' + ${message}, { content: ${content} });
	return 'Message ' + m.id + ' edited in ' + __label(ch);
`);
}

/**
 * Add a reaction of the account to a message, or take it back
 * @param {string} channel Channel or thread id, JSON encoded
 * @param {string} message Message id, JSON encoded
 * @param {string} emoji JSON encoded
 * @param {boolean} remove true or false
 */
function react(channel, message, emoji, remove) {
	return expr(`
	const cid = ${channel};
	const mid = ${message};
	const emoji = ${emoji};
	const ch = await __channel(cid);
	const route = '/channels/' + cid + '/messages/' + mid + '/reactions/' + (await __emoji(emoji, ch.guild_id)) + '/@me';
	if (${remove}) {
		await __del(route);
		return 'Reaction ' + emoji + ' removed from message ' + mid + ' in ' + __label(ch);
	}
	await __put(route);
	return 'Reaction ' + emoji + ' added to message ' + mid + ' in ' + __label(ch);
`);
}

/**
 * Rename, archive, lock or retag a thread
 * @param {string} thread Thread id, JSON encoded
 * @param {string} changes {name, archived, locked} with the absent ones left
 * out, JSON encoded
 * @param {string} tags Tag names list or the literal null, JSON encoded
 */
function editThread(thread, changes, tags) {
	return expr(`
	const tid = ${thread};
	const body = ${changes};
	const tags = ${tags};
	const t = await __channel(tid);
	if (!THREAD_TYPES.includes(t.type)) throw new Error(__label(t) + ' is not a thread');
	if (tags != null) body.applied_tags = __tagIds(await __channel(t.parent_id), tags);
	if (!Object.keys(body).length) throw new Error('Nothing to change, give name, archived, locked or tags');
	const updated = await __patch('/channels/' + tid, body);
	return 'Thread ' + updated.id + ' "' + updated.name + '" updated';
`);
}

/**
 * One page of the messages a search finds, newest first, each with the
 * channel it sits in
 * @param {string} guild Guild id or @me, JSON encoded
 * @param {string} query {content, channel_id, author_id, offset} with the
 * absent ones left out, JSON encoded
 * @param {number} page Results per page of the search API
 */
function search(guild, query, page) {
	return expr(`
	const gid = ${guild};
	const query = ${query};
	const route = gid === '@me' ? '/channels/' + query.channel_id + '/messages/search' : '/guilds/' + gid + '/messages/search';
	const res = await __get(route, query);
	if (!res.messages) throw new Error('The search index of this server is not ready, retry in ' + (res.retry_after || 1) + ' s');
	const offset = query.offset || 0;
	const lines = [res.total_results + ' results'];
	const labels = {};
	for (const [m] of res.messages) {
		if (!(m.channel_id in labels)) {
			try {
				labels[m.channel_id] = __label(await __channel(m.channel_id));
			} catch {
				labels[m.channel_id] = m.channel_id;
			}
		}
		lines.push(__message(m, {}, gid === '@me' ? null : gid) + ' | in ' + labels[m.channel_id]);
	}
	if (offset + ${page} < res.total_results && res.messages.length) lines.push('more: offset=' + (offset + ${page}));
	return lines.join('\\n');
`);
}

module.exports = { GUILDS, UNREAD, channels, threads, read, post, edit, react, editThread, search };
