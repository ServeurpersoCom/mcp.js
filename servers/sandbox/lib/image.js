/**
 * Image fitting
 * An image as a model is sent it, the way the KiSS backend sends it: known by
 * its first bytes, a JPEG that fits goes as it is, a WebP goes as it is or not
 * at all, an opaque PNG that fits goes as it is when it weighs less than its
 * JPEG, any other comes back as a JPEG that fits, its proportions and its
 * orientation kept, a transparent one laid on white
 *
 * The size and the EXIF orientation are read from the header before anything
 * decodes the image, so an image over the pixel limit is never decoded. The
 * decoding, resizing and encoding run in libvips through sharp
 */

const sharp = require('sharp');

/**
 * The MIME type of an image by its first bytes, undefined for anything else
 * @param {Buffer} head
 * @returns {string|undefined}
 */
function imageType(head) {
	if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return 'image/png';
	}
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
		return 'image/jpeg';
	}
	const ascii = head.subarray(0, 12).toString('latin1');
	if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
		return 'image/gif';
	}
	if (ascii.length === 12 && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
		return 'image/webp';
	}
	return undefined;
}

/**
 * A byte of the image, 0 past its end, so a header that lies reads no further
 * @param {Buffer} s
 * @param {number} i
 * @returns {number}
 */
function at(s, i) {
	return i < s.length ? s[i] : 0;
}

/**
 * The size of a WebP from its first chunk: lossy, lossless or extended
 * @param {Buffer} s
 * @returns {{width: number, height: number}|null}
 */
function webpSize(s) {
	const chunk = s.toString('latin1', 12, 16);
	let width;
	let height;
	if (chunk === 'VP8 ') {
		width = (at(s, 26) | (at(s, 27) << 8)) & 0x3fff;
		height = (at(s, 28) | (at(s, 29) << 8)) & 0x3fff;
	} else if (chunk === 'VP8L') {
		const bits = (at(s, 21) | (at(s, 22) << 8) | (at(s, 23) << 16) | (at(s, 24) << 24)) >>> 0;
		width = (bits & 0x3fff) + 1;
		height = ((bits >>> 14) & 0x3fff) + 1;
	} else if (chunk === 'VP8X') {
		width = (at(s, 24) | (at(s, 25) << 8) | (at(s, 26) << 16)) + 1;
		height = (at(s, 27) | (at(s, 28) << 8) | (at(s, 29) << 16)) + 1;
	} else {
		return null;
	}
	return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The size and the EXIF orientation of a JPEG, read from its segments up to
 * the first scan: the size from its frame header, the orientation, 1 to 8,
 * from the tag 0x0112 of the first directory of an APP1 that opens on Exif,
 * in the byte order its TIFF header names; 1 when it records none
 * @param {Buffer} s
 * @returns {{width: number, height: number, orientation: number}|null}
 */
function jpegHeader(s) {
	let width = 0;
	let height = 0;
	let orientation = 1;
	for (let i = 2; at(s, i) === 0xff && i + 4 <= s.length;) {
		const marker = at(s, i + 1);
		const length = (at(s, i + 2) << 8) | at(s, i + 3);
		if (marker === 0xda || marker === 0xd9 || length < 2) {
			break;
		}
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			height = (at(s, i + 5) << 8) | at(s, i + 6);
			width = (at(s, i + 7) << 8) | at(s, i + 8);
		}
		if (marker === 0xe1 && s.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
			const tiff = i + 10;
			const little = at(s, tiff) === 0x49;
			const u16 = (p) => (little ? at(s, p) | (at(s, p + 1) << 8) : (at(s, p) << 8) | at(s, p + 1));
			const u32 = (p) => (little ? u16(p) + u16(p + 2) * 65536 : u16(p) * 65536 + u16(p + 2));
			const dir = tiff + u32(tiff + 4);
			for (let k = 0, n = u16(dir); k < n; k++) {
				const entry = dir + 2 + 12 * k;
				if (u16(entry) === 0x0112) {
					const v = u16(entry + 8);
					orientation = v >= 1 && v <= 8 ? v : 1;
					break;
				}
			}
		}
		i += 2 + length;
	}
	return width > 0 && height > 0 ? { width, height, orientation } : null;
}

