/**
 * 画像・PDFの回転API（POST /api/rotate）
 * =====================================================================
 * ファイル管理アプリ（GAS）が、向きの判定（api/detect_orientation）の結果に合わせて、Drive上のファイルを回転して保存するために呼ぶ。
 * GAS には、画像・PDFを回転する機能が無いため、この関数が代わりに行う。
 *
 * 【リクエスト（JSON）】
 *   secret       … 合言葉（Vercelの環境変数 ROTATE_API_SECRET と同じ値）
 *   driveFileId  … 回転するDriveのファイルID
 *   accessToken  … GASが渡す、Driveの一時的なアクセストークン（ScriptApp.getOAuthToken()）
 *   rotation     … 画像：時計回りに回す角度（90 / 180 / 270）
 *   pageRotations … PDF：ページごとの角度（ページ順。0 / 90 / 180 / 270）
 *
 * 【レスポンス（JSON）】
 *   { ok: true,  rotated: true,  bytesBefore, bytesAfter }   … 回転して保存した
 *   { ok: true,  rotated: false, skipped: "理由コード" }       … 回転しなかった（理由は lib/rotateCore.js、または下の already-rotated など）
 *   { ok: false, error: "原因" }                              … 失敗（401 合言葉が違う / 400 依頼が不正 / 502 Drive・処理の失敗）
 *
 * 【安全のための決まり】
 *   ・合言葉が一致しない依頼は、何も処理しない
 *   ・Driveが返した「ファイルの種類」で処理を決める（依頼の内容は信用しない）
 *   ・ゴミ箱のファイル・編集権限が無いファイル・大きすぎるファイル・すでに回転済みのファイルは、回転しない
 *   ・回転して保存したファイルには、目印（appProperties: ocrRotatedAt）を付け、同じファイルを2回回してしまうことを防ぐ
 *   ・アクセストークン・合言葉は、ログに出さない
 */
const { rotateFileBytes } = require("../lib/rotateCore");
const drive = require("../lib/driveClient");
const { isValidSecret, MAX_FILE_BYTES } = require("../lib/apiCommon");

const MAX_PAGES = 300;

/** 依頼の内容を確認し、回転の指定（{rotation} または {pageRotations}）を返す。不正なら null */
function parseRotationRequest(body) {
  const isAngle = (a) => Number.isInteger(a) && [0, 90, 180, 270].includes(a);
  if (Array.isArray(body.pageRotations)) {
    if (body.pageRotations.length === 0 || body.pageRotations.length > MAX_PAGES || !body.pageRotations.every(isAngle)) return null;
    return { pageRotations: body.pageRotations };
  }
  if (isAngle(body.rotation)) return { rotation: body.rotation };
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST で呼び出してください。" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!process.env.ROTATE_API_SECRET) return res.status(500).json({ ok: false, error: "サーバーの設定（ROTATE_API_SECRET）がありません。" });
  if (!isValidSecret(body.secret)) return res.status(401).json({ ok: false, error: "認証に失敗しました。" });

  const { driveFileId, accessToken } = body;
  const rotationRequest = parseRotationRequest(body);
  if (typeof driveFileId !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(driveFileId)
      || typeof accessToken !== "string" || accessToken.length < 20 || /\s/.test(accessToken)
      || !rotationRequest) {
    return res.status(400).json({ ok: false, error: "依頼の内容が不正です。" });
  }

  try {
    const meta = await drive.getMetadata(accessToken, driveFileId);
    const skip = (reason) => res.status(200).json({ ok: true, rotated: false, skipped: reason });

    if (meta.trashed) return skip("trashed");
    if (!meta.capabilities || !meta.capabilities.canEdit) return skip("no-edit-permission");
    if (meta.appProperties && meta.appProperties.ocrRotatedAt) return skip("already-rotated");
    if (Number(meta.size) > MAX_FILE_BYTES) return skip("too-large");

    const original = await drive.download(accessToken, driveFileId);
    const result = await rotateFileBytes(original, meta.mimeType, rotationRequest);
    if (result.skipped) return skip(result.skipped);

    const summary = rotationRequest.rotation !== undefined ? String(rotationRequest.rotation) : rotationRequest.pageRotations.join(",");
    await drive.replaceContent(accessToken, driveFileId, result.bytes, meta.mimeType, {
      ocrRotatedAt: new Date().toISOString(),
      ocrRotation: summary.slice(0, 100)
    });
    return res.status(200).json({ ok: true, rotated: true, bytesBefore: original.length, bytesAfter: result.bytes.length });
  } catch (e) {
    // トークンが含まれないよう、メッセージだけを記録する
    console.error(`回転に失敗しました（${driveFileId}）: ${e.message}`);
    return res.status(502).json({ ok: false, error: e.message });
  }
};
