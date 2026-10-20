/**
 * =====================================================================
 * 04_api_auth.js：GASとの通信・認証・起動処理
 * =====================================================================
 * 【役割】
 *   ・apiCall：GASへのAPI呼び出し（再試行・タイムアウト・エラー処理）
 *   ・ログイン／ログアウト、ログインの有効期限切れへの対応
 *   ・アプリ起動時の初期データの読み込み（initializeApp）と、一覧の再取得（refreshRecordsCache）
 *
 * 【読み込み順】03_utils.js の後。
 * 【依存】01_config.js（通信の定数）、02_state.js（キャッシュ・ログイン状態）、03_utils.js（ダイアログなど）
 */

/**
 * =====================================================================
 * 認証の方式（トークン認証）
 * =====================================================================
 *   ・パスワードを端末（localStorage）に保存しない。ログイン直後の最初のリクエストにだけ使い、
 *     メモリ上から破棄する。以後の通信は、サーバーが発行したログイントークン（fs_login_token）だけで行う。
 *   ・以前のバージョンが端末に保存していた ID・パスワード（fs_login_id / fs_login_password）は、
 *     起動時に必ず削除する。
 *   ・ログインの有効期限切れ（AUTH_EXPIRED）は、再試行せず、再ログインへ誘導する。
 *   ・ログアウト時は、サーバー側のトークンも失効させる。
 */

// =====================================================================
// 通信（apiCall）とログイン状態
// =====================================================================

/** 端末に保存しているログイン関連の情報を全て削除する（旧バージョンのID・パスワードも含む） */
function clearLoginStorage() {
  ['fs_login_token', 'fs_login_userName', 'fs_login_permission', 'fs_login_id', 'fs_login_password']
    .forEach(key => storage.removeItem(key));
}

/**
 * 利用中にログインの有効期限が切れた・無効化された場合の処理。
 * 保存済みのトークンを破棄し（次に開いた時にログイン画面になる）、案内を出してOKで再読み込みする。
 * ※ 呼び出し元（保存処理など）も続けて自分のエラー表示を出すことがあるが、SweetAlert2は同時に1つしか
 *   表示できないため、後から出た同じ趣旨の表示に置き換わるだけで、重なることはない。
 */
async function handleAuthExpired(message) {
  if (!isAppInitialized || isHandlingAuthExpired) return;
  isHandlingAuthExpired = true;
  clearLoginStorage();
  const result = await Swal.fire({
    icon: 'info',
    title: '再ログインが必要です',
    text: message || 'ログインの有効期限が切れました。再度ログインしてください。',
    confirmButtonText: 'OK'
  });
  if (result.isConfirmed) window.location.reload();
}

/**
 * 通信エラー（サーバーから正常な応答が得られなかった場合）のメッセージを作る。
 * 再試行できないactionでは、サーバー側で処理が実行済みの可能性があることを伝える。
 */
function buildCommunicationErrorMessage(action, baseMessage) {
  if (RETRY_SAFE_ACTIONS.has(action) || action === 'logout') return baseMessage;
  return `${baseMessage}\n処理はサーバー側で実行されている可能性があります。一覧を更新して結果を確認してから、必要であれば再度お試しください。`;
}

/**
 * GASへのAPI呼び出し。
 * @param {string} action 実行するaction名
 * @param {Object} payload 送信するデータ
 * @param {{retry?: number, timeoutMs?: number}} options 省略時は action に応じた既定値（下記）を使う
 *
 * 【再試行について】
 * 外部ドメイン(Vercel)からのfetchは、GAS側の一時的な負荷やデプロイ直後の伝播遅延等により
 * 稀に失敗することがあるため、RETRY_SAFE_ACTIONS に含まれるactionだけは、待機時間を段階的に
 * 伸ばしながら自動で再試行する（指数バックオフ：800ms → 1600ms）。
 * それ以外（登録・確定・ゴミ箱移動など）は再試行しない。
 * 以前は全actionを再試行していたため、通信が遅いだけで同じ処理が複数回実行され、
 * Driveへの二重保存や仮登録の重複、「確定済みのみ…」といった誤エラーを起こしていた。
 * また、サーバーが「エラー」と判断して返した応答は、再送しても結果が変わらないため再試行しない。
 *
 * 【認証について】
 * ・ログイントークン（fs_login_token）があれば、トークンだけを送る。
 * ・トークンが無く、ログイン直後のID・パスワード（pendingLoginCredentials）がある場合だけ、それを送る。
 *
 * 【タイムアウトについて】
 * 通信が詰まった場合、fetchは何の応答もないまま長時間待ち続けることがあり、その間
 * 呼び出し元のボタンが無効化されたまま戻らなくなる恐れがある。
 * AbortControllerで1回の試行ごとにタイムアウトさせ、必ずcatchに落として
 * リトライ処理（または呼び出し元のエラー処理）へ進めるようにする。
 *
 * 【isRedirectFallback対策について】
 * POSTへの応答がGoogle側の303リダイレクトによりGETへ自動変換され、doGet（疎通確認用の
 * 固定応答）に届いてしまうことがある。この場合HTTPステータスは200で返るためエラーとは
 * 判定できないが、中身が本来欲しかったaction（login等）の結果ではないため、
 * doGet側で付与している isRedirectFallback フラグを見て、意図しない応答と判断する。
 */
