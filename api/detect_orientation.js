/**
 * 画像・PDFの向き判定API（POST /api/detect_orientation）【読み取り専用】
 * =====================================================================
 * Drive上のファイルを読み込み、Tesseract OSD で向きを判定して、結果を返す。
 * ファイルは書き換えない（rotate.js と違い、replaceContent も appProperties の更新も行わない）。
 * GAS の 18_画像向き補正.js が、OCRの前に呼ぶ。結果の採用（信頼度の基準）は、呼び出し側が決める。
 *
 * 【リクエスト（JSON）】rotate.js と同じ（rotation・pageRotations は不要）
 *   secret       … 合言葉（Vercelの環境変数 ROTATE_API_SECRET。rotate.js と共通）
 *   driveFileId  … 判定するDriveのファイルID
 *   accessToken  … GASが渡す、Driveの一時的なアクセストークン（ScriptApp.getOAuthToken()）
 *
 * 【レスポンス（JSON）】
 *   画像：{ ok: true, mimeType, result: { kind: "image", rotation, confidence, script, exifOrientation } }
 *   PDF ：{ ok: true, mimeType, result: { kind: "pdf", pageCount, checkedPages, pages: [...], pageRotations } }
 *   rotation が null のページ・画像は、判定できなかったもの（reason・message に理由）。
 *   { ok: true, skipped: "理由コード" } … 判定しなかった（trashed / too-large / unsupported-type / encrypted など）
 *   { ok: false, error: "原因" }       … 失敗（401 合言葉が違う / 400 依頼が不正 / 502 Drive・処理の失敗）
 *
 * 【安全のための決まり】rotate.js と同じ（合言葉の確認・Driveが返した種類で判断・ゴミ箱と大きすぎるファイルは処理しない・
 *   トークンと合言葉はログに出さない）。 */
const { detectOrientation } = require("../lib/osdCore");
const drive = require("../lib/driveClient");
const { isValidSecret, MAX_FILE_BYTES } = require("../lib/apiCommon");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST で呼び出してください。" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!process.env.ROTATE_API_SECRET) return res.status(500).json({ ok: false, error: "サーバーの設定（ROTATE_API_SECRET）がありません。" });
  if (!isValidSecret(body.secret)) return res.status(401).json({ ok: false, error: "認証に失敗しました。" });

  const { driveFileId, accessToken } = body;
  if (typeof driveFileId !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(driveFileId)
      || typeof accessToken !== "string" || accessToken.length < 20 || /\s/.test(accessToken)) {
    return res.status(400).json({ ok: false, error: "依頼の内容が不正です。" });
  }

  try {
    const meta = await drive.getMetadata(accessToken, driveFileId);
    const skip = (reason) => res.status(200).json({ ok: true, skipped: reason });

    if (meta.trashed) return skip("trashed");
    if (Number(meta.size) > MAX_FILE_BYTES) return skip("too-large");

    const original = await drive.download(accessToken, driveFileId);
    const startedAt = Date.now();
    const result = await detectOrientation(original, meta.mimeType);
    if (result.skipped && !result.kind) return skip(result.skipped);

    return res.status(200).json({ ok: true, mimeType: meta.mimeType, elapsedMs: Date.now() - startedAt, result: result });
  } catch (e) {
    // トークンが含まれないよう、メッセージだけを記録する
    console.error(`向き判定に失敗しました（${driveFileId}）: ${e.message}`);
    return res.status(502).json({ ok: false, error: e.message });
  }
};
