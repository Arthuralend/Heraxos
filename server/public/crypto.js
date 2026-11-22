// Ahazang E2E: ECDH P-256 → AES-256-GCM. Приватный ключ покидает устройство только зашифрованным паролем (PBKDF2-SHA256).
const HX = (() => {
  const S = crypto.subtle, enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const ITER = 600000;
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

  async function passKey(password, salt) {
    const base = await S.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return S.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // Новая пара ключей: возвращает то, что уходит на сервер, и pkcs8 для локального хранения
  async function generate(password) {
    const kp = await S.generateKey(ECDH, true, ['deriveKey']);
    const pub = b64(await S.exportKey('raw', kp.publicKey));
    const pkcs8 = await S.exportKey('pkcs8', kp.privateKey);
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await S.encrypt({ name: 'AES-GCM', iv }, await passKey(password, salt), pkcs8);
    return { server: { pub, wrapped: b64(wrapped), salt: b64(salt), iv: b64(iv) }, local: b64(pkcs8), pub };
  }

  async function unwrap(keys, password) {
    const pk = await passKey(password, unb64(keys.salt));
    const pkcs8 = await S.decrypt({ name: 'AES-GCM', iv: unb64(keys.iv) }, pk, unb64(keys.wrapped));
    return b64(pkcs8);
  }

  let myPriv = null; const shared = new Map();
  async function load(localPkcs8) {
    myPriv = await S.importKey('pkcs8', unb64(localPkcs8), ECDH, false, ['deriveKey']); shared.clear();
  }
  async function keyFor(peerPub) {
    if (shared.has(peerPub)) return shared.get(peerPub);
    const pub = await S.importKey('raw', unb64(peerPub), ECDH, false, []);
    const k = await S.deriveKey({ name: 'ECDH', public: pub }, myPriv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    shared.set(peerPub, k); return k;
  }
  async function seal(peerPub, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await S.encrypt({ name: 'AES-GCM', iv }, await keyFor(peerPub), enc.encode(text));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function open(peerPub, iv, ct) {
    try { return dec.decode(await S.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await keyFor(peerPub), unb64(ct))); }
    catch { return null; }
  }
  // ---------- файлы ----------
  // Случайный ключ AES-256-GCM на каждый файл; файл шифруется частями по 1 МБ
  // (IV части = 8 случайных байт + номер части), так меньше расход памяти на телефоне.
  const CHUNK = 1024 * 1024, TAG = 16;
  const ivOf = (base, i) => { const v = new Uint8Array(12); v.set(base); new DataView(v.buffer).setUint32(8, i); return v; };
  async function sealFile(blob, onProgress) {
    const raw = crypto.getRandomValues(new Uint8Array(32)), base = crypto.getRandomValues(new Uint8Array(8));
    const key = await S.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const parts = [], n = Math.max(1, Math.ceil(blob.size / CHUNK));
    for (let i = 0; i < n; i++) {
      const plainPart = await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
      parts.push(new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv: ivOf(base, i) }, key, plainPart)));
      onProgress && onProgress((i + 1) / n);
    }
    return { blob: new Blob(parts), k: b64(raw), iv: b64(base) };
  }
  async function openFile(buf, k, iv, type) {
    const key = await S.importKey('raw', unb64(k), 'AES-GCM', false, ['decrypt']), base = unb64(iv);
    const parts = [], size = CHUNK + TAG;
    for (let i = 0, off = 0; off < buf.byteLength; i++, off += size) {
      parts.push(new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv: ivOf(base, i) }, key, buf.slice(off, off + size))));
    }
    return new Blob(parts, { type: type || 'application/octet-stream' });
  }
  return { generate, unwrap, load, seal, open, sealFile, openFile, ready: () => !!myPriv };
})();