async function apiCall(action, payload = {}, options = {}) {
  const maxRetry = options.retry !== undefined ? options.retry : (RETRY_SAFE_ACTIONS.has(action) ? 2 : 0);
  const timeoutMs = options.timeoutMs || ACTION_TIMEOUT_MS[action] || DEFAULT_TIMEOUT_MS;

  const token = payload.token || storage.getItem('fs_login_token');
  if (token) {
    payload.token = token;
  } else if (pendingLoginCredentials) {
    payload.loginId = pendingLoginCredentials.loginId;
    payload.password = pendingLoginCredentials.password;
  }

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(CONFIG.GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ action: action, payload: payload }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTPエラー! ステータス: ${response.status}`);

      const resData = await response.json();

      // POST→GET変換によりdoGetの固定応答を受け取ってしまった場合、
      // HTTPステータスは200で「一見成功」に見えるため、ここで明示的にエラー扱いにする
      if (resData.isRedirectFallback) {
        throw new Error("REDIRECT_FALLBACK:リクエストがリダイレクトにより正しく処理されませんでした。");
      }

      if (resData.status === "error") {
        // サーバーが処理した上で返したエラー。認証エラーの種類（code）は、呼び出し側で判別できるよう保持する
        const serverError = new Error(resData.message);
        serverError.code = resData.code || "";
        serverError.isServerError = true;
        throw serverError;
      }
      return resData.data;
    } catch (err) {
      // サーバーが返したエラー：再送しても結果は変わらないため、再試行せずそのまま呼び出し元へ伝える
      if (err.isServerError) {
        if (err.code === "AUTH_EXPIRED") handleAuthExpired(err.message);
        throw err;
      }

      // ここからは通信エラー（タイムアウト・HTTPエラー・リダイレクト失敗など）
      const isTimeout = err.name === "AbortError";
      const errMessage = isTimeout ? "タイムアウト:応答がありませんでした。" : err.message;

      if (attempt < maxRetry) {
        const waitMs = 800 * Math.pow(2, attempt);
        console.warn(`API呼び出し失敗。${waitMs}ms後に再試行します（action: ${action}, ${attempt + 1}回目）: ${errMessage}`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      throw new Error(buildCommunicationErrorMessage(action, errMessage));
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// =====================================================================
// 起動処理
// =====================================================================

document.addEventListener("DOMContentLoaded", async () => {
  try {
    // 旧バージョンは、ID・パスワードを端末に保存していた。残っている場合は、必ず削除する
    // （平文のパスワードを端末に残さないため）。削除した場合は、再ログインをお願いする。
    const hadLegacyCredentials = !!(storage.getItem('fs_login_id') || storage.getItem('fs_login_password'));
    storage.removeItem('fs_login_id');
    storage.removeItem('fs_login_password');

    if (storage.getItem('fs_login_token')) {
      await initializeApp();
    } else {
      document.getElementById("loginScreen").style.display = "flex";
      if (hadLegacyCredentials) {
        Swal.fire({
          icon: 'info',
          title: '再ログインをお願いします',
          text: 'セキュリティ強化のため、お手数ですが、もう一度ログインしてください。',
          confirmButtonText: '了解'
        });
      }
    }
  } catch (e) {
    // ここで捕捉しないと画面が真っ白のまま何も表示されなくなるため、必ずログイン画面は出す
    console.error("初期化エラー:", e);
    document.getElementById("loginScreen").style.display = "flex";
    const banner = document.getElementById('fatalErrorBanner');
    if (banner) {
      banner.style.display = 'block';
      banner.textContent = '初期化エラー: ' + e.message;
    }
  }
});

// =====================================================================
// ログイン
// =====================================================================

async function handleLoginSubmit(e) {
  e.preventDefault();
  const id = document.getElementById("loginIdInput").value.trim();
  const pw = document.getElementById("loginPasswordInput").value.trim();
  if (!id || !pw) return Swal.fire({ icon: 'warning', title: 'IDとパスワードを入力してください。' });

  // ID・パスワードは端末に保存しない。最初のリクエスト（loadInitialData）に付けるため、
  // メモリ上にだけ一時的に保持する（成功・失敗のいずれでも、initializeApp が破棄する）。
  pendingLoginCredentials = { loginId: id, password: pw };
  document.getElementById("loginScreen").style.display = "none";
  await initializeApp();
}

// =====================================================================
// 初期データの読み込み
// =====================================================================

async function initializeApp() {
  const loader = document.getElementById("initLoader");
  loader.style.display = "flex";
  document.getElementById("loaderText").textContent = "ログイン認証中 & データを読み込み中...";

  try {
    // ログイン・ファイル一覧・タグ／用途種別マスタを1回のリクエストでまとめて取得する。
    // 以前は4回（login→loadAllRecords→loadTagMaster→loadUseTypeMaster）に分けていたが、
    // リクエスト回数が多いほどGAS特有の303リダイレクト経由の404が起きやすかったため統合した。
    const initialData = await apiCall("loadInitialData");

    // ログイン直後であれば、サーバーが新しいログイントークンを返す。これを保存し、
    // ID・パスワードのメモリ上の保持は直ちに破棄する（以後の通信はトークンだけで行う）。
    if (initialData.token) storage.setItem('fs_login_token', initialData.token);
    pendingLoginCredentials = null;

    currentPermission = initialData.permission || "";
    document.getElementById("userDisplayLabel").textContent = initialData.loginUser;
    document.getElementById("deletedFilesBtn").style.display = isAdminUser() ? "flex" : "none";

    allRecordsCache = initialData.records || [];
    allTagsCache = initialData.tags || [];
    allUseTypesCache = initialData.useTypes || [];

    initFilterSelect("filterUseType", allRecordsCache, "用途種別ID", getUseTypeLabel);
    initTagFilterSelect();

    loader.style.display = "none";
    document.getElementById("mainApp").style.display = "block";
    isAppInitialized = true; // 以後の認証エラーは、handleAuthExpired で処理する
    search(); // 初期表示（絞り込みなしで全件表示）

    // 案件マスタ（紐付け入力欄の選択肢）は、画面を表示した後に裏で読み込む（待たずに操作できる）
    loadProjectsInBackground();

  } catch (err) {
    loader.style.display = "none";
    pendingLoginCredentials = null;
    const isExpired = err.code === 'AUTH_EXPIRED';
    await Swal.fire({
      title: isExpired ? '再ログインが必要です' : 'ログインに失敗しました。',
      text: err.message,
      icon: isExpired ? 'info' : 'error',
      confirmButtonColor: '#ef4444',
      confirmButtonText: 'OK'
    });
    clearLoginStorage();
    window.location.reload();
  }
}

/**
 * 一覧だけを、サーバーから再取得する。
 * タグ・用途種別マスタは、変更した画面（マスタ管理）が自分で読み直すため、ここでは取得しない。
 * 以前はマスタも毎回取得しており、操作のたびにマスタ用のスプレッドシートを開く無駄な時間がかかっていた。
 */
async function refreshRecordsCache() {
  const data = await apiCall("loadAllRecords");
  allRecordsCache = data.records || [];
  initFilterSelect("filterUseType", allRecordsCache, "用途種別ID", getUseTypeLabel);
  initTagFilterSelect();
}

// =====================================================================
// ログアウト
// =====================================================================

window.handleLogout = async function() {
  const result = await Swal.fire({
    title: 'ログアウトしますか？',
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#ef4444',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'ログアウト',
    cancelButtonText: 'キャンセル'
  });
  if (result.isConfirmed) {
    // サーバー側のトークンも失効させる（端末から消すだけでは、漏れたトークンが使えてしまうため）。
    // 直後にページを再読み込みして通信が打ち切られるため、完了を待つ。ただし長く待たせないよう最大3秒まで。
    // 失敗・時間切れでも、ログアウト自体は続行する（トークンは、期限が来れば無効になる）。
    const tokenToRevoke = storage.getItem('fs_login_token');
    if (tokenToRevoke) {
      try {
        await Promise.race([
          apiCall("logout", { token: tokenToRevoke }),
          new Promise(resolve => setTimeout(resolve, 3000))
        ]);
      } catch (revokeErr) {
        console.error("サーバー側のトークン失効に失敗しました:", revokeErr);
      }
    }
    clearLoginStorage();
    window.location.reload();
  }
};
