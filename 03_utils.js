/**
 * =====================================================================
 * 03_utils.js：共通ヘルパー・共通UI部品
 * =====================================================================
 * 【役割】
 *   ・表示用ヘルパー：HTMLエスケープ、エラーダイアログ、トースト、確認ダイアログ、日付・ID→名前の変換
 *   ・共通UI部品：案件Noの入力欄とチップ、用途種別セレクト、タグチェックボックス
 *   ・一覧系モーダル（マスタ管理・ゴミ箱・削除済み）の、Escキー・外側クリックで閉じる処理
 *
 * 【読み込み順】02_state.js の後。他の機能別ファイル（04〜09）から呼ばれる。
 * 【注意】HTMLへ値を埋め込む時は、必ず escapeHtml を通すこと（XSS対策）。
 */

// =================================================================
// 画面表示用の共通ヘルパー
// =================================================================

/**
 * HTMLに埋め込む文字列をエスケープする。
 * 表示名・ファイル名・取引先・タグ名などは、ユーザー入力やメール添付のファイル名など外部由来の値で、
 * そのまま innerHTML に入れるとスクリプトを仕込まれる（XSS）ため、必ずこの関数を通して埋め込む。
 * （textContent や input.value へ代入する場合は、ブラウザが自動で無害化するため不要）
 */
function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 値があればエスケープして表示し、空なら「－」を表示する（一覧の空欄表示用） */
function textOrDash(value) {
  return value ? escapeHtml(value) : '<span class="file-list-cell-muted">－</span>';
}

/** エラーダイアログを表示する（エラーの表示は、すべてここを通して見た目・文言をそろえる） */
function showErrorDialog(err, title = 'エラー') {
  return Swal.fire({ icon: 'error', title: title, text: err.message, confirmButtonText: 'OK' });
}

/** 「ゴミ箱へ移動しますか？」の確認ダイアログ。移動する場合は true を返す */
async function confirmMoveToTrash(title) {
  const result = await Swal.fire({
    title: title,
    text: '30日以内であれば復元できます。',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    confirmButtonText: '移動する',
    cancelButtonText: 'キャンセル'
  });
  return result.isConfirmed;
}

/** サーバーから最新の一覧を取得し直して、現在の検索条件で画面に表示し直す */
async function reloadAndRender() {
  await refreshRecordsCache();
  search();
}

/**
 * 一覧内のボタン・×アイコンのクリックを、親要素で1回だけ受け取る。
 * ボタン側は onclick="関数('${値}')" と書かず、data-id などのデータ属性で対象を渡す。
 * （onclick の中に値を埋め込むと、値に引用符が含まれた場合に壊れたり、スクリプトを仕込まれたりするため）
 * @param {string} containerId 親要素のid（中身を描画し直しても、このイベントは維持される）
 * @param {function(DOMStringMap): void} handler data-* 属性の一覧（dataset）を受け取る関数
 */
function bindListAction(containerId, handler) {
  document.getElementById(containerId).addEventListener("click", (e) => {
    const target = e.target.closest("[data-id]");
    if (target) handler(target.dataset);
  });
}

// =================================================================
// ID → 表示名 変換ヘルパー（アプリ画面にはIDではなく名前を表示する方針）
// =================================================================
function getUseTypeLabel(useTypeId) {
  if (!useTypeId) return "";
  const found = allUseTypesCache.find(ut => ut.useTypeId === useTypeId);
  return found ? found.useTypeName : useTypeId;
}

function getTagLabels(tagIdString) {
  const ids = String(tagIdString || "").split(",").map(s => s.trim()).filter(Boolean);
  return ids.map(id => {
    const found = allTagsCache.find(t => t.tagId === id);
    return found ? found.tagName : id;
  });
}

/**
 * 日付のみの値（取引日など）を "yyyy-M-d" 形式で表示用に整形する。
 * サーバー側で既に "yyyy-MM-dd" 文字列として整形されている想定だが、
 * 万一 Date オブジェクトや別形式で届いた場合でも崩れずに表示できるよう防御的に処理する。
 * Dateオブジェクトを経由すると環境のタイムゾーンによって日付がずれる恐れがあるため、
 * 文字列がすでに yyyy-MM-dd 形式であればDateを経由せずそのまま数値変換のみ行う。
 */
