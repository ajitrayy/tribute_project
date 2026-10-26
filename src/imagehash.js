import sharp from 'sharp';

/**
 * 64-bit difference hash. Re-encoded, resized or lightly recompressed copies of
 * the same poster land within a few bits of each other, which catches the same
 * poster reposted under a new post id or shared across several monitored Pages.
 */
export async function dHash(buffer) {
  const { data } = await sharp(buffer).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
