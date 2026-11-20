/**
 * =====================================================================
 * lib/driveClient.js
 * =====================================================================
 * Google Drive API（v3）の呼び出し（回転に必要な分だけ）
 * =====================================================================
 * 呼び出し元（GAS）が渡した一時的なアクセストークンで、Driveのファイルを読み書きする。
 * トークンは、ログ・エラーメッセージに出さない。
 * ファイルを「同じファイルID」のまま上書きするため、DriveのURLは変わらない。
 */
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "DriveError";
    this.status = status;
  }
}

/** Driveの応答が失敗なら、原因が分かる例外にする（応答の本文は、先頭だけ使う） */
async function assertOk(response, action) {
  if (response.ok) return;
  const body = (await response.text().catch(() => "")).slice(0, 300);
  const hint = { 401: "アクセストークンが無効です", 403: "権限がありません", 404: "ファイルが見つかりません" }[response.status] || "";
  throw new DriveError(`Drive API（${action}）が失敗しました: HTTP ${response.status} ${hint} ${body}`.trim(), response.status);
}

/** ファイルの情報を取得する（種類・大きさ・ゴミ箱か・編集できるか・このアプリが付けた目印） */
async function getMetadata(token, fileId) {
  const fields = "id,mimeType,size,trashed,appProperties,capabilities(canEdit)";
  const url = `${DRIVE_API}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  await assertOk(response, "情報の取得");
  return response.json();
}

/** ファイルの中身を取得する */
async function download(token, fileId) {
  const url = `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  await assertOk(response, "ダウンロード");
  return Buffer.from(await response.arrayBuffer());
}

/**
 * ファイルの中身を上書きする（ファイルID・URLは変わらない）。あわせて、このアプリの目印（appProperties）を付ける。
 * 大きいファイルでも送れるよう、再開可能アップロード（開始 → 中身を送信）で行う。
 */
async function replaceContent(token, fileId, bytes, mimeType, appProperties) {
  const startUrl = `${DRIVE_UPLOAD_API}/${encodeURIComponent(fileId)}?uploadType=resumable&supportsAllDrives=true`;
  const start = await fetch(startUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(bytes.length)
    },
    body: JSON.stringify({ appProperties: appProperties })
  });
  await assertOk(start, "アップロードの開始");
  const location = start.headers.get("location");
  if (!location) throw new DriveError("Drive API（アップロードの開始）の応答に、送信先がありません。", 502);

  const upload = await fetch(location, {
    method: "PUT",
    headers: { "Content-Type": mimeType, "Content-Length": String(bytes.length) },
    body: bytes
  });
  await assertOk(upload, "アップロード");
}

module.exports = { getMetadata, download, replaceContent, DriveError };
