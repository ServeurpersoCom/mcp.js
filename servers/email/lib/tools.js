/**
 * Email Tools Module
 * Exposes a mailbox over IMAP as three tools, the gestures of an ordinary
 * mail client
 *
 * - email_folders: the folder column with its counts
 * - email_list: one line per message, filtered on the server, paged by uid
 * - email_read: one message, its headers at two levels of detail, flagged
 *   \Seen as a client does when the user opens it
 *
 * Listing only looks, so the folders open read only there and the unseen
 * state of a list stays what the user has not read yet
 *
 * Output stays compact for the context: a list is plain lines rather than
 * JSON, and a message carries the headers a client shows unless the raw block
 * is asked for, which is what provenance questions need
 *
 * The account stays in config.json and never reaches the model
 */

const { simpleParser } = require('mailparser');
const { session, open } = require('./imap');
const { textResult } = require('../../../core/tool-result');

const config = require('../config.json').email;

const TOOLS_DEFINITIONS = require('../tools.json').map((tool) => ({
	name: tool.function.name,
	description: tool.function.description,
	inputSchema: tool.function.parameters
}));

/**
 * Keep the head of a text that exceeds the output limit
 * @param {string} text
 * @returns {string}
 */
function bound(text) {
	const bytes = Buffer.byteLength(text);
	if (bytes <= config.outputLimitBytes) {
		return text;
	}
	return (
		Buffer.from(text).subarray(0, config.outputLimitBytes).toString() +
		`\n[cut at ${config.outputLimitBytes} of ${bytes} bytes]`
	);
}

/**
 * Turn a handler into a tool, a thrown error becoming an error result
 * @param {function(object): Promise<string>} handler Resolves to the text to return
 * @returns {function(object): Promise<object>}
 */
function tool(handler) {
	return async (args) => {
		try {
			return textResult(bound(await handler(args)));
		} catch (error) {
			return textResult(error.responseText || error.message, true);
		}
	};
}

/**
 * A date as YYYY-MM-DD HH:MM in UTC
 * @param {Date} date
 * @returns {string}
 */
function stamp(date) {
	return date.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * A YYYY-MM-DD argument as a Date
 * @param {string} value
 * @param {string} what Argument name for the error
 * @returns {Date}
 */
function day(value, what) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error(`Invalid ${what} "${value}", YYYY-MM-DD`);
	}
	return new Date(`${value}T00:00:00Z`);
}

/**
 * A uid argument, rejecting anything that would read as a range
 * @param {*} value
 * @param {string} what Argument name for the error
 * @returns {number}
 */
function uidOf(value, what) {
	const uid = Number(value);
	if (!Number.isInteger(uid) || uid < 1) {
		throw new Error(`Invalid ${what} "${value}"`);
	}
	return uid;
}

/**
 * The sender of an envelope, name and address
 * @param {object[]} [list] Envelope address list
 * @returns {string}
 */
function sender(list) {
	const first = list && list[0];
	if (!first) {
		return '(no sender)';
	}
	return first.name ? `${first.name} <${first.address}>` : first.address;
}

/**
 * Folders with their counts and special use
 * @returns {Promise<string>}
 */
async function folders() {
	const entries = await session((client) =>
		client.list({ statusQuery: { messages: true, unseen: true } })
	);

	return entries
		.map((entry) => {
			const counts = entry.status
				? `  ${entry.status.messages} messages, ${entry.status.unseen} unseen`
				: '';
			const use = entry.specialUse ? `  ${entry.specialUse}` : '';
			return `${entry.path}${counts}${use}`;
		})
		.join('\n');
}

/**
 * Messages of a folder, newest first
 * @param {object} args See tools.json
 * @returns {Promise<string>}
 */
async function list({
	folder = 'INBOX',
	limit = 20,
	before,
	unseen,
	from,
	to,
	subject,
	body,
	since,
	until
}) {
	const count = Math.min(Math.max(Number(limit) || 20, 1), 100);

	const query = {};
	if (unseen) query.seen = false;
	if (from) query.from = from;
	if (to) query.to = to;
	if (subject) query.subject = subject;
	if (body) query.body = body;
	if (since) query.since = day(since, 'since');
	if (until) query.before = day(until, 'until');
	if (before != null) query.uid = `1:${uidOf(before, 'before') - 1}`;
	if (Object.keys(query).length === 0) query.all = true;

	return open(folder, true, async (client) => {
		const uids = (await client.search(query, { uid: true })) || [];
		const page = uids.slice(-count);
		if (page.length === 0) {
			return `${folder}: 0 matching`;
		}

		const messages = await client.fetchAll(
			page.join(','),
			{ uid: true, flags: true, envelope: true, internalDate: true },
			{ uid: true }
		);
		messages.sort((a, b) => b.uid - a.uid);

		const more = uids.length > page.length ? `, older page: before=${page[0]}` : '';
		const head = `${folder}: ${uids.length} matching, ${page.length} shown${more}`;

		const lines = messages.map((msg) => {
			const state =
				(msg.flags.has('\\Seen') ? ' ' : '*') + (msg.flags.has('\\Flagged') ? '!' : ' ');
			const date = stamp(msg.envelope.date || msg.internalDate);
			return `${msg.uid}  ${date}  ${state}  ${sender(msg.envelope.from)}  ${msg.envelope.subject || '(no subject)'}`;
		});

		return [head, ...lines].join('\n');
	});
}

/**
 * One message with its headers, body and attachment list, flagged \Seen
 * @param {{folder: string, uid: number, headers?: string}} args
 * @returns {Promise<string>}
 */
async function read({ folder, uid, headers = 'summary' }) {
	const id = uidOf(uid, 'uid');

	return open(folder, false, async (client) => {
		const msg = await client.fetchOne(
			String(id),
			{ uid: true, flags: true, source: true },
			{ uid: true }
		);
		if (!msg) {
			throw new Error(`No message with uid ${id} in ${folder}`);
		}

		await client.messageFlagsAdd(String(id), ['\\Seen'], { uid: true });
		msg.flags.add('\\Seen');

		const mail = await simpleParser(msg.source);
		const out = [];

		if (headers === 'full') {
			const raw = msg.source.toString();
			const end = raw.search(/\r?\n\r?\n/);
			out.push(end < 0 ? raw : raw.slice(0, end));
		} else {
			const listId = mail.headerLines.find((h) => h.key === 'list-id');
			for (const [key, value] of [
				['From', mail.from && mail.from.text],
				['To', mail.to && mail.to.text],
				['Cc', mail.cc && mail.cc.text],
				['Reply-To', mail.replyTo && mail.replyTo.text],
				['Date', mail.date && mail.date.toISOString()],
				['Subject', mail.subject],
				['List-ID', listId && listId.line.replace(/^list-id:\s*/i, '')]
			]) {
				if (value) out.push(`${key}: ${value}`);
			}
		}
		out.push(`Flags: ${[...msg.flags].join(' ') || '(none)'}`);

		out.push('', (mail.text || '').trim());

		if (mail.attachments.length > 0) {
			out.push('', 'Attachments:');
			for (const a of mail.attachments) {
				out.push(`  ${a.filename || '(unnamed)'}  ${a.contentType}  ${a.size} bytes`);
			}
		}

		return out.join('\n');
	});
}

const TOOLS_MAPPING = {
	email_folders: tool(folders),
	email_list: tool(list),
	email_read: tool(read)
};

module.exports = {
	TOOLS_DEFINITIONS,
	TOOLS_MAPPING
};
