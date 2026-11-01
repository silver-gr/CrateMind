Golden fixture for the CMWD detail-waveform format (see backend/app/services/waveform_detail.py).
`golden.bin` is the exact blob; `golden.json` is its expected decoded form
(header fields, `digest_hex`, and the four Uint8 arrays full/low/mid/high, 8 frames).
Python test: backend/tests/test_waveform_detail.py. A TypeScript parser test should decode
`golden.bin` and deep-equal `golden.json` (frame i is centred at (i*hop + win/2)/sample_rate).
Header is 48 bytes little-endian; payload is exactly 48 + 4*frames bytes.
