/**
 * Memory store
 * One entry per file under the data directory of the server, named
 * <group>/<slug>.md, the directory, the groups and the size cap coming from
 * config.json
 * An entry holds a description and a body, the description being what the index
 * carries so the model picks what to open from it
 * The index, the reads and the drops cover the whole data directory, the
 * configured groups gating the writes alone, so changing them never hides an
 * entry nor pins one
 *
 * Every call is synchronous, which makes a read-modify-write atomic on the Node
 * event loop and lets parallel tool calls land one after another with no lock
 *
 * The layout maps to a single object per entry, so the same surface can sit on
 * IndexedDB with only this module rewritten
 */

const fs = require('fs');
const path = require('path');

const config = require('../config.json').memory;

const DATA_DIR = path.resolve(__dirname, '..', config.dataDir);
const ENTRY_LIMIT_BYTES = config.entryLimitBytes;
const GROUPS = config.groups;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Format a timestamp as YYYY-MM-DD HH:MM:SS in local time
 * @param {Date} date
 * @returns {string}
 */
function stamp(date) {
	const pad = (value) => String(value).padStart(2, '0');
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	);
}

/**
 * Reject any name that would escape data/ or break the index layout
 * The shape alone gates a read and a drop, so an entry whose group left the
 * configured groups stays readable and removable
 * @param {string} name - Entry name, <group>/<slug>
 */
function checkNameShape(name) {
	const [group, slug, ...rest] = String(name || '').split('/');

	if (rest.length > 0 || !SLUG_PATTERN.test(group || '') || !SLUG_PATTERN.test(slug || '')) {
		throw new Error(`Invalid name "${name}", expected <group>/<slug> in [a-z0-9-]`);
	}
}

/**
 * Reject a name that fails the shape or lands outside a configured group
 * Writes land under a configured group only
 * @param {string} name - Entry name, <group>/<slug>
 */
function checkName(name) {
	checkNameShape(name);

	const [group] = String(name).split('/');

	if (!GROUPS.includes(group)) {
		throw new Error(`Unknown group "${group}" in "${name}", groups are ${GROUPS.join(', ')}`);
	}
}

/**
 * Absolute path backing an entry
 * @param {string} name
 * @returns {string}
 */
function entryPath(name) {
	return path.join(DATA_DIR, `${name}.md`);
}

/**
 * Serialize an entry to its file representation
 * @param {{name: string, description: string, body: string}} entry
 * @returns {string}
 */
function serialize(entry) {
	const body = entry.body.length > 0 && !entry.body.endsWith('\n') ? `${entry.body}\n` : entry.body;
	return `---\ndescription: ${entry.description}\n---\n\n${body}`;
}

/**
 * Parse an entry file, tolerating a missing or partial frontmatter
 * The byte count is what the index reports, so the model knows what opening an
 * entry costs before it opens it
 * @param {string} name
 * @param {string} raw
 * @returns {{name: string, description: string, bytes: number, body: string}}
 */
function parse(name, raw) {
	const bytes = Buffer.byteLength(raw);
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) {
		return { name, description: '', bytes, body: raw };
	}

	const description = (match[1].match(/^description:[ \t]*(.*)$/m) || [, ''])[1].trim();

	return { name, description, bytes, body: raw.slice(match[0].length).replace(/^\n/, '') };
}

/**
 * List entry names present under the data directory
 * A directory or file the naming rules reject is not part of the store, and
 * stays out of the listing rather than making the index that reads it fail
 * @returns {string[]}
 */
function list() {
	const names = [];

	if (!fs.existsSync(DATA_DIR)) {
		return names;
	}
	for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory() || !SLUG_PATTERN.test(entry.name)) {
			continue;
		}
		for (const file of fs.readdirSync(path.join(DATA_DIR, entry.name))) {
			const slug = file.endsWith('.md') ? file.slice(0, -3) : '';
			if (SLUG_PATTERN.test(slug)) {
				names.push(`${entry.name}/${slug}`);
			}
		}
	}

	return names.sort();
}

