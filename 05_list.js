/**
 * =====================================================================
 * 05_list.js：一覧表示・検索・一括操作
 * =====================================================================
 * 【役割】
 *   ・ファイル一覧の絞り込み（キーワード・案件No・種別・タグ・日付など）と表示
 *   ・検索条件のドロップダウンの生成
 *   ・新しい順（作成日時の降順）への並び替えと、50件ずつのページ切り替え
 *   ・チェックした複数ファイルの一括操作（ZIPダウンロード・ゴミ箱へ移動）
 *
 * 【読み込み順】04_api_auth.js の後。
 * 【依存】02_state.js（キャッシュ）、03_utils.js（escapeHtml・日付変換など）、04_api_auth.js（apiCall）
 */

// フィルタ用ドロップダウンを、取得済みレコードの値から重複なく生成する。
// 画面にはID(fieldName)ではなく名前を表示する方針のため、labelFnで表示名に変換する。
function initFilterSelect(elementId, records, fieldName, labelFn) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const previousValue = el.value; // 選択肢を作り直しても、選択中の絞り込み条件を保つ
  const values = [...new Set(records.map(r => r[fieldName]).filter(v => v))].sort();
  el.innerHTML = '<option value="">すべて</option>' +
    values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(labelFn ? labelFn(v) : v)}</option>`).join('');
  if ([...el.options].some(option => option.value === previousValue)) el.value = previousValue;
}

// タグ絞り込みは「タグID一覧」がカンマ区切りの複数値のため、initFilterSelectでは扱えない。
// マスタ（allTagsCache）からそのまま選択肢を生成する。
function initTagFilterSelect() {
  const el = document.getElementById("filterTag");
  if (!el) return;
  const previousValue = el.value;
  el.innerHTML = '<option value="">すべて</option>' +
    allTagsCache.map(t => `<option value="${escapeHtml(t.tagId)}">${escapeHtml(t.tagName)}</option>`).join('');
  if ([...el.options].some(option => option.value === previousValue)) el.value = previousValue;
}

// ===== 検索用テキスト正規化（案件管理アプリと同一ロジック） =====
const KANA_TO_HANKAKU_MAP = {
  'ガ':'ｶﾞ','ギ':'ｷﾞ','グ':'ｸﾞ','ゲ':'ｹﾞ','ゴ':'ｺﾞ','ザ':'ｻﾞ','ジ':'ｼﾞ','ズ':'ｽﾞ','ゼ':'ｾﾞ','ゾ':'ｿﾞ',
  'ダ':'ﾀﾞ','ヂ':'ﾁﾞ','ヅ':'ﾂﾞ','デ':'ﾃﾞ','ド':'ﾄﾞ','バ':'ﾊﾞ','ビ':'ﾋﾞ','ブ':'ﾌﾞ','ベ':'ﾍﾞ','ボ':'ﾎﾞ',
  'パ':'ﾊﾟ','ピ':'ﾋﾟ','プ':'ﾌﾟ','ペ':'ﾍﾟ','ポ':'ﾎﾟ','ヴ':'ｳﾞ',
  'ア':'ｱ','イ':'ｲ','ウ':'ｳ','エ':'ｴ','オ':'ｵ','カ':'ｶ','キ':'ｷ','ク':'ｸ','ケ':'ｹ','コ':'ｺ',
  'サ':'ｻ','シ':'ｼ','ス':'ｽ','セ':'ｾ','ソ':'ｿ','タ':'ﾀ','チ':'ﾁ','ツ':'ﾂ','テ':'ﾃ','ト':'ﾄ',
  'ナ':'ﾅ','ニ':'ﾆ','ヌ':'ﾇ','ネ':'ﾈ','ノ':'ﾉ','ハ':'ﾊ','ヒ':'ﾋ','フ':'ﾌ','ヘ':'ﾍ','ホ':'ﾎ',
  'マ':'ﾏ','ミ':'ﾐ','ム':'ﾑ','メ':'ﾒ','モ':'ﾓ','ヤ':'ﾔ','ユ':'ﾕ','ヨ':'ﾖ',
  'ラ':'ﾗ','リ':'ﾘ','ル':'ﾙ','レ':'ﾚ','ロ':'ﾛ','ワ':'ﾜ','ヲ':'ｦ','ン':'ﾝ',
  'ァ':'ｧ','ィ':'ｨ','ゥ':'ｩ','ェ':'ｪ','ォ':'ｫ','ッ':'ｯ','ャ':'ｬ','ュ':'ｭ','ョ':'ｮ','ー':'ｰ'
};

const KANA_TO_HANKAKU_REGEX = new RegExp(Object.keys(KANA_TO_HANKAKU_MAP).join('|'), 'g');

function normalizeText(t) {
  if (!t) return "";
  let text = String(t).replace(KANA_TO_HANKAKU_REGEX, m => KANA_TO_HANKAKU_MAP[m]);
  text = text.replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
  return text.trim().toLowerCase();
}

/**
 * キーワード検索の対象テキスト（表示名・ファイル名・OCR全文を、正規化して連結したもの）。
 * 正規化（全角→半角など）はOCR全文が長いほど重いため、レコードごとに1回だけ作って使い回す。
 * （一覧を再取得するとレコード自体が新しくなるため、古い内容が残ることはない）
 */
function getSearchText(record) {
  if (record.__searchText === undefined) {
    record.__searchText = normalizeText(String(record["表示名"] || "") + String(record["ファイル名"] || "") + String(record["OCRテキスト（全文）"] || ""));
  }
  return record.__searchText;
}

// 一覧に1ページで表示する件数
const LIST_PAGE_SIZE = 50;

/** 並び替え用の作成日時（ミリ秒）。解釈できない値は0（＝最も古い扱い）。レコードごとに1回だけ求めて使い回す */
function getCreatedTime(record) {
  if (record.__createdTime === undefined) {
    const time = new Date(record["作成日時"]).getTime();
    record.__createdTime = isNaN(time) ? 0 : time;
  }
  return record.__createdTime;
}

/** 作成日時の新しい順（降順）に並べた、新しい配列を返す。作成日時が同じ場合はファイルIDの大きい順 */
function sortRecordsNewestFirst(records) {
  return [...records].sort((a, b) =>
    getCreatedTime(b) - getCreatedTime(a) ||
    String(b["ファイルID"]).localeCompare(String(a["ファイルID"]), "ja", { numeric: true }));
}

function filterRecordsClientSide(records, filters) {
  const { caseNo, keyword, useType, tag, issuedOrReceived, client, uploader,
          transactionStart, transactionEnd, createdStart, createdEnd } = filters;
  const nKeyword = normalizeText(keyword);
  const nClient = normalizeText(client);
  const nUploader = normalizeText(uploader);
  const targetCaseNo = caseNo ? String(caseNo).trim() : ""; // 案件Noの絞り込み（レコードの「案件No」のどれかと完全一致）

  // 日付範囲は未指定（空欄）であれば全期間を対象とする（デフォルト全期間）。
  // 日付はすべて「日本時間の日付（yyyy-MM-dd）」の文字列に揃えて比較する。
  // （new Date("2026-10-18") は UTC の0時＝日本時間9時と解釈されるため、当日の0〜9時が範囲外になってしまう）

  return records.filter(r => {
    // 一覧画面にはゴミ箱・削除済みは表示しない（それぞれ専用画面で扱う。設計書3-7）
    const status = r["レコードステータス"];
    if (status === "ゴミ箱" || status === "削除済み") return false;

    if (targetCaseNo && !parseCaseNos(r["案件No"]).includes(targetCaseNo)) return false;
    if (useType && r["用途種別ID"] !== useType) return false;
    if (issuedOrReceived && r["発行受領区分"] !== issuedOrReceived) return false;

    if (tag) {
      const tagIds = String(r["タグID一覧"] || "").split(",").map(s => s.trim());
      if (!tagIds.includes(tag)) return false;
    }
    if (nClient && !normalizeText(r["取引先"]).includes(nClient)) return false;
    if (nUploader && !normalizeText(r["アップロード者"]).includes(nUploader)) return false;

    if (transactionStart || transactionEnd) {
      const tDate = toDateInputValue(r["取引日"]);
      if (!tDate) return false;
      if (transactionStart && tDate < transactionStart) return false;
      if (transactionEnd && tDate > transactionEnd) return false;
    }
    if (createdStart || createdEnd) {
      const cDate = toLocalDateString(r["作成日時"]);
      if (!cDate) return false;
      if (createdStart && cDate < createdStart) return false;
      if (createdEnd && cDate > createdEnd) return false;
    }

    if (nKeyword) {
      if (!getSearchText(r).includes(nKeyword)) return false;
    }
    return true;
  });
}

// 現在の検索条件で一覧を表示し直す。現在のページは保つ。
// （再読込やゴミ箱移動のあとに、見ていたページが1ページ目に戻らないようにするため。
//   ページ数が減って今のページが無くなった場合は、displayResults が最後のページに直す）
window.search = function() {
  const filters = {
    caseNo: document.getElementById("filterCaseNo").value.trim(),
    keyword: document.getElementById("searchValue").value,
    useType: document.getElementById("filterUseType").value,
    tag: document.getElementById("filterTag").value,
    issuedOrReceived: document.getElementById("filterIssuedOrReceived").value,
    client: document.getElementById("filterClient").value,
    uploader: document.getElementById("filterUploader").value,
    transactionStart: document.getElementById("filterTransactionStartDate").value,
    transactionEnd: document.getElementById("filterTransactionEndDate").value,
    createdStart: document.getElementById("filterCreatedStartDate").value,
    createdEnd: document.getElementById("filterCreatedEndDate").value
  };
  displayResults(sortRecordsNewestFirst(filterRecordsClientSide(allRecordsCache, filters)));
};

// 新しい検索条件で探し直す（検索ボタン・Enterキー・クリア）。1ページ目から表示する
window.startNewSearch = function() {
  currentListPage = 1;
  search();
};

window.clearSearchFilters = function() {
  ["filterCaseNo", "searchValue", "filterClient", "filterUploader"].forEach(id => {
    document.getElementById(id).value = "";
  });
  ["filterUseType", "filterTag", "filterIssuedOrReceived"].forEach(id => {
    document.getElementById(id).value = "";
  });
  ["filterTransactionStartDate", "filterTransactionEndDate", "filterCreatedStartDate", "filterCreatedEndDate"].forEach(id => {
    document.getElementById(id).value = "";
  });
  startNewSearch();
};

document.getElementById("searchValue")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startNewSearch();
});

// 一覧の上下にあるページ切り替え（＜ 1 / 5 ＞）を描画する。1ページしかない場合は何も表示しない
function renderListPager(totalPages) {
  const html = totalPages <= 1 ? "" : `
    <button type="button" class="list-pager-btn" onclick="changeListPage(-1)" ${currentListPage <= 1 ? "disabled" : ""} aria-label="前のページ">＜</button>
    <span class="list-pager-label">${currentListPage} / ${totalPages}</span>
    <button type="button" class="list-pager-btn" onclick="changeListPage(1)" ${currentListPage >= totalPages ? "disabled" : ""} aria-label="次のページ">＞</button>
  `;
  document.querySelectorAll(".list-pager").forEach(el => { el.innerHTML = html; });
}

// ページを前後に切り替える（delta：-1で前へ、1で次へ）。切り替えたら一覧の先頭から見せる
window.changeListPage = function(delta) {
  currentListPage += delta;
  search();
  document.querySelector(".file-list-wrapper").scrollTop = 0;
};

// 並び替え済みのレコードのうち、現在のページ分（LIST_PAGE_SIZE件）だけを描画する。
// チェックボックスも表示中のページの分だけなので、ZIPダウンロード・ゴミ箱移動は表示中のページ内が対象になる
function displayResults(records) {
  const container = document.getElementById("results");
  const countDiv = document.getElementById("searchCount");
  container.innerHTML = "";

  if (!records || records.length === 0) {
    countDiv.innerHTML = "条件に一致するファイルは見つかりませんでした。";
    currentListPage = 1;
    renderListPager(0);
    return;
  }

  const totalPages = Math.ceil(records.length / LIST_PAGE_SIZE);
  currentListPage = Math.min(Math.max(currentListPage, 1), totalPages); // 範囲外（削除でページが減った場合など）は直す
  const startIndex = (currentListPage - 1) * LIST_PAGE_SIZE;
  const pageRecords = records.slice(startIndex, startIndex + LIST_PAGE_SIZE);

  const totalText = `<span style="color:var(--primary); font-size:18px;">${records.length}</span>`;
  countDiv.innerHTML = totalPages <= 1
    ? `${totalText} 件のファイルを表示中`
    : `${totalText} 件中 ${startIndex + 1}〜${startIndex + pageRecords.length} 件を表示中`;
  renderListPager(totalPages);

  pageRecords.forEach(record => {
    const status = record["レコードステータス"] || "通常";
    const ocrStatus = record["OCRステータス"] || "";
    // 仮登録×OCR処理中の間は編集不可（設計書9-2）。一覧上はロック表示にしてクリックを無効化する
    const isLocked = (status === "仮登録" && ocrStatus === "処理中");
    // OCR処理中（ロック中）はDriveファイルが既にアップロード済みでも選択対象から外す
    const isSelectable = !!extractDriveFileId(record["DriveファイルURL"]) && !isLocked;

    const useTypeLabel = getUseTypeLabel(record["用途種別ID"]);
    const tagLabels = getTagLabels(record["タグID一覧"]);
    const statusLabel = status === "仮登録" ? (isLocked ? "処理中" : "未") : "済";
    // 一覧の金額は税込を、その書類の通貨の表記（¥ 12,345／$ 1,234.50 など）で表示する（0円も表示する）
    const amountIncl = record["金額（税込）"];
    const amountText = (amountIncl === "" || amountIncl === null || amountIncl === undefined) ? "" : formatAmountText(amountIncl, record["通貨"]);
    const transactionDateText = formatDateOnly(record["取引日"]);
    const caseNoText = parseCaseNos(record["案件No"]).join(", "); // 複数の案件は「12, 15」のように表示する

    const row = document.createElement("div");
    row.className = "file-list-grid file-list-row" + (isLocked ? " is-locked" : "");
    // 表示する値はすべてエスケープして埋め込む（外部由来のファイル名などにスクリプトが含まれていても動かないようにする）
    row.innerHTML = `
      <div>${isSelectable ? `<input type="checkbox" class="zip-select-checkbox" data-file-id="${escapeHtml(record["ファイルID"])}" data-row-number="${escapeHtml(record["_rowNumber"])}" onclick="event.stopPropagation()">` : ""}</div>
      <div class="badge-no">${escapeHtml(record["ファイルID"])}</div>
      <div><span class="badge-status ${escapeHtml(status)}">${statusLabel}</span></div>
      <div class="file-list-cell-title">${escapeHtml(record["表示名"] || record["ファイル名"] || "（無題）")}</div>
      <div>${textOrDash(useTypeLabel)}</div>
      <div title="${escapeHtml(tagLabels.join('、'))}">${textOrDash(tagLabels.join('、'))}</div>
      <div>${textOrDash(record["発行受領区分"])}</div>
      <div title="${escapeHtml(caseNoText)}">${textOrDash(caseNoText)}</div>
      <div>${textOrDash(record["取引先"])}</div>
      <div>${textOrDash(transactionDateText)}</div>
      <div class="file-list-cell-amount">${textOrDash(amountText)}</div>
      <div>${textOrDash(record["アップロード者"])}</div>
    `;
    if (!isLocked) {
      row.onclick = () => openDetailModal(record);
    } else {
      row.onclick = () => showToast("OCR処理中のため編集できません");
    }
    container.appendChild(row);
  });
}

// =================================================================
// 選択ファイル一括操作（プルダウンメニュー：ZIPダウンロード／ゴミ箱へ移動）
// =================================================================
// 「絞り込み検索」パネルの開閉（初期表示はキーワード検索のみでスッキリさせるための対応）
window.toggleAdvancedFilters = function() {
  const panel = document.getElementById("advancedFilterPanel");
  const icon = document.getElementById("advancedFilterToggleIcon");
  const isOpen = panel.style.display !== "none";
  panel.style.display = isOpen ? "none" : "block";
  icon.style.transform = isOpen ? "rotate(0deg)" : "rotate(180deg)";
};

window.toggleBulkActionMenu = function() {
  const menu = document.getElementById("bulkActionMenu");
  menu.style.display = (menu.style.display === "none") ? "block" : "none";
};

// メニュー外クリックで閉じる
document.addEventListener("click", (e) => {
  const wrapper = document.getElementById("bulkActionDropdownWrapper");
  if (wrapper && !wrapper.contains(e.target)) {
    document.getElementById("bulkActionMenu").style.display = "none";
  }
});

function getSelectedFileIds() {
  return Array.from(document.querySelectorAll(".zip-select-checkbox:checked")).map(el => el.dataset.fileId);
}

window.handleZipDownload = async function() {
  document.getElementById("bulkActionMenu").style.display = "none";
  const fileIds = getSelectedFileIds();
  if (fileIds.length === 0) {
    return showToast("ファイルにチェックを入れてください");
  }

  const result = await Swal.fire({
    title: `${fileIds.length}件のファイルをZIPでダウンロードします`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'ダウンロード',
    cancelButtonText: 'キャンセル'
  });
  if (!result.isConfirmed) return;

  showToast("ZIPを作成中...", true); // 完了するまで表示し続ける

  try {
    const data = await apiCall("createZipDownload", { fileIds });
    // base64をBlobに変換し、ブラウザのダウンロードとして保存する
    const byteChars = atob(data.base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: "application/zip" });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = data.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    Swal.close();
    showToast(data.skippedCount > 0
      ? `ダウンロードしました。（${data.skippedCount}件は対象外のため含まれていません）`
      : "ダウンロードしました。");

  } catch (err) {
    Swal.close();
    showErrorDialog(err, 'ダウンロードエラー');
  }
};

window.handleBulkMoveToTrash = async function() {
  document.getElementById("bulkActionMenu").style.display = "none";

  const checkedBoxes = Array.from(document.querySelectorAll(".zip-select-checkbox:checked"));
  if (checkedBoxes.length === 0) {
    return showToast("ファイルにチェックを入れてください");
  }
  const items = checkedBoxes.map(el => ({ fileId: el.dataset.fileId, rowNumber: Number(el.dataset.rowNumber) }));

  if (!(await confirmMoveToTrash(`${items.length}件のファイルをゴミ箱へ移動しますか？`))) return;

  // 1段階目：一覧からは即座に消す（サーバー側の処理完了を待たず、UI上の反応を速くする）
  const movingFileIds = items.map(i => i.fileId);
  allRecordsCache = allRecordsCache.filter(r => !movingFileIds.includes(r["ファイルID"]));
  search();

  showToast("ゴミ箱へ移動中...", true); // 2段階目の結果が出るまで表示し続ける

  try {
    const res = await apiCall("moveMultipleToTrash", { items });
    // サーバー側の最終結果で一覧を正として同期し直す（一部失敗していた場合もここで反映される）
    await reloadAndRender();

    Swal.close();
    if (res.failedItems && res.failedItems.length > 0) {
      Swal.fire({
        icon: 'warning',
        title: `${res.successCount}件を移動しました（${res.failedItems.length}件失敗）`,
        html: res.failedItems.map(f => `${escapeHtml(f.fileId)}: ${escapeHtml(f.reason)}`).join('<br>'),
        confirmButtonText: 'OK'
      });
    } else {
      showToast(`${res.successCount}件をゴミ箱へ移動しました。`);
    }
  } catch (err) {
    Swal.close();
    // 失敗時は一覧の見た目を正しい状態に戻すため再取得する
    await reloadAndRender();
    showErrorDialog(err);
  }
};