/**
 * The size an image declares in its header, read before anything decodes it,
 * and its EXIF orientation, 1 but for a JPEG that records another
 * @param {Buffer} s
 * @param {string} mime
 * @returns {{width: number, height: number, orientation: number}|null}
 */
function declaredSize(s, mime) {
	if (mime === 'image/png') {
		const width = at(s, 16) * 16777216 + ((at(s, 17) << 16) | (at(s, 18) << 8) | at(s, 19));
		const height = at(s, 20) * 16777216 + ((at(s, 21) << 16) | (at(s, 22) << 8) | at(s, 23));
		return width > 0 && height > 0 ? { width, height, orientation: 1 } : null;
	}
	if (mime === 'image/gif') {
		const width = at(s, 6) | (at(s, 7) << 8);
		const height = at(s, 8) | (at(s, 9) << 8);
		return width > 0 && height > 0 ? { width, height, orientation: 1 } : null;
	}
	if (mime === 'image/jpeg') {
		return jpegHeader(s);
	}
	const webp = mime === 'image/webp' ? webpSize(s) : null;
	return webp ? { ...webp, orientation: 1 } : null;
}

/**
 * The image the bytes of a file send, within the limits
 * @param {Buffer} bytes
 * @param {{pixels: number, side: number, quality: number}} limits Pixels an
 * image may hold before it is decoded, longest side sent, JPEG quality 1 to 100
 * @returns {Promise<object>} data, mime, width, height of the image sent, and
 * sourceMime, sourceWidth, sourceHeight, made, transparent; or error alone
 */
async function imageFit(bytes, limits) {
	const sourceMime = imageType(bytes);
	const declared = declaredSize(bytes, sourceMime);
	if (!declared) {
		return { error: `Cannot read the size of the ${sourceMime}` };
	}
	const { width: w, height: h, orientation } = declared;
	const out = { sourceMime, sourceWidth: w, sourceHeight: h, made: false, transparent: false };
	if (w * h > limits.pixels) {
		return { error: `Image of ${w}x${h}, more than ${limits.pixels} pixels` };
	}
	const turned = orientation >= 5;
	const uprightW = turned ? h : w;
	const uprightH = turned ? w : h;
	const fits = Math.max(w, h) <= limits.side;

	// a WebP goes as it is, view decoding none
	if (sourceMime === 'image/webp' && !fits) {
		return {
			error: `WebP of ${w}x${h}, longer than ${limits.side} px, and view resizes no WebP`
		};
	}
	if (sourceMime === 'image/webp' || (sourceMime === 'image/jpeg' && orientation === 1 && fits)) {
		return { ...out, data: bytes, mime: sourceMime, width: w, height: h };
	}

	try {
		const decoded = () => sharp(bytes, { limitInputPixels: limits.pixels, pages: 1 });
		out.transparent = !(await decoded().stats()).isOpaque;

		// the same scale on both sides, the image turned upright as its EXIF says
		const scale = Math.min(1, limits.side / Math.max(uprightW, uprightH));
		out.width = Math.max(1, Math.round(uprightW * scale));
		out.height = Math.max(1, Math.round(uprightH * scale));

		// resized in linear light when it changes size, laid on white, encoded as JPEG
		let pipeline = decoded();
		if (sourceMime === 'image/jpeg' && orientation !== 1) {
			pipeline = pipeline.rotate();
		}
		if (out.width !== uprightW || out.height !== uprightH) {
			pipeline = pipeline.gamma().resize(out.width, out.height, { fit: 'fill' });
		}
		out.data = await pipeline
			.flatten({ background: '#ffffff' })
			.jpeg({ quality: limits.quality })
			.toBuffer();
	} catch (error) {
		return { error: `Cannot decode the image: ${error.message}` };
	}

	// a PNG that needs no change goes as it is when its JPEG weighs more,
	// lossless and lighter, a drawing or a screenshot most of the time
	if (sourceMime === 'image/png' && fits && !out.transparent && bytes.length <= out.data.length) {
		return { ...out, data: bytes, mime: sourceMime };
	}
	return { ...out, mime: 'image/jpeg', made: true };
}

module.exports = { imageType, imageFit };