function formatDateOnly(value) {
  if (!value) return "";
  const str = String(value);
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${Number(isoMatch[2])}-${Number(isoMatch[3])}`;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? str : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** <input type="date"> へ安全に値を設定するため、必ず "yyyy-MM-dd"（ゼロ埋め）形式に揃える */
function toDateInputValue(value) {
  if (!value) return "";
  const str = String(value);
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const d = new Date(str);
  if (isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 日時の値（作成日時など。サーバーからはUTC表記の文字列で届く）を、
 * このブラウザの時間帯（日本時間）での日付 "yyyy-MM-dd" に変換する。
 * toDateInputValue は日付のみの値用のため、日時の値にはこちらを使う（先頭10文字を切り出すとUTCの日付になりずれる）。
 */
function toLocalDateString(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function showToast(message, persistent = false) {
  const options = { toast: true, position: 'top-end', icon: 'info', title: message, showConfirmButton: false };
  if (!persistent) options.timer = 2500; // persistent=trueの場合はtimerを設定せず、明示的にSwal.close()するまで表示し続ける
  Swal.fire(options);
}

// =================================================================
// 案件Noの入力欄（登録モーダル・詳細モーダルで共通）
// =================================================================

/** 入力欄に書かれた案件Noを一覧へ追加し、チップ表示を更新して、入力欄を空にする */
function commitCaseNoInput(inputId, list, renderFn) {
  const input = document.getElementById(inputId);
  const value = input.value.trim();
  if (value && !list.includes(value)) {
    list.push(value);
    renderFn();
  }
  input.value = "";
}

/** 案件Noの入力欄で Enter を押したら一覧へ追加する（フォームの送信は止める） */
function bindCaseNoInput(inputId, list, renderFn) {
  document.getElementById(inputId)?.addEventListener("keydown", (e) => {
    // 日本語入力の変換を確定するEnterでは、追加しない
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    commitCaseNoInput(inputId, list, renderFn);
  });
}

/** 案件Noのチップ（×で削除できる）を描画する */
function renderCaseChips(areaId, list) {
  document.getElementById(areaId).innerHTML = list.map(caseNo => `
    <span class="link-chip">案件No.${escapeHtml(caseNo)} <span class="remove" data-id="${escapeHtml(caseNo)}">×</span></span>
  `).join('');
}

function removeFromList(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}

// =================================================================
// 用途種別セレクト／タグチェックボックスの共通描画処理
// （アップロードモーダル・詳細モーダルの双方から呼び出す。二重管理を避けるため共通化）
// =================================================================
function renderUseTypeSelectInto(selectId, selectedValue, placeholderText) {
  const select = document.getElementById(selectId);
  select.innerHTML = `<option value="">${placeholderText}</option>` +
    allUseTypesCache.map(ut => `<option value="${escapeHtml(ut.useTypeId)}">${escapeHtml(ut.useTypeName)}</option>`).join('');
  select.value = selectedValue || "";
}

function renderTagCheckboxesInto(containerId, selectedTagIds) {
  const area = document.getElementById(containerId);
  area.innerHTML = allTagsCache.length === 0
    ? '<span style="font-size:13px; color:#94a3b8;">タグ未登録です（上部「マスタ管理」から追加できます）</span>'
    : allTagsCache.map(tag => `
        <label style="display:inline-flex; align-items:center; gap:4px; background:#f1f5f9; padding:4px 10px; border-radius:12px; font-size:13px;">
          <input type="checkbox" value="${escapeHtml(tag.tagId)}" ${selectedTagIds.includes(tag.tagId) ? "checked" : ""}> ${escapeHtml(tag.tagName)}
        </label>
      `).join('');
}

function getCheckedTagIdsIn(containerId) {
  return Array.from(document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)).map(el => el.value);
}

// =================================================================
// モーダルを閉じる操作
// =================================================================
// 一覧系のモーダル（マスタ管理・ゴミ箱・削除済み）は、Escキー・外側のクリックでも閉じる。
// 入力フォームのモーダル（新規登録・詳細）は、入力中の内容を誤って失わないよう、✕ボタンでのみ閉じる。
const LIST_MODAL_CLOSERS = {
  tagModal: () => closeTagModal(),
  trashModal: () => closeTrashModal(),
  deletedFilesModal: () => closeDeletedFilesModal()
};

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (window.Swal && Swal.isVisible && Swal.isVisible()) return; // ダイアログ表示中のEscは、ダイアログ側が処理する
  Object.keys(LIST_MODAL_CLOSERS).forEach(id => {
    if (document.getElementById(id).style.display !== "none") LIST_MODAL_CLOSERS[id]();
  });
});

Object.keys(LIST_MODAL_CLOSERS).forEach(id => {
  const overlay = document.getElementById(id);
  // 文字を選択しようとして、モーダルの中で押したマウスを外側で離した場合に閉じてしまわないよう、
  // 「押した位置」も外側だった場合だけ閉じる
  let pressedOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => { pressedOnOverlay = (e.target === overlay); });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && pressedOnOverlay) LIST_MODAL_CLOSERS[id]();
  });
});
