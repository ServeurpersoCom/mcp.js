/**
 * Message rendering
 * One line per message, in the words of the discorduser page renderer: user
 * and role mentions, channel links and custom emojis become names, newlines
 * become " / ", and replies, files, stickers, embeds, polls, forwarded messages
 * and reactions become words, so the output reads aloud or in braille
 *
 * Names come from the tables of the page the caller passes, the id staying
 * when a name is missing
 */

const SYSTEM = {
	1: 'added someone to the group',
	2: 'removed someone from the group',
	6: 'pinned a message',
	7: 'joined the server',
	8: 'boosted the server',
	9: 'boosted the server',
	10: 'boosted the server',
	11: 'boosted the server',
	12: 'followed a channel here',
	18: 'started a thread'
};
const REPLY = 19;
const EMBED_TEXT = 500;

/**
 * An ISO timestamp as "YYYY-MM-DD HH:MM"
 * @param {string} iso
 * @returns {string}
 */
function stamp(iso) {
	return (iso || '').slice(0, 16).replace('T', ' ');
}

/**
 * The name a user shows
 * @param {object} u
 * @returns {string}
 */
function author(u) {
	return u ? u.global_name || u.username : 'unknown';
}

/**
 * The name of who wrote a message, a bot or a webhook marked as such
 * @param {object} u
 * @returns {string}
 */
function speaker(u) {
	return author(u) + (u && u.bot ? ' [bot]' : '');
}

/**
 * @param {string} text
 * @param {number} n
 * @returns {string}
 */
function clip(text, n) {
	return text.length > n ? text.slice(0, n) + '...' : text;
}

/**
 * Message text on one line, ids turned into names
 * @param {string} content
 * @param {{users: object, roles: object, channels: object}} names Names by id
 * @returns {string}
 */
function plain(content, names) {
	return (content || '')
		.replace(/<@!?(\d+)>/g, (_, id) => '@' + (names.users[id] || id))
		.replace(/<@&(\d+)>/g, (_, id) => '@' + (names.roles[id] || id))
		.replace(/<#(\d+)>/g, (_, id) => '#' + (names.channels[id] || id))
		.replace(/<a?:(\w+):\d+>/g, (_, n) => ':' + n + ':')
		.replace(/\r?\n/g, ' / ')
		.trim();
}

/**
 * Files, stickers, embeds and polls of a message or of a forwarded snapshot
 * @param {object} m
 * @param {object} names
 * @param {string} content Text of m, an embed description shows only without it
 * @returns {string[]}
 */
function extras(m, names, content) {
	const parts = [];
	for (const a of m.attachments || []) {
		parts.push(`| file ${a.filename} ${a.size}B ${a.url}`);
	}
	for (const s of m.sticker_items || []) {
		parts.push(`| sticker ${s.name}`);
	}
	for (const e of m.embeds || []) {
		const title = e.title || (e.author && e.author.name) || '';
		const url = e.url && !(content || '').includes(e.url) ? e.url : '';
		const text = !content && e.description ? clip(plain(e.description, names), EMBED_TEXT) : '';
		const embed = [title, url, text].filter(Boolean).join(' ');
		if (embed) {
			parts.push(`| embed ${embed}`);
		}
	}
	if (m.poll) {
		const answers = (m.poll.answers || [])
			.map((a) => a.poll_media && a.poll_media.text)
			.filter(Boolean);
		parts.push(`| poll ${(m.poll.question && m.poll.question.text) || ''}: ${answers.join(' / ')}`);
	}
	return parts;
}

/**
 * The author a reply answers: the answered message the API joins, else the
 * page being read, else the answered id
 * @param {object} m
 * @param {Object<string, object>} page Messages of the page by id
 * @returns {string}
 */
function replyTo(m, page) {
	const ref = m.message_reference && m.message_reference.message_id;
	if (m.referenced_message) {
		return speaker(m.referenced_message.author);
	}
	if (page[ref]) {
		return speaker(page[ref].author);
	}
	return `message ${ref}`;
}

/**
 * One message on one line
 * @param {object} m
 * @param {Object<string, object>} page Messages of the page by id
 * @param {{users: object, roles: object, channels: object}} tables Names by id
 * @returns {string}
 */
function message(m, page, tables) {
	const names = tables;
	const parts = [m.id, stamp(m.timestamp)];

	if (SYSTEM[m.type]) {
		parts.push(`* ${speaker(m.author)} ${SYSTEM[m.type]}`);
		if (m.content) {
			parts.push(plain(m.content, names));
		}
		return parts.join(' ');
	}

	parts.push(`${speaker(m.author)}:`);
	const body = plain(m.content, names);
	if (body) {
		parts.push(body);
	}
	if (m.type === REPLY && m.message_reference) {
		parts.push(`| reply to ${replyTo(m, page)}`);
	}
	parts.push(...extras(m, names, m.content));
	for (const snap of m.message_snapshots || []) {
		const f = snap.message || {};
		const fwd = plain(f.content, names);
		parts.push('| forwarded' + (fwd ? ': ' + fwd : ''));
		parts.push(...extras(f, names, f.content));
	}
	for (const r of m.reactions || []) {
		const name = r.emoji && (r.emoji.name || r.emoji.id);
		if (name) {
			parts.push(`| react ${name} x${r.count}`);
		}
	}
	return parts.join(' ');
}

module.exports = { author, message };