/**
 * Read one entry
 * The update time comes from the filesystem, so the model cannot write it and
 * the frontmatter carries nothing but the description
 * @param {string} name
 * @returns {object|null} Entry, or null when it does not exist
 */
function read(name) {
	checkNameShape(name);

	const filepath = entryPath(name);
	if (!fs.existsSync(filepath)) {
		return null;
	}

	const entry = parse(name, fs.readFileSync(filepath, 'utf8'));
	entry.updated = stamp(fs.statSync(filepath).mtime);

	return entry;
}

/**
 * Write one entry
 * The description holds one line, whitespace folded, so it cannot open a field
 * of its own or close the frontmatter, and so it occupies one row of the index
 * A description that folds to nothing is refused, every entry carries one the
 * index can show
 * An entry stays under ENTRY_LIMIT_BYTES, a size no single subject needs and
 * past which the model reads more than it can use, so a write that would cross
 * it is refused and the entry keeps its previous content
 * The temporary file and the rename keep a reader from ever seeing a partial
 * entry
 * @param {{name: string, description: string, body: string}} entry
 * @returns {object} The entry as stored, folded description and byte count included
 */
function write(entry) {
	checkName(entry.name);

	const stored = {
		...entry,
		description: String(entry.description ?? '')
			.replace(/\s+/g, ' ')
			.trim()
	};
	if (stored.description.length === 0) {
		throw new Error(`Entry "${entry.name}" needs a non empty description`);
	}
	const content = serialize(stored);
	stored.bytes = Buffer.byteLength(content);

	if (stored.bytes > ENTRY_LIMIT_BYTES) {
		throw new Error(
			`Entry "${entry.name}" would reach ${stored.bytes} bytes, over the ${ENTRY_LIMIT_BYTES} limit, split the subject or shorten it`
		);
	}

	const filepath = entryPath(entry.name);
	const tmp = `${filepath}.tmp`;

	fs.mkdirSync(path.dirname(filepath), { recursive: true });
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, filepath);

	return stored;
}

/**
 * Remove one entry, and its group directory once it holds nothing else
 * @param {string} name
 * @returns {boolean} False when the entry did not exist
 */
function drop(name) {
	checkNameShape(name);

	const filepath = entryPath(name);
	if (!fs.existsSync(filepath)) {
		return false;
	}

	fs.unlinkSync(filepath);

	const group = path.dirname(filepath);
	if (fs.readdirSync(group).length === 0) {
		fs.rmdirSync(group);
	}

	return true;
}

/**
 * Build the index columns of one entry
 * @param {{name: string, description: string, bytes: number}} entry
 * @returns {string[]}
 */
function row(entry) {
	return [entry.name, String(entry.bytes), entry.description];
}

/**
 * Lay rows out in aligned columns
 * @param {string[][]} rows
 * @returns {string}
 */
function columns(rows) {
	const nameWidth = Math.max(...rows.map((r) => r[0].length));
	const bytesWidth = Math.max(...rows.map((r) => r[1].length));

	return rows
		.map((r) => `${r[0].padEnd(nameWidth)}  ${r[1].padStart(bytesWidth)}  ${r[2]}`)
		.join('\n');
}

/**
 * Render the index line of one entry, the shape a mutation reports back
 * @param {{name: string, description: string, bytes: number}} entry
 * @returns {string}
 */
function line(entry) {
	return columns([row(entry)]);
}

/**
 * Render the index, one line per entry, sorted by name
 * The byte count tells the model what opening an entry costs
 * An entry gone between the listing and its read drops out of the index rather
 * than failing it
 * @returns {string}
 */
function index() {
	const rows = list()
		.map((name) => read(name))
		.filter(Boolean)
		.map(row);

	return rows.length === 0 ? 'Memory is empty' : columns(rows);
}

module.exports = { list, read, write, drop, index, line, limit: ENTRY_LIMIT_BYTES };
