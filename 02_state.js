/**
 * =====================================================================
 * 02_state.js：ブラウザへの保存と、画面全体で共有する状態
 * =====================================================================
 * 【役割】
 *   ・localStorage の安全な読み書き（storage）
 *   ・サーバーから取得したデータ（一覧・タグ・用途種別）のキャッシュ
 *   ・ログイン中のユーザーの権限、ログイン処理中の一時的な状態
 *   ・登録モーダル／詳細モーダルで編集中の案件No（pendingLinks / detailLinks）
 *
 * 【読み込み順】01_config.js の後。以降のファイルは、ここで宣言した変数を使う。
 * 【注意】画面全体の状態は、できるだけこのファイルに集める（各ファイルで勝手に増やさない）。
 */

// ブラウザの設定（プライベートモード・Cookie制限など）によっては、localStorage へのアクセスが
// ブロックされて SecurityError が発生することがある。その場合でも動くよう、メモリ上の保存で代替する。
function safeLocalStorage() {
  try {
    const testKey = "__fs_storage_test__";
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    return localStorage;
  } catch (e) {
    console.warn("localStorageが利用できません。メモリ上の一時ストレージで代替します:", e.message);
    const memoryStore = {};
    return {
      getItem: (k) => (k in memoryStore ? memoryStore[k] : null),
      setItem: (k, v) => { memoryStore[k] = String(v); },
      removeItem: (k) => { delete memoryStore[k]; }
    };
  }
}

const storage = safeLocalStorage();

// ログイン操作の直後、最初の1回のリクエスト（loadInitialData）にだけ使うID・パスワード。
// 端末には保存せず、メモリ上にだけ置く（成功・失敗のいずれでも、initializeApp が破棄する）。
let pendingLoginCredentials = null;

// サーバーから取得して画面全体で使うデータ（一覧・マスタ）
let allRecordsCache = [];
let allTagsCache = [];
let allUseTypesCache = [];
// ログイン中のユーザーの権限（「管理者」を表す定数 ADMIN_PERMISSION は 01_config.js にある）
let currentPermission = "";
function isAdminUser() { return currentPermission === ADMIN_PERMISSION; }

// ログインの有効期限切れ（AUTH_EXPIRED）への対応用フラグ。
// isAppInitialized … メイン画面を表示済みか（起動時の認証失敗は、initializeApp側のcatchで処理するため区別する）
let isAppInitialized = false;
let isHandlingAuthExpired = false;
// 案件マスタ（紐付け入力欄の選択肢）。ログイン後に画面を表示してから、裏で読み込む（10_project_picker.js）
let projectListCache = [];             // [{no, name, client, contact, __searchText}]
let projectMapByNo = new Map();        // 案件No → 案件（チップに案件名を表示するための索引）
let projectListStatus = "idle";        // idle（未取得）／loading（読込中）／ready（取得済み）／error（失敗）
let projectListErrorMessage = "";      // error のときに部品へ表示するメッセージ

let pendingLinks = []; // 登録モーダル内で追加された紐付け先（案件No）を一時保持
let detailLinks = [];  // 詳細モーダルで編集中の紐付け先（案件No）。「確定保存／更新」で保存される
