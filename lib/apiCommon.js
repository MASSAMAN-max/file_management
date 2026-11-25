/**
 * =====================================================================
 * lib/apiCommon.js
 * =====================================================================
 * Vercelの関数（api/rotate.js・api/detect_orientation.js）で共通に使うもの
 * =====================================================================
 */
const crypto = require("crypto");

// 処理するファイルの大きさの上限。アプリのアップロード上限（20MB）に、余裕を持たせた大きさ
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** 合言葉（環境変数 ROTATE_API_SECRET）と一致するかを、時間差で推測されにくい方法で比べる */
function isValidSecret(given) {
  const expected = process.env.ROTATE_API_SECRET;
  if (!expected || typeof given !== "string") return false;
  const hash = (text) => crypto.createHash("sha256").update(text).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

module.exports = { isValidSecret, MAX_FILE_BYTES };
