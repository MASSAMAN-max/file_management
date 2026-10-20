/**
 * =====================================================================
 * 01_config.js：エラー表示・設定の確認・アプリ全体の定数
 * =====================================================================
 * 【役割】
 *   ・JavaScriptのエラーが起きた時に、画面が真っ白にならないよう、画面上部にエラーを表示する
 *   ・環境依存の設定（config.js の CONFIG.GAS_URL）が読み込まれているかを確認する
 *   ・通信・権限など、アプリ全体で使う定数を置く（値を変えたい時は、このファイルだけを見ればよい）
 *
 * 【config.js との違い】
 *   config.js … デプロイ先ごとに値が変わる設定（GASのURL）。環境ごとに書き換える
 *   01_config.js（このファイル）… どの環境でも共通の、アプリの動作に関する定数
 *
 * 【読み込み順】このファイルを最初に読み込むこと。他のファイルへの依存はない。
 */

// ---------------------------------------------------------------------
// 画面が真っ白になる代わりに、JSエラーが起きた場合は画面上部に表示する（デバッグ用）
// ---------------------------------------------------------------------
window.onerror = function(message, source, lineno, colno, error) {
  var banner = document.getElementById('fatalErrorBanner');
  if (banner) {
    banner.style.display = 'block';
    banner.textContent = 'JSエラーが発生しました: ' + message + ' (' + source + ':' + lineno + ')';
  }
};

// GAS_URLは config.js の CONFIG.GAS_URL を参照する（環境依存パラメータの一元管理）
if (typeof CONFIG === 'undefined' || !CONFIG.GAS_URL) {
  document.getElementById('fatalErrorBanner').style.display = 'block';
  document.getElementById('fatalErrorBanner').textContent =
    'config.js が読み込まれていないか、CONFIG.GAS_URL が未設定です。config.js に、GASのWebアプリのURLを設定してください。';
}

// ログイン中のユーザーの権限。「管理者」の判定はサーバー側（02_権限管理.js の PERMISSION_RULES）と同じ。
// ここでの判定はボタンの表示・非表示のためだけで、実際の許可・拒否は必ずサーバー側で行われる。
const ADMIN_PERMISSION = "管理者";

// 自動で再試行してよいaction（同じリクエストを2回送っても、結果が変わらないもの）。
// 「仮登録」「確定保存」「ゴミ箱へ移動」などは、再送すると二重登録や誤エラーの原因になるため含めない。
// ※ POSTの応答だけが失敗した場合も、サーバー側の処理は実行済みの可能性がある。
const RETRY_SAFE_ACTIONS = new Set([
  // 読み取りのみ
  'loadInitialData', 'loadAllRecords', 'loadProjects', 'loadTagMaster', 'loadUseTypeMaster', 'loadTrashList', 'loadDeletedFiles',
  // 書き込みだが、2回実行しても結果が同じもの
  // （同名タグ・種別は既存を返す／削除済みを再削除しても同じ／同じ内容での上書き）
  'addTag', 'addUseType', 'deleteTag', 'deleteUseType', 'updateRecord'
]);

// 1回の通信を待つ最長時間（ミリ秒）。時間のかかるactionだけ個別に長くする
const DEFAULT_TIMEOUT_MS = 40000;

const ACTION_TIMEOUT_MS = {
  processBackgroundTasks: 200000, // Drive保存＋OCR。GASの実行上限（6分）に収まる範囲で長めに待つ
  createZipDownload: 120000
};
