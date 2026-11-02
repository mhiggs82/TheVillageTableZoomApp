// Decrypts the X-Zoom-App-Context value Zoom gives the app. It is how the server learns,
// without trusting the browser, which Zoom user and meeting a request comes from.
// Layout: [ivLength 1][iv][aadLength 2 LE][aad][cipherLength 4 LE][cipher][tag 16]
// Key: SHA-256 of the app's client secret. AES-256-GCM.
import { createDecipheriv, createCipheriv, createHash, randomBytes } from 'node:crypto';

const TAG_LENGTH = 16;

export function unpack(header) {
  const buf = Buffer.from(String(header), 'base64'); // accepts standard and url-safe alphabets
  let pos = 0;
  const take = (n) => {
    if (n < 0 || pos + n > buf.length) throw new Error('malformed context');
    const out = buf.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const iv = take(take(1).readUInt8(0));
  const aad = take(take(2).readUInt16LE(0));
  const cipherText = take(take(4).readUInt32LE(0));
  const tag = buf.subarray(pos);
  if (iv.length < 12 || tag.length !== TAG_LENGTH) throw new Error('malformed context'); // reject truncated tags
  return { iv, aad, cipherText, tag };
}

export function decryptContext(header, clientSecret) {
  const { iv, aad, cipherText, tag } = unpack(header);
  const key = createHash('sha256').update(clientSecret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** Test helper: builds a header the same way Zoom does. */
export function encryptContext(obj, clientSecret, aad = '{}') {
  const key = createHash('sha256').update(clientSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const aadBuf = Buffer.from(aad);
  const lens = (n, bytes) => { const b = Buffer.alloc(bytes); if (bytes === 2) b.writeUInt16LE(n); else b.writeUInt32LE(n); return b; };
  return Buffer.concat([Buffer.from([iv.length]), iv, lens(aadBuf.length, 2), aadBuf, lens(ct.length, 4), ct, cipher.getAuthTag()]).toString('base64');
}
