Hand-built synthetic CMWD v2 parser fixture; no audio or personal data.

`golden.bin` is the exact blob; `golden.json` is its decoded form. The 48-byte
little-endian header is followed by five Uint8 planes in order: RMS, peak, red,
green, blue. There are eight frames and exactly 48 + 5*8 = 88 bytes. Values are
chosen to distinguish plane order; they do not represent analysed audio.

Both Python and TypeScript parser tests use this fixture. Envelope frame i is
centred at (i*40+20)/44100 seconds; colour planes already contain the aligned RGB.
