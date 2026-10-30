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
/**
 * DriveファイルURLから、DriveのファイルIDを取り出す（サーバー側 extractDriveFileId_ と同じ規則）。
 * 例：https://drive.google.com/file/d/〇〇/view?usp=drivesdk → 〇〇
 * @return {string} ファイルID（URLが空・形式が違う場合は空文字）
 */
function extractDriveFileId(url) {
  const match = String(url || "").match(/\/d\/([^\/?#]+)/);
  return match ? match[1] : "";
}

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
// 案件Noの変換（data シートの「案件No」列の文字列 → 配列）。選択部品は 10_project_picker.js
// =================================================================

/**
 * data シートの「案件No」列の値（カンマ区切り。例："12,15"）を、案件Noの配列にする。
 * セルが数値1つだけのときは数値で届くことがあるため、文字列に直してから分ける。空・重複は除く。
 */
function parseCaseNos(value) {
  const list = [];
  String(value === null || value === undefined ? "" : value).split(",").forEach(text => {
    const caseNo = text.trim();
    if (caseNo && !list.includes(caseNo)) list.push(caseNo);
  });
  return list;
}

// =================================================================
// 通貨（登録モーダル・詳細モーダルで共通）
// 通貨コードと小数の桁数は、サーバー側（08_ファイル情報管理.js の CURRENCY_DECIMALS_）と必ずそろえること。
// =================================================================
const DEFAULT_CURRENCY_CODE = "JPY"; // 通貨が空（既存データ・通貨列が無い行）のときは円として扱う
const CURRENCIES = [
  { code: "JPY", symbol: "¥",   name: "円",         decimals: 0 },
  { code: "USD", symbol: "$",   name: "米ドル",     decimals: 2 },
  { code: "EUR", symbol: "€",   name: "ユーロ",     decimals: 2 },
  { code: "GBP", symbol: "£",   name: "英ポンド",   decimals: 2 },
  { code: "CNY", symbol: "CN¥", name: "人民元",     decimals: 2 }, // 円と同じ「¥」で紛らわしいため CN を付ける
  { code: "AUD", symbol: "A$",  name: "豪ドル",     decimals: 2 },
  { code: "KRW", symbol: "₩",   name: "韓国ウォン", decimals: 0 }
];

/** 通貨コード → 通貨の定義。空は円。リストにないコードは、コードをそのまま記号にして表示する（円と取り違えないため） */
function getCurrency(code) {
  const text = String(code === null || code === undefined ? "" : code).trim();
  if (text === "") return CURRENCIES[0];
  return CURRENCIES.find(c => c.code === text) || { code: text, symbol: text, name: text, decimals: 0 };
}

/** 選択リスト・確認画面に出す通貨名（例：「$ 米ドル（USD）」） */
function getCurrencyLabel(currency) {
  return `${currency.symbol} ${currency.name}（${currency.code}）`;
}

// =================================================================
// 税率・金額（税抜／税込）の入力欄（登録モーダル・詳細モーダルで共通）
// 計算規則はサーバー側（08_ファイル情報管理.js の buildAmountFields_）と同じ：
//   ・通貨の最小単位（円なら1円、ドルなら1セント）未満は切り捨て　・不課税は税率0%扱い
//   ・計算は「最小単位の整数」で行う（小数のまま計算すると、誤差で1セントずれることがあるため）
// 最後に入力した金額欄を基準に、もう一方を自動計算する（基準は税率欄の data-base に保持）。
// 金額欄は、どの通貨選択リストを見るかを data-currency-id に持つ（bindTaxInputs が設定する）。
// =================================================================
const TAX_RATE_NON_TAXABLE = "不課税";
const DEFAULT_TAX_RATE = "10"; // 税率の初期値（%）

/** 整数同士の割り算の商（切り捨て） */
function floorDiv(dividend, divisor) {
  return (dividend - (dividend % divisor)) / divisor;
}

/** 全角数字を半角にする（金額欄に全角で入力・貼り付けされても受け付けるため） */
function toHalfWidthDigits(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * 金額欄の文字列から、数字と小数点だけを取り出す（「$ 1,234.50」→「1234.50」、「¥ 12,345」→「12345」）。
 * 全角数字は半角にし、カンマ・空白・通貨記号・「円」は除く。通貨の小数桁数より細かい桁は切り捨てる。
 * @param {string} text 入力欄の文字列
 * @param {number} decimals 通貨の小数桁数（0なら小数点以下は切り捨て）
 * @param {boolean} keepTrailingDot 入力中は true（「12.」まで打った時点で小数点を消さないため）
 */
function toAmountDigits(text, decimals, keepTrailingDot) {
  const half = toHalfWidthDigits(text).replace(/[．。]/g, ".").replace(/[^\d.]/g, "");
  const dotIndex = half.indexOf(".");
  if (dotIndex === -1) return half;
  const intPart = half.slice(0, dotIndex);
  if (decimals === 0) return intPart;
  const fractionPart = half.slice(dotIndex + 1).replace(/\./g, "").slice(0, decimals);
  if (fractionPart === "") return keepTrailingDot ? (intPart || "0") + "." : intPart;
  return (intPart || "0") + "." + fractionPart;
}

/** 金額欄の値を、最小単位（円・セント）の整数にする。空は null */
function parseAmountMinor(text, decimals) {
  const digits = toAmountDigits(text, decimals, false);
  if (digits === "") return null;
  const parts = digits.split(".");
  const fraction = (parts[1] || "").padEnd(decimals, "0");
  return Number(parts[0]) * Math.pow(10, decimals) + Number(fraction);
}

/** 最小単位の整数を、金額（円なら整数、ドルなら 12.34 のような小数）にする */
function minorToAmount(minor, decimals) {
  return minor / Math.pow(10, decimals);
}

/** 金額を「¥ 12,345」「$ 1,234.50」の表示にする（通貨が空なら円） */
function formatAmountText(amount, currencyCode) {
  const currency = getCurrency(currencyCode);
  const number = Number(amount).toLocaleString("ja-JP", {
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals
  });
  return `${currency.symbol} ${number}`;
}

/** この金額欄に対応する通貨を返す（通貨選択リストの現在の値） */
function getInputCurrency(inputEl) {
  const currencyEl = document.getElementById(inputEl.dataset.currencyId || "");
  return getCurrency(currencyEl ? currencyEl.value : "");
}

/** 金額欄に値を入れる（表示は「¥ 12,345」）。空（null・""）なら欄を空にする */
function setAmountInputValue(inputEl, amount) {
  const isEmpty = (amount === null || amount === undefined || amount === "");
  inputEl.value = isEmpty ? "" : formatAmountText(amount, getInputCurrency(inputEl).code);
}

/** 金額欄の値を、サーバーへ送る「数字（と小数点）だけの文字列」にする（空なら ""。記録は数値のみ） */
function getAmountInputValue(inputId) {
  const inputEl = document.getElementById(inputId);
  return toAmountDigits(inputEl.value, getInputCurrency(inputEl).decimals, false);
}

/**
 * 金額欄を「入力中は数字だけ、入力が終わったら ¥ 12,345」の動きにする。
 * 入力中にカンマや記号が入ると、カーソルの位置がずれて打ち間違えやすいため。
 * @param {function} onChange 金額が入力されたときに呼ぶ処理（もう一方の金額の自動計算など）
 */
function bindAmountInput(inputEl, onChange) {
  const sanitize = () => {
    const text = toAmountDigits(inputEl.value, getInputCurrency(inputEl).decimals, true);
    if (inputEl.value !== text) inputEl.value = text; // 変わるときだけ代入する（カーソル位置を保つため）
  };
  inputEl.addEventListener("focus", sanitize);
  inputEl.addEventListener("input", (e) => {
    if (e.isComposing) return; // 日本語入力の変換中は触らない
    sanitize();
    onChange();
  });
  inputEl.addEventListener("compositionend", () => { sanitize(); onChange(); });
  inputEl.addEventListener("blur", () => {
    const decimals = getInputCurrency(inputEl).decimals;
    const minor = parseAmountMinor(inputEl.value, decimals);
    setAmountInputValue(inputEl, minor === null ? null : minorToAmount(minor, decimals));
  });
}

/** 税率欄の値（"不課税" または "1"〜"10"）を、計算用の％の数値にする */
function taxRateToPercent(rateValue) {
  return rateValue === TAX_RATE_NON_TAXABLE ? 0 : Number(rateValue);
}

/** 基準にした金額欄の値から、もう一方の金額欄を計算して入れる */
function recalcTaxAmounts(rateEl, exclEl, inclEl) {
  const percent = taxRateToPercent(rateEl.value);
  const decimals = getInputCurrency(exclEl).decimals;
  if (rateEl.dataset.base === "excl") {
    const excl = parseAmountMinor(exclEl.value, decimals);
    setAmountInputValue(inclEl, excl === null ? null : minorToAmount(floorDiv(excl * (100 + percent), 100), decimals));
  } else {
    const incl = parseAmountMinor(inclEl.value, decimals);
    setAmountInputValue(exclEl, incl === null ? null : minorToAmount(floorDiv(incl * 100, 100 + percent), decimals));
  }
}

/** 通貨に合わせて、スマホの入力キーボードを切り替える（小数がある通貨だけ、小数点が打てるキーボードにする） */
function applyAmountKeyboard(currencyEl, exclEl, inclEl) {
  const mode = getCurrency(currencyEl.value).decimals === 0 ? "numeric" : "decimal";
  exclEl.inputMode = mode;
  inclEl.inputMode = mode;
}

/** 通貨・税率の選択リストを作り、入力・変更時の自動計算を紐付ける（画面の読み込み時に1回だけ呼ぶ） */
function bindTaxInputs(rateId, exclId, inclId, currencyId) {
  const rateEl = document.getElementById(rateId);
  const exclEl = document.getElementById(exclId);
  const inclEl = document.getElementById(inclId);
  const currencyEl = document.getElementById(currencyId);

  currencyEl.innerHTML = CURRENCIES.map(c => `<option value="${c.code}">${escapeHtml(getCurrencyLabel(c))}</option>`).join("");
  currencyEl.value = DEFAULT_CURRENCY_CODE;
  exclEl.dataset.currencyId = currencyId;
  inclEl.dataset.currencyId = currencyId;

  const rates = [TAX_RATE_NON_TAXABLE, "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  rateEl.innerHTML = rates.map(r => `<option value="${r}">${r === TAX_RATE_NON_TAXABLE ? r : r + "%"}</option>`).join("");
  rateEl.value = DEFAULT_TAX_RATE;
  rateEl.dataset.base = "incl";

  bindAmountInput(exclEl, () => { rateEl.dataset.base = "excl"; recalcTaxAmounts(rateEl, exclEl, inclEl); });
  bindAmountInput(inclEl, () => { rateEl.dataset.base = "incl"; recalcTaxAmounts(rateEl, exclEl, inclEl); });
  rateEl.addEventListener("change", () => recalcTaxAmounts(rateEl, exclEl, inclEl));

  // 通貨を変えたら、入力済みの金額を新しい通貨の桁数に合わせて表示し直し、もう一方の金額も計算し直す
  // （例：ドル→円に変えると、小数部分は切り捨てられる）
  currencyEl.addEventListener("change", () => {
    applyAmountKeyboard(currencyEl, exclEl, inclEl);
    const decimals = getCurrency(currencyEl.value).decimals;
    [exclEl, inclEl].forEach(el => {
      const minor = parseAmountMinor(el.value, decimals);
      setAmountInputValue(el, minor === null ? null : minorToAmount(minor, decimals));
    });
    recalcTaxAmounts(rateEl, exclEl, inclEl);
  });
}

/**
 * モーダルを開くときに、通貨・税率・金額の入力欄へ保存済みの値を入れる（再計算はしない）。
 * 通貨が空・リストにない値のときは円、税率が空・リストにない値のときは10%にする。基準の金額欄は税込に戻す。
 * ※ 金額の表示形式は通貨で決まるため、先に通貨を入れてから金額を入れる。
 */
function setTaxInputValues(rateId, exclId, inclId, currencyId, currency, taxRate, amountExcl, amountIncl) {
  const currencyEl = document.getElementById(currencyId);
  const currencyText = String(currency === null || currency === undefined ? "" : currency).trim();
  currencyEl.value = currencyText;
  if (currencyEl.value !== currencyText || currencyText === "") currencyEl.value = DEFAULT_CURRENCY_CODE; // リストにない値は選択できないため
  const exclEl = document.getElementById(exclId);
  const inclEl = document.getElementById(inclId);
  applyAmountKeyboard(currencyEl, exclEl, inclEl);

  const rateEl = document.getElementById(rateId);
  const rateText = String(taxRate === null || taxRate === undefined ? "" : taxRate).trim();
  rateEl.value = rateText;
  if (rateEl.value !== rateText || rateText === "") rateEl.value = DEFAULT_TAX_RATE; // リストにない値は選択できないため
  rateEl.dataset.base = "incl";
  setAmountInputValue(exclEl, amountExcl);
  setAmountInputValue(inclEl, amountIncl);
}

// =================================================================
// 日付入力欄：カレンダーのマークだけでなく、欄のどこをタップしてもカレンダーを開く
// （画面上のすべての日付欄に効く。新しい日付欄を足しても個別の設定は不要）
// =================================================================
document.addEventListener("click", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.type !== "date" || el.disabled || el.readOnly) return;
  try {
    el.showPicker();
  } catch (err) {
    // showPicker に対応していないブラウザや、すでにカレンダーが開いている場合は何もしない
  }
});

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

/**
 * タグ選択部品（登録モーダル・詳細モーダルで共通）。
 * 【画面】「タグ」のタブ（初期状態は閉じている。押すと開閉する）
 *           ├ タブの外：選択済みのタグ（常に表示）
 *           └ タブの中：タグごとのトグルボタン（押すごとに選択／解除。複数選択可）
 * 【仕組み】トグルボタンの実体は、見えないチェックボックス（<label>の中の <input type="checkbox">）。
 *   そのため、保存時の取得（getCheckedTagIdsIn）や、詳細モーダルの変更検知（フォームの change イベント）は、
 *   以前のチェックボックスのときと同じ仕組みでそのまま動く。
 * 【注意】タブの開閉と選択済み表示の更新は、この関数の下にあるイベント（document への1回だけの登録）が行う。
 */
function renderTagCheckboxesInto(containerId, selectedTagIds) {
  const area = document.getElementById(containerId);
  if (allTagsCache.length === 0) {
    area.innerHTML = '<span style="font-size:13px; color:#94a3b8;">タグ未登録です（上部「マスタ管理」から追加できます）</span>';
    return;
  }
  area.innerHTML = `
    <div class="tag-picker">
      <button type="button" class="project-picker-toggle tag-picker-toggle" aria-expanded="false">
        <span>タグ（複数選択可）</span>
        <span class="material-symbols-outlined project-picker-toggle-icon">expand_more</span>
      </button>
      <div class="tag-picker-selected"></div>
      <div class="tag-picker-body">
        ${allTagsCache.map(tag => `
          <label class="tag-toggle">
            <input type="checkbox" value="${escapeHtml(tag.tagId)}" ${selectedTagIds.includes(tag.tagId) ? "checked" : ""}>
            <span class="tag-toggle-text">${escapeHtml(tag.tagName)}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `;
  updateTagPickerSelected(area.querySelector(".tag-picker"));
}

/** タブの外に表示する「選択済みのタグ」を、現在のトグルの状態に合わせて作り直す */
function updateTagPickerSelected(picker) {
  const names = Array.from(picker.querySelectorAll(".tag-toggle input:checked"))
    .map(input => input.nextElementSibling.textContent);
  picker.querySelector(".tag-picker-selected").innerHTML =
    names.map(name => `<span class="tag-selected-chip">${escapeHtml(name)}</span>`).join("");
}

// タグ選択部品の操作。描画のたびに中身が作り直されるため、各ボタンではなく document で1回だけ受け取る
document.addEventListener("click", (e) => {
  const toggleButton = e.target.closest(".tag-picker-toggle");
  if (!toggleButton) return;
  const picker = toggleButton.closest(".tag-picker");
  const willOpen = !picker.classList.contains("is-open");
  picker.classList.toggle("is-open", willOpen);
  toggleButton.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("change", (e) => {
  if (!e.target.matches(".tag-toggle input")) return;
  updateTagPickerSelected(e.target.closest(".tag-picker"));
});

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

// =================================================================
// 音声入力（「説明・備考」欄のマイクボタン）
// 他アプリの実装を参考にした。ブラウザの音声認識（Web Speech API）を使うため、Chrome・Edge・Safari で使える。
// 使い方：<div class="voice-input-wrapper"><textarea></textarea><button onclick="startVoiceInput(this)">…</button></div>
// =================================================================
function startVoiceInput(button) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    Swal.fire({
      icon: 'warning',
      title: '非対応',
      text: 'お使いのブラウザは音声入力に対応していません。',
      confirmButtonText: '了解'
    });
    return;
  }

  // 備考欄は <textarea> のため、input だけでなく textarea も検索対象にする
  const input = button.closest('.voice-input-wrapper').querySelector('input, textarea');
  const recognition = new SpeechRecognition();
  recognition.lang = 'ja-JP';
  recognition.continuous = false;
  recognition.interimResults = true;

  // 聴取中であることが分かるよう、入力欄の色を変える
  input.style.backgroundColor = '#FFF3E0';
  input.style.borderColor = '#FF9800';

  // 音声認識が「実際に始まってから」ボタンを無効化する（許可ダイアログで止まった場合に、押せなくならないため）
  recognition.onstart = () => {
    button.classList.add('recording');
    button.innerHTML = '<span class="material-symbols-outlined" style="animation: blink 1s infinite;">mic</span> 聴取中...';
    button.disabled = true;
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
    if (transcript) {
      input.value = (input.value + transcript).trim();
      // 入力欄の変更を、フォームへ知らせる（詳細モーダルの「変更の有無」の検知に必要）
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error); // 原因調査用
    button.classList.remove('recording');
    input.style.backgroundColor = '';
    input.style.borderColor = '';
    Swal.fire({
      icon: 'error',
      title: '音声認識失敗',
      text: 'もう一度お試しください。',
      confirmButtonText: '了解'
    });
  };

  recognition.onend = () => {
    button.classList.remove('recording');
    button.innerHTML = '<span class="material-symbols-outlined">mic</span>';
    button.disabled = false;
    input.style.backgroundColor = '';
    input.style.borderColor = '';
  };

  recognition.start();
}
