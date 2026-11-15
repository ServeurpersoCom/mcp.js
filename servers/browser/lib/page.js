/**
 * Page side of the browser tools
 * One function the session runs in a sandbox of the page, a realm of its own:
 * it sees the DOM through the browser's own view of it, the page scripts never
 * see it, never reach its state and cannot alter what it reads
 *
 * The sandbox keeps a table of refs for the life of the document: an element
 * the snapshot shows gets a ref, e1, e2..., and keeps it in every later
 * snapshot, so a ref names one element until the page navigates
 *
 * Ops:
 * - snapshot: the accessibility tree as an indented outline, each node its
 *   role, its name, its states and its ref
 * - locate: the viewport point of the center of an element, scrolled into
 *   view, checked visible, enabled and not covered when asked
 * - element: the element itself, for the commands that take a node
 * - fill: the value of a text field, set at once as a paste does
 * - select: options of a select, chosen by value or label
 * - state: whether a checkbox or radio is checked
 * - ref: the ref of an element, given one
 * - text: the rendered text of the page
 * - info: the url, title, visibility and viewport size of the page
 */

/**
 * Run one op in the sandbox; the session sends its source as is, so it uses no
 * name from outside its body
 * @param {string} op
 * @param {object} args
 * @param {Element=} node An element the op receives from the session
 * @returns {*}
 */
