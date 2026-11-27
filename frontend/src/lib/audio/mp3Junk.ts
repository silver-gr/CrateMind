/** An MP3 with stray bytes between its ID3 tag and its first audio frame (often the rest of an old cover image):
 * ffmpeg reads past them, WebKit cannot decode the file at all, and the `<audio>` element plays it wrongly or not at
 * all. CrateMind never writes to the file; the message says how the owner can fix it in another app. */
export const JUNK_BEFORE_AUDIO_MESSAGE =
  "Αυτό το MP3 έχει περιττά δεδομένα πριν αρχίσει ο ήχος και ο player δεν μπορεί να το διαβάσει. "
  + "Αποθήκευσέ το ξανά σε άλλη εφαρμογή (π.χ. ένα πρόγραμμα για tags) και φόρτωσέ το πάλι.";

const KBPS = { mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const RATES = [44100, 48000, 32000];
/** How far to look past the tag for the first real frame (the leftovers measured were 19–40 KB). */
const SEARCH_BYTES = 256 * 1024;

/** The byte length of an MPEG audio Layer III frame starting at `i`, or 0 when no valid frame header is there. */
function frameLength(b: Uint8Array, i: number): number {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return 0;
  const version = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bitrate = b[i + 2] >> 4, rate = (b[i + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || rate === 3) return 0;
  const mpeg1 = version === 3;
  const sampleRate = RATES[rate] >> (mpeg1 ? 0 : version === 2 ? 1 : 2);
  return Math.floor(((mpeg1 ? 144 : 72) * (mpeg1 ? KBPS.mpeg1 : KBPS.mpeg2)[bitrate] * 1000) / sampleRate) + ((b[i + 2] >> 1) & 1);
}

/** True when the file starts with ID3v2 tags that are not followed directly by audio, but two audio frames in a row
 * come a little later: the layout WebKit cannot decode. */
export function junkBeforeAudio(b: Uint8Array): boolean {
  let pos = 0;
  while (pos + 10 <= b.length && b[pos] === 0x49 && b[pos + 1] === 0x44 && b[pos + 2] === 0x33) {
    pos += 10 + ((b[pos + 6] & 0x7f) << 21 | (b[pos + 7] & 0x7f) << 14 | (b[pos + 8] & 0x7f) << 7 | (b[pos + 9] & 0x7f))
      + (b[pos + 5] & 0x10 ? 10 : 0);
  }
  if (pos === 0 || pos >= b.length || frameLength(b, pos)) return false;
  for (let i = pos + 1, end = Math.min(b.length, pos + SEARCH_BYTES); i < end; i++) {
    const n = frameLength(b, i);
    if (n && frameLength(b, i + n)) return true;
  }
  return false;
}
