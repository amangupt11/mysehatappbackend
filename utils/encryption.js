// utils/encryption.js
// XOR key must match the device
const XOR_KEY = 66;

/**
 * Decrypts Base64(XOR(bytes, XOR_KEY)) into vitals.
 * Returns: { height, weight, bmi, deviceId, plainText }
 * Throws on malformed payload.
 */
function decryptVitals(ciphertext) {
  // Base64 -> Buffer
  const xored = Buffer.from(ciphertext, 'base64');

  // XOR back to original bytes
  const bytes = Buffer.alloc(xored.length);
  for (let i = 0; i < xored.length; i++) {
    bytes[i] = xored[i] ^ XOR_KEY;
  }

  const plain = bytes.toString('utf8');

  // Expected: H=###;W=###;B=###;D=device_id
  const m = plain.match(/^H=(\d+);W=(\d+);B=(\d+);D=(.+)$/);
  if (!m) {
    const err = new Error('Malformed payload - expected H=###;W=###;B=###;D=device_id');
    err.payload = plain;
    throw err;
  }

  const H = parseInt(m[1], 10);
  const W = parseInt(m[2], 10);
  const B = parseInt(m[3], 10);
  const D = m[4];

  return {
    height: H,
    weight: W / 10,
    bmi: B / 10,
    deviceId: D,
    plainText: plain
  };
}

/**
 * Convenience wrapper that maps deviceId -> machineId
 * so the rest of your code keeps using {height, weight, bmi, machineId}.
 */
function decrypt(ciphertext) {
  const v = decryptVitals(ciphertext);
  return {
    height: v.height,
    weight: v.weight,
    bmi: v.bmi,
    machine_id: v.deviceId
  };
}

module.exports = { decrypt, decryptVitals };
