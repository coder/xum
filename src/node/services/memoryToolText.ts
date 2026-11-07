/**
 * Text of a tool's input or output as the memory harvest model reads it. Attachment bytes never
 * go to that model: a media part, or a `data:` URL in a string, becomes `[media]`.
 */

export const MEDIA_STUB = "[media]";

// RFC 2397: `data:[<media type>][;<parameter>]...[;base64],<payload>`. The header has a media type
// or a parameter, so prose such as `data: a, b` is not taken for a URL.
const MEDIA_TYPE = String.raw`[\w.+-]{1,127}/[\w.+-]{1,127}`;
const PARAMETER = String.raw`;[\w.+-]{1,64}(?:=[^;,\s"'<>]{0,128})?`;
const BASE64_CHARS = "[A-Za-z0-9+/=_-]";
// A line break inside a wrapped payload: raw, or the escape of one in JSON text.
const LINE_BREAK = String.raw`(?:\r?\n|\\r\\n|\\n)`;

// A base64 payload may be wrapped (`base64 -w 76`, MIME): full lines of at least 16 characters, and
// a short last line only behind a full one. A line of prose after an unwrapped payload stays.
const BASE64_URL =
  String.raw`data:(?:${MEDIA_TYPE})?(?:${PARAMETER}){0,3};base64,${BASE64_CHARS}+` +
  String.raw`(?:(?:${LINE_BREAK}${BASE64_CHARS}{16,})+(?:${LINE_BREAK}${BASE64_CHARS}{1,15}(?=${LINE_BREAK}|$))?)?`;

// Any other payload is percent-encoded (`data:image/svg+xml,%3Csvg...`): URL characters, no whitespace.
const ENCODED_URL =
  String.raw`data:(?:${MEDIA_TYPE}(?:${PARAMETER}){0,4}|(?:${PARAMETER}){1,4}),` +
  String.raw`[\w\-.~!$&'()*+,;=:@/?%#]+`;

export const DATA_URL_PATTERN = new RegExp(`${BASE64_URL}|${ENCODED_URL}`, "gi");