function page(op, args, node) {
	const NAME_MAX = 200;
	const SKIP = new Set([
		'script',
		'style',
		'noscript',
		'template',
		'head',
		'meta',
		'link',
		'title'
	]);
	const FROM_CONTENT = new Set([
		'button',
		'link',
		'heading',
		'option',
		'cell',
		'columnheader',
		'rowheader',
		'tab',
		'menuitem',
		'menuitemcheckbox',
		'menuitemradio',
		'treeitem',
		'checkbox',
		'radio',
		'switch',
		'tooltip'
	]);
	const INTERACTIVE = new Set([
		'button',
		'link',
		'textbox',
		'searchbox',
		'combobox',
		'listbox',
		'option',
		'checkbox',
		'radio',
		'switch',
		'slider',
		'spinbutton',
		'tab',
		'menuitem',
		'menuitemcheckbox',
		'menuitemradio',
		'treeitem'
	]);
	const PLAIN = new Set(['generic', 'none', 'presentation']);
	const TEXT_INPUTS = new Set(['text', 'email', 'search', 'tel', 'url', 'password', 'number', '']);
	const INPUT_ROLES = {
		button: 'button',
		submit: 'button',
		reset: 'button',
		image: 'button',
		file: 'button',
		checkbox: 'checkbox',
		radio: 'radio',
		range: 'slider',
		number: 'spinbutton',
		search: 'searchbox',
		color: 'button'
	};
	const TAG_ROLES = {
		button: 'button',
		textarea: 'textbox',
		img: 'img',
		h1: 'heading',
		h2: 'heading',
		h3: 'heading',
		h4: 'heading',
		h5: 'heading',
		h6: 'heading',
		ul: 'list',
		ol: 'list',
		li: 'listitem',
		nav: 'navigation',
		main: 'main',
		aside: 'complementary',
		table: 'table',
		tr: 'row',
		td: 'cell',
		th: 'columnheader',
		dialog: 'dialog',
		p: 'paragraph',
		hr: 'separator',
		progress: 'progressbar',
		meter: 'meter',
		fieldset: 'group',
		details: 'group',
		summary: 'button',
		article: 'article',
		blockquote: 'blockquote',
		iframe: 'iframe',
		option: 'option',
		dl: 'list',
		dt: 'term',
		dd: 'definition',
		figure: 'figure',
		legend: 'legend'
	};

	const SVG = 'http://www.w3.org/2000/svg';

	const st = window.__mcp || (window.__mcp = { next: 1, refs: new Map(), ids: new Map() });

	function collapse(text) {
		return (text || '').replace(/\s+/g, ' ').trim();
	}

	function cut(text) {
		return text.length > NAME_MAX ? text.slice(0, NAME_MAX) + '...' : text;
	}

	function refOf(el) {
		let ref = st.ids.get(el);
		if (!ref) {
			ref = `e${st.next++}`;
			st.ids.set(el, ref);
			st.refs.set(ref, el);
		}
		return ref;
	}

	function byRef(ref) {
		const el = st.refs.get(ref);
		if (!el || !el.isConnected) {
			throw new Error(`Ref ${ref} is not on the page, take a new snapshot`);
		}
		return el;
	}

	function describe(el) {
		const id = el.id ? `#${el.id}` : '';
		const cls =
			typeof el.className === 'string' && el.className.trim()
				? `.${el.className.trim().split(/\s+/).join('.')}`
				: '';
		return `<${el.localName}${id}${cls}>`;
	}

	function role(el) {
		const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
		if (explicit) {
			return explicit;
		}
		const tag = el.localName;
		if (el.namespaceURI === SVG) {
			if (tag === 'a') {
				return 'link';
			}
			return tag === 'svg' && svgName(el) ? 'img' : null;
		}
		if (tag === 'a' || tag === 'area') {
			return el.hasAttribute('href') ? 'link' : null;
		}
		if (tag === 'input') {
			const type = (el.getAttribute('type') || '').toLowerCase();
			if (type === 'hidden') {
				return null;
			}
			if (INPUT_ROLES[type]) {
				return INPUT_ROLES[type];
			}
			return el.hasAttribute('list') ? 'combobox' : 'textbox';
		}
		if (tag === 'select') {
			return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
		}
		if (tag === 'header') {
			return el.closest('article, aside, main, nav, section') ? null : 'banner';
		}
		if (tag === 'footer') {
			return el.closest('article, aside, main, nav, section') ? null : 'contentinfo';
		}
		if (tag === 'section' || tag === 'form') {
			return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
				? tag === 'form'
					? 'form'
					: 'region'
				: null;
		}
		if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) {
			return 'textbox';
		}
		return TAG_ROLES[tag] || null;
	}

	function svgName(el) {
		const title = el.querySelector(':scope > title');
		return collapse(el.getAttribute('aria-label') || (title ? title.textContent : ''));
	}

	function textOf(el) {
		let text = collapse(el.innerText !== undefined ? el.innerText : el.textContent);
		if (!text) {
			const img = el.querySelector('img[alt], [aria-label]');
			text = img ? collapse(img.getAttribute('alt') || img.getAttribute('aria-label')) : '';
		}
		return text;
	}

	function nameOf(el, r) {
		const labelledby = el.getAttribute('aria-labelledby');
		if (labelledby) {
			const doc = el.ownerDocument;
			const text = collapse(
				labelledby
					.split(/\s+/)
					.map((id) => doc.getElementById(id))
					.filter(Boolean)
					.map(textOf)
					.join(' ')
			);
			if (text) {
				return cut(text);
			}
		}
		const label = collapse(el.getAttribute('aria-label'));
		if (label) {
			return cut(label);
		}
		const tag = el.localName;
		if (tag === 'input' || tag === 'textarea' || tag === 'select') {
			const type = (el.getAttribute('type') || '').toLowerCase();
			if (tag === 'input' && (type === 'submit' || type === 'reset' || type === 'button')) {
				return cut(
					collapse(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '')
				);
			}
			if (tag === 'input' && type === 'file') {
				const labels = el.labels ? collapse(Array.from(el.labels).map(textOf).join(' ')) : '';
				return cut(labels || 'Choose file');
			}
			if (tag === 'input' && type === 'image') {
				return cut(collapse(el.getAttribute('alt')));
			}
			const labels = el.labels ? Array.from(el.labels).map(textOf).join(' ') : '';
			const text =
				collapse(labels) ||
				collapse(el.getAttribute('placeholder')) ||
				collapse(el.getAttribute('title'));
			return cut(text);
		}
		if (el.namespaceURI === SVG) {
			return cut(svgName(el) || (r === 'link' ? textOf(el) : ''));
		}
		if (tag === 'img' || tag === 'area') {
			return cut(collapse(el.getAttribute('alt')) || collapse(el.getAttribute('title')));
		}
		if (tag === 'fieldset') {
			const legend = el.querySelector(':scope > legend');
			if (legend) {
				return cut(textOf(legend));
			}
		}
		if (tag === 'table') {
			const caption = el.querySelector(':scope > caption');
			if (caption) {
				return cut(textOf(caption));
			}
		}
		if (FROM_CONTENT.has(r)) {
			const text = textOf(el);
			if (text) {
				return cut(text);
			}
		}
		return cut(collapse(el.getAttribute('title')));
	}

	function visible(el) {
		return el.checkVisibility({ visibilityProperty: true });
	}

	function props(el, r) {
		const out = [];
		const aria = (name) => el.getAttribute(`aria-${name}`);
		if (
			r === 'checkbox' ||
			r === 'radio' ||
			r === 'switch' ||
			r === 'menuitemcheckbox' ||
			r === 'menuitemradio'
		) {
			const checked = el.localName === 'input' ? el.checked : aria('checked') === 'true';
			if (checked) {
				out.push('checked');
			}
		}
		if (el.disabled || aria('disabled') === 'true') {
			out.push('disabled');
		}
		if (aria('expanded') === 'true') {
			out.push('expanded');
		}
		if ((el.localName === 'option' && el.selected) || aria('selected') === 'true') {
			out.push('selected');
		}
		if (aria('pressed') === 'true') {
			out.push('pressed');
		}
		if (r === 'heading') {
			const level = aria('level') || (/^h[1-6]$/.test(el.localName) ? el.localName[1] : '');
			if (level) {
				out.push(`level=${level}`);
			}
		}
		const doc = el.ownerDocument;
		if (doc.activeElement === el && doc.hasFocus()) {
			out.push('active');
		}
		return out;
	}

	function valueOf(el, r) {
		const tag = el.localName;
		if (tag === 'select') {
			return collapse(
				Array.from(el.selectedOptions)
					.map((o) => o.label)
					.join(', ')
			);
		}
		if (tag === 'input' || tag === 'textarea') {
			const type = (el.getAttribute('type') || '').toLowerCase();
			if (type === 'file') {
				return cut(
					Array.from(el.files)
						.map((f) => f.name)
						.join(', ')
				);
			}
			if (type === 'password') {
				return el.value ? '[hidden]' : '';
			}
			if (tag === 'textarea' || TEXT_INPUTS.has(type) || r === 'slider' || r === 'combobox') {
				return cut(collapse(el.value));
			}
			return '';
		}
		if (r === 'textbox' && el.isContentEditable) {
			return cut(textOf(el));
		}
		return '';
	}

	function children(el) {
		if (el.localName === 'slot') {
			const assigned = el.assignedNodes({ flatten: true });
			return assigned.length ? assigned : Array.from(el.childNodes);
		}
		if (el.localName === 'iframe' || el.localName === 'frame') {
			let doc = null;
			try {
				doc = el.contentDocument;
			} catch {
				doc = null;
			}
			return doc && doc.body ? [doc.body] : [];
		}
		const root = el.shadowRoot;
		return Array.from((root || el).childNodes);
	}

	function pointer(el) {
		if (el.ownerDocument.defaultView.getComputedStyle(el).cursor !== 'pointer') {
			return false;
		}
		const parent = el.parentElement;
		return (
			!parent || parent.ownerDocument.defaultView.getComputedStyle(parent).cursor !== 'pointer'
		);
	}

	function build(el, inSelect) {
		const tag = el.localName;
		if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true') {
			return [];
		}
		const view = el.ownerDocument.defaultView;
		const contents = view.getComputedStyle(el).display === 'contents';
		if (!inSelect && !contents && !visible(el)) {
			return [];
		}
		let r = role(el);
		const focusable = el.hasAttribute('tabindex') && el.tabIndex >= 0;
		const draggable = el.getAttribute('draggable') === 'true';
		const shape = el.namespaceURI === SVG && !svgName(el);
		if ((r === null || PLAIN.has(r)) && !shape && (pointer(el) || focusable || draggable)) {
			r = 'generic';
		} else if (PLAIN.has(r)) {
			r = null;
		}
		const kids = [];
		let text = '';
		const flush = () => {
			const t = collapse(text);
			if (t) {
				kids.push({ text: t });
			}
			text = '';
		};
		for (const child of children(el)) {
			if (child.nodeType === 3) {
				text += ' ' + child.data;
			} else if (child.nodeType === 1) {
				const inline = view.getComputedStyle(child).display.startsWith('inline');
				if (!inline) {
					flush();
				}
				for (const k of build(child, inSelect || tag === 'select')) {
					if (k.role) {
						flush();
						kids.push(k);
					} else {
						text += ' ' + k.text;
					}
				}
				if (!inline) {
					flush();
				}
			}
		}
		flush();
		if (!r) {
			return kids;
		}
		const node = {
			role: r,
			name:
				r === 'generic'
					? cut(
							textOf(el) ||
								collapse(el.getAttribute('aria-label')) ||
								collapse(el.getAttribute('title'))
						)
					: nameOf(el, r),
			props: props(el, r),
			value: valueOf(el, r),
			ref: refOf(el),
			children: kids
		};
		if (tag === 'a' && el.href) {
			node.url = el.href;
		}
		if (tag === 'iframe' && !kids.length) {
			node.props.push('not read');
		}
		if ((FROM_CONTENT.has(r) || r === 'generic') && node.name && !kids.some((k) => k.role)) {
			node.children = [];
		}
		if (tag === 'select' || r === 'textbox' || r === 'searchbox') {
			node.children = node.children.filter((k) => k.role);
		}
		return [node];
	}

	function interactive(n) {
		return n.role && (INTERACTIVE.has(n.role) || n.role === 'generic');
	}

	function prune(nodes, keep) {
		const out = [];
		for (const n of nodes) {
			if (keep(n)) {
				out.push(n);
				continue;
			}
			const kids = n.children ? prune(n.children, keep) : [];
			if (kids.length) {
				out.push({ ...n, children: kids, text: undefined });
			}
		}
		return out;
	}

	function render(nodes, depth, max, lines) {
		const pad = '  '.repeat(depth);
		for (const n of nodes) {
			if (!n.role) {
				lines.push(`${pad}- text: ${n.text}`);
				continue;
			}
			let line = `${pad}- ${n.role}`;
			if (n.name) {
				line += ` ${JSON.stringify(n.name)}`;
			}
			for (const p of n.props) {
				line += ` [${p}]`;
			}
			line += ` [ref=${n.ref}]`;
			const kids = n.children || [];
			const lone = !n.name && kids.length === 1 && !kids[0].role ? kids[0].text : '';
			const inline = n.value || lone;
			const rest = lone ? [] : kids;
			if (inline) {
				line += `: ${inline}`;
			} else if (n.url || (rest.length && depth < max)) {
				line += ':';
			}
			lines.push(line);
			if (n.url) {
				lines.push(`${pad}  - /url: ${n.url}`);
			}
			if (depth < max) {
				render(rest, depth + 1, max, lines);
			}
		}
	}

	function snapshot({ ref, depth, filter, find }) {
		const root = ref ? byRef(ref) : document.body || document.documentElement;
		let tree = build(root, false);
		if (filter === 'interactive') {
			tree = prune(tree, interactive);
			const strip = (nodes) =>
				nodes.filter((n) => n.role).map((n) => ({ ...n, children: strip(n.children || []) }));
			tree = strip(tree);
		}
		if (find) {
			const needle = find.toLowerCase();
			const has = (n) =>
				(n.text || n.name || '').toLowerCase().includes(needle) ||
				(n.value || '').toLowerCase().includes(needle);
			tree = prune(tree, has);
		}
		const lines = [];
		render(tree, 0, depth == null ? Infinity : depth, lines);
		return lines.join('\n');
	}

	function composedAncestor(top, el) {
		for (let n = el; n; n = n.parentNode || n.host) {
			if (n === top) {
				return true;
			}
		}
		return false;
	}

	function locate({ ref, scroll, enabled, hit }) {
		const el = byRef(ref);
		const frames = [];
		for (let w = el.ownerDocument.defaultView; w.frameElement; w = w.parent) {
			frames.push(w.frameElement);
		}
		if (scroll) {
			for (const frame of frames.slice().reverse()) {
				frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
			}
			el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
		}
		if (!visible(el)) {
			throw new Error(`${ref} is not visible`);
		}
		const rect = el.getBoundingClientRect();
		if (!rect.width || !rect.height) {
			throw new Error(`${ref} has no size on screen`);
		}
		if (enabled && (el.disabled || el.getAttribute('aria-disabled') === 'true')) {
			throw new Error(`${ref} is disabled`);
		}
		const lx = rect.left + rect.width / 2;
		const ly = rect.top + rect.height / 2;
		if (hit) {
			const top = el.ownerDocument.elementFromPoint(lx, ly);
			const label = el.labels && Array.from(el.labels).includes(top);
			if (top && !composedAncestor(top, el) && !el.contains(top) && !label) {
				throw new Error(`${ref} is covered by ${describe(top)} at its center`);
			}
		}
		let x = lx;
		let y = ly;
		for (const frame of frames) {
			const fr = frame.getBoundingClientRect();
			x += fr.left + frame.clientLeft;
			y += fr.top + frame.clientTop;
		}
		return { x, y };
	}

	function fill({ ref, text }) {
		const el = byRef(ref);
		const tag = el.localName;
		el.focus();
		if (
			tag === 'textarea' ||
			(tag === 'input' && TEXT_INPUTS.has((el.getAttribute('type') || '').toLowerCase()))
		) {
			el.value = text;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return true;
		}
		if (el.isContentEditable) {
			const doc = el.ownerDocument;
			doc.execCommand('selectAll');
			if (text) {
				doc.execCommand('insertText', false, text);
			} else {
				doc.execCommand('delete');
			}
			return true;
		}
		if (tag === 'input' && el.getAttribute('type') === 'range') {
			el.value = text;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return true;
		}
		throw new Error(`${ref} is not a text field`);
	}

	function select({ ref, values }) {
		const el = byRef(ref);
		if (el.localName !== 'select') {
			throw new Error(`${ref} is not a select`);
		}
		if (values.length > 1 && !el.multiple) {
			throw new Error(`${ref} takes one option`);
		}
		const options = Array.from(el.options);
		const chosen = values.map((v) => {
			const option =
				options.find((o) => o.value === v) ||
				options.find((o) => collapse(o.label) === collapse(v));
			if (!option) {
				throw new Error(`No option "${v}" in ${ref}`);
			}
			return option;
		});
		for (const option of options) {
			option.selected = chosen.includes(option);
		}
		el.dispatchEvent(new Event('input', { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
		return chosen.map((o) => o.label).join(', ');
	}

	switch (op) {
		case 'snapshot':
			return snapshot(args);
		case 'locate':
			return locate(args);
		case 'element':
			return byRef(args.ref);
		case 'fill':
			return fill(args);
		case 'select':
			return select(args);
		case 'state':
			return Boolean(byRef(args.ref).checked);
		case 'ref':
			return refOf(node);
		case 'text':
			return document.body ? document.body.innerText : '';
		case 'info':
			return {
				url: location.href,
				title: document.title,
				visible: document.visibilityState === 'visible',
				width: window.innerWidth,
				height: window.innerHeight
			};
		default:
			throw new Error(`Unknown page op ${op}`);
	}
}

module.exports = { PAGE: page.toString() };
