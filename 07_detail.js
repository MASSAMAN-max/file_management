/**
 * =====================================================================
 * 07_detail.js：ファイル詳細・確定保存／編集
 * =====================================================================
 * 【役割】
 *   詳細モーダルの表示、仮登録の確定保存・確定済みの編集、案件Noの紐付けの追加・解除、ゴミ箱への移動、
 *   一覧の並び順での「前のファイル／次のファイル」への移動（ボタン・←→キー・保存後の自動移動）
 *
 * 【読み込み順】06_upload.js の後。
 * 【依存】02_state.js（detailLinks・currentListRecords・キャッシュ）、03_utils.js（案件No入力・セレクト・確認ダイアログ）、
 *         04_api_auth.js、05_list.js（isRecordLocked）
 */

// 保存中は、前後のファイルへの移動を受け付けない（保存の完了前に画面の内容が入れ替わるのを防ぐ）
let isDetailSaving = false;
// 移動の確認ダイアログを開いている間の、二重操作防止
let isDetailMoving = false;

// =================================================================
// 詳細確認・確定保存／編集（S04・S05・S06統合）
// =================================================================
window.openDetailModal = function(record) {
  const status = record["レコードステータス"];
  const isConfirmMode = (status === "仮登録"); // 仮登録＝確定保存フロー、通常＝編集フロー

  // 見出しは「ID＋未／済バッジ＋表示名」。確定保存／編集の別は、バッジと右下の送信ボタンの文言で分かる
  const headerName = record["表示名"] || record["ファイル名"] || "（無題）";
  document.getElementById("detailModalFileId").textContent = record["ファイルID"];
  const statusBadgeEl = document.getElementById("detailModalStatusBadge");
  statusBadgeEl.className = "badge-status " + status; // 色は一覧と同じ（.badge-status.仮登録／.通常）
  statusBadgeEl.textContent = isConfirmMode ? "未" : "済";
  const headerNameEl = document.getElementById("detailModalDisplayName");
  headerNameEl.textContent = headerName;
  headerNameEl.title = headerName; // 長い名前は省略表示になるため、全文はマウスを乗せると見られる

  isDetailSaving = false;
  document.getElementById("detailMode").value = isConfirmMode ? "confirm" : "update";
  document.getElementById("detailFileId").value = record["ファイルID"];
  document.getElementById("detailRowNumber").value = record["_rowNumber"];
  document.getElementById("detailDisplayName").value = record["表示名"] || "";
  document.getElementById("detailDescription").value = record["説明・備考"] || "";
  document.getElementById("detailClient").value = record["取引先"] || "";
  document.getElementById("detailIssuedOrReceived").value = record["発行受領区分"] || "";
  document.getElementById("detailInvoiceRegistrationNumber").value = record["適格事業者登録番号"] || "";
  setTaxInputValues("detailTaxRate", "detailAmountExcl", "detailAmountIncl", "detailCurrency", record["通貨"], record["税率"], record["金額（税抜）"], record["金額（税込）"]);
  document.getElementById("detailTransactionDate").value = toDateInputValue(record["取引日"]);
  const submitBtn = document.getElementById("detailSubmitBtn");
  submitBtn.textContent = isConfirmMode ? "確定保存" : "更新する";

  // ゴミ箱への移動は確定済み・確認待ちの両方で許可する（サーバー側でもOCR処理中は拒否される）
  document.getElementById("detailDeleteBtn").style.display = "inline-flex";

  // 用途種別セレクトをマスタから動的生成する
  renderUseTypeSelectInto("detailUseTypeId", record["用途種別ID"], "未設定");

  // タグのチェックボックスを、現在選択中のタグを反映して描画する
  const currentTagIds = String(record["タグID一覧"] || "").split(",").map(s => s.trim()).filter(Boolean);
  renderTagCheckboxesInto("detailTagCheckboxes", currentTagIds);

  // 案件Noの紐付け：レコードの「案件No」列（カンマ区切り）から取り出して表示する
  detailLinks.length = 0;
  parseCaseNos(record["案件No"]).forEach(caseNo => detailLinks.push(caseNo));
  projectPickers.detail.reset(); // 絞り込みを初期状態に戻し、選択中の案件を描画し直す
  refreshDetailDisplayNameLock(); // 案件に紐付いている記録は、表示名を読み取り専用にして、案内文を出す

  // Driveプレビュー（画像・PDF・Office文書いずれもDriveの標準プレビューiframeで表示可能）
  const previewArea = document.getElementById("detailPreviewArea");
  const driveFileId = extractDriveFileId(record["DriveファイルURL"]);
  // 大きさ・配置は style.css（.detail-preview-frame）で決める。PC画面では左側に表示される
  previewArea.innerHTML = driveFileId
    ? `<iframe class="detail-preview-frame" src="https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/preview" allow="autoplay"></iframe>`
    : '<div class="detail-preview-empty">プレビューを表示できません（Drive保存前のファイルです）</div>';

  document.getElementById("detailModal").style.display = "flex";
  // 一覧から開いたとき・前後のファイルへ移動したときは、常に一番上から表示する。
  // 狭い画面は本文全体、PC画面（プレビューを左に表示）はフォームだけがスクロールするため、両方を戻す
  document.querySelector("#detailModal .modal-body").scrollTop = 0;
  document.getElementById("detailForm").scrollTop = 0;

  // 変更検知の基準にする、開いた時点の入力内容。
  // 確定済みファイルの更新では、変更が無い間は「更新する」を押せない（前回エラーで無効化されたままの状態もここで解除される）
  detailInitialData = collectDetailFormData();
  updateDetailSubmitState();
  refreshDetailNav();
};

// =================================================================
// 前のファイル／次のファイルへの移動（一覧に表示中の並び順）
//   ・「前へ」＝一覧の上（新しい方）、「次へ」＝一覧の下（古い方）。ページをまたいで移動する
//   ・OCR処理中で編集できないファイルは、飛ばして次の編集できるファイルへ移動する
//   ・未保存の変更があるときは、確認してから移動する
//   ・キーボードの ← → でも移動できる（入力欄にカーソルがあるときを除く。下の keydown）
//   ・「確定保存／更新」が成功したあとは、自動で次のファイルを開く（handleDetailSubmit）
// =================================================================

/** 指定したファイルIDから見て、指定方向（-1：前／1：次）にある、編集できる最初のレコード。無ければ null */
function findAdjacentEditableRecordFrom(fileId, delta) {
  const index = currentListRecords.findIndex(record => record["ファイルID"] === fileId);
  if (index === -1) return null; // 一覧に無い（絞り込みから外れた・ゴミ箱へ移動した場合など）
  for (let i = index + delta; i >= 0 && i < currentListRecords.length; i += delta) {
    if (!isRecordLocked(currentListRecords[i])) return currentListRecords[i];
  }
  return null;
}

/** いま開いているファイルから見て、指定方向にある、編集できる最初のレコード。無ければ null */
function findAdjacentEditableRecord(delta) {
  return findAdjacentEditableRecordFrom(document.getElementById("detailFileId").value, delta);
}

/** 下部バーの「前へ／次へ」の有効・無効と、「3 / 120」の位置表示を、現在の一覧に合わせる */
function refreshDetailNav() {
  if (document.getElementById("detailModal").style.display === "none") return;

  const fileId = document.getElementById("detailFileId").value;
  const index = currentListRecords.findIndex(record => record["ファイルID"] === fileId);
  document.getElementById("detailNavPosition").textContent =
    index === -1 ? "" : `${index + 1} / ${currentListRecords.length}`;
  document.getElementById("detailNavPrevBtn").disabled = !findAdjacentEditableRecord(-1);
  document.getElementById("detailNavNextBtn").disabled = !findAdjacentEditableRecord(1);
}

/** 保存していない変更があるとき、破棄して移動してよいかを確認する。移動する場合は true */
async function confirmDiscardDetailChanges(changes) {
  const result = await Swal.fire({
    title: "保存していない変更があります",
    text: `変更した項目：${changes.map(c => c.label).join("、")}。破棄して移動しますか？`,
    icon: "warning",
    showCancelButton: true,
    confirmButtonColor: "#dc2626",
    confirmButtonText: "破棄して移動",
    cancelButtonText: "キャンセル"
  });
  return result.isConfirmed;
}

/** 前のファイル（delta=-1）／次のファイル（delta=1）の編集画面へ移動する */
window.moveDetail = async function(delta) {
  if (isDetailMoving || isDetailSaving) return;
  const target = findAdjacentEditableRecord(delta);
  if (!target) return;

  isDetailMoving = true;
  try {
    const changes = getDetailChanges();
    if (changes.length > 0 && !(await confirmDiscardDetailChanges(changes))) return;
    openDetailModal(target);
  } finally {
    isDetailMoving = false;
  }
};

// キーボード操作：← で前のファイル、→ で次のファイルへ移動する。
// 次の場合は何もしない（文字入力・カーソル移動・ダイアログ操作を邪魔しないため）。
//   ・詳細モーダルが閉じているとき／確認ダイアログの表示中
//   ・入力欄・テキストエリア・セレクトにカーソルがあるとき
//   ・日本語入力の変換中／修飾キー（Ctrl・Shift・Alt・Cmd）を押しているとき／キーを押しっぱなしのとき
document.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (document.getElementById("detailModal").style.display === "none") return;
  if (window.Swal && Swal.isVisible && Swal.isVisible()) return;

  const el = e.target;
  const isTextEntry = el instanceof HTMLElement &&
    (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  if (isTextEntry) return;

  e.preventDefault(); // ページ（モーダル本文）が横にスクロールしないようにする
  moveDetail(e.key === "ArrowLeft" ? -1 : 1);
});

// =================================================================
// 表示名の切り替え（案件に紐付けているときは、保存時に命名規則の名前が自動で入る）
// =================================================================
/** 案件の紐付けの有無に合わせて、表示名の入力欄を切り替える（03_utils.js の applyDisplayNameLock） */
function refreshDetailDisplayNameLock() {
  applyDisplayNameLock(document.getElementById("detailDisplayName"), detailLinks.length > 0);
}

// 案件の追加・解除のたびに切り替える（フォーム全体の変更検知より先に動くよう、案件選択部品に登録する）
document.getElementById("detailProjectPicker").addEventListener("change", refreshDetailDisplayNameLock);

// =================================================================
// 入力内容の取得と、変更の検知（確定済みファイルの更新用）
// =================================================================
let detailInitialData = null; // モーダルを開いた時点の入力内容（collectDetailFormData の結果）

// 変更を検知・表示する項目（キー：collectDetailFormData の項目名、ラベル：確認画面に出す項目名）
const DETAIL_CHANGE_FIELDS = [
  { key: "displayName", label: "表示名" },
  { key: "useTypeId", label: "書類種別" },
  { key: "tagIds", label: "タグ" },
  { key: "client", label: "取引先" },
  { key: "issuedOrReceived", label: "発行／受領" },
  { key: "invoiceRegistrationNumber", label: "適格事業者登録番号" },
  { key: "currency", label: "通貨" },
  { key: "taxRate", label: "税率" },
  { key: "amountExcl", label: "金額（税抜）" },
  { key: "amountIncl", label: "金額（税込）" },
  { key: "transactionDate", label: "取引日" },
  { key: "description", label: "説明・備考" },
  { key: "caseNos", label: "案件No" }
];

/** 詳細モーダルの入力内容を、サーバーへ送る形（fData）で集める。保存と、変更の検知の両方で使う */
function collectDetailFormData() {
  return {
    fileId: document.getElementById("detailFileId").value,
    rowNumber: Number(document.getElementById("detailRowNumber").value),
    displayName: document.getElementById("detailDisplayName").value.trim(),
    useTypeId: document.getElementById("detailUseTypeId").value.trim(),
    tagIds: getCheckedTagIdsIn("detailTagCheckboxes"),
    client: document.getElementById("detailClient").value.trim(),
    issuedOrReceived: document.getElementById("detailIssuedOrReceived").value,
    invoiceRegistrationNumber: document.getElementById("detailInvoiceRegistrationNumber").value.trim(),
    currency: document.getElementById("detailCurrency").value,
    taxRate: document.getElementById("detailTaxRate").value,
    amountExcl: getAmountInputValue("detailAmountExcl"),
    amountIncl: getAmountInputValue("detailAmountIncl"),
    transactionDate: document.getElementById("detailTransactionDate").value,
    description: document.getElementById("detailDescription").value.trim(),
    caseNos: detailLinks.slice() // サーバー側で、このファイルの案件の紐付けをこの一覧と同じ状態にそろえる
  };
}

/** 比較用の値にする（タグ・案件Noは並び順の違いを変更とみなさない） */
function toComparableValue(value) {
  return Array.isArray(value) ? [...value].sort().join(",") : String(value);
}

/**
 * 確認画面に出す値の文字列にする（IDは名前に、金額は「¥ 12,345」に直す。長い文字は省略する）
 * @param {string} currencyCode 金額の表示に使う通貨（変更前の値には変更前の通貨、変更後の値には変更後の通貨を渡す）
 */
function formatDetailChangeValue(key, value, currencyCode) {
  if (key === "tagIds") return getTagLabels(value.join(",")).join("、") || "（なし）";
  if (key === "caseNos") return value.join(", ") || "（なし）";
  if (key === "useTypeId") return getUseTypeLabel(value) || "（未設定）";
  if (key === "currency") return getCurrencyLabel(getCurrency(value));
  if (key === "taxRate") return value === TAX_RATE_NON_TAXABLE ? value : `${value}%`;
  if (key === "amountExcl" || key === "amountIncl") return value === "" ? "（空）" : formatAmountText(value, currencyCode);
  if (value === "") return "（空）";
  const chars = [...String(value)];
  return chars.length > 30 ? chars.slice(0, 30).join("") + "…" : String(value);
}

/** 開いた時点の入力内容から変わっている項目の一覧（[{label, before, after}]）。変更が無ければ空 */
function getDetailChanges() {
  if (!detailInitialData) return [];
  const current = collectDetailFormData();
  return DETAIL_CHANGE_FIELDS
    .filter(field => toComparableValue(current[field.key]) !== toComparableValue(detailInitialData[field.key]))
    .map(field => ({
      label: field.label,
      before: formatDetailChangeValue(field.key, detailInitialData[field.key], detailInitialData.currency),
      after: formatDetailChangeValue(field.key, current[field.key], current.currency)
    }));
}

/** 確定済みファイル（更新モード）は、変更が無い間「更新する」を押せなくする。確定保存モードは常に押せる */
function updateDetailSubmitState() {
  const submitBtn = document.getElementById("detailSubmitBtn");
  const isUpdateMode = document.getElementById("detailMode").value === "update";
  submitBtn.disabled = isUpdateMode && getDetailChanges().length === 0;
}

/** 変更する項目と、変更前→変更後を見せて、本当に更新するかを確認する。更新する場合は true */
async function confirmDetailChanges(changes) {
  const html = '<div style="text-align:left; font-size:13px; line-height:1.8;">' +
    changes.map(c => `<div><b>${escapeHtml(c.label)}</b>：${escapeHtml(c.before)} → ${escapeHtml(c.after)}</div>`).join("") +
    '</div>';
  const result = await Swal.fire({
    title: "内容を変更しますか？",
    html: html,
    icon: "question",
    showCancelButton: true,
    confirmButtonText: "変更する",
    cancelButtonText: "キャンセル"
  });
  return result.isConfirmed;
}

/** 金額（税抜・税込）が、両方とも「空または0」か。確定保存・更新の前の確認に使う */
function isAmountBlankOrZero() {
  const isBlankOrZero = (digits) => digits === "" || Number(digits) === 0; // 金額欄の値は数字（と小数点）だけの文字列
  return isBlankOrZero(getAmountInputValue("detailAmountExcl")) && isBlankOrZero(getAmountInputValue("detailAmountIncl"));
}

/**
 * 金額が空（または0）のまま保存してよいかを確認する。保存する場合は true
 * 「戻る」を選んだときは、金額（税込）の入力欄にカーソルを戻す
 * @param {string} actionLabel 確認文とボタンに出す操作名（「確定」「更新」）
 */
async function confirmBlankAmount(actionLabel) {
  const result = await Swal.fire({
    title: "金額が入力されていません",
    text: `金額（税抜・税込）が空、または0のままです。このまま${actionLabel}しますか？`,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: `このまま${actionLabel}する`,
    cancelButtonText: "戻って入力する"
  });
  if (!result.isConfirmed) document.getElementById("detailAmountIncl").focus();
  return result.isConfirmed;
}

bindTaxInputs("detailTaxRate", "detailAmountExcl", "detailAmountIncl", "detailCurrency");

// 入力欄・セレクト・タグ・案件の変更を検知して、「更新する」ボタンの有効／無効を切り替える
["input", "change"].forEach(eventType => {
  document.getElementById("detailForm").addEventListener(eventType, updateDetailSubmitState);
});

window.closeDetailModal = function() {
  document.getElementById("detailModal").style.display = "none";
};

/**
 * 確定保存・更新。成功したら、一覧の次のファイルを自動で開く（次が無ければモーダルを閉じる）。
 *   ・次のファイルは、保存する前に決めておく（保存で一覧が再取得されても、移動先がずれないようにするため）
 *   ・「保存の失敗」と「保存後の一覧の再取得の失敗」は分けて扱う
 *     （保存は終わっているのに、再取得だけ失敗したとき、同じ内容を二重に保存させないため）
 */
async function handleDetailSubmit(event) {
  event.preventDefault();
  const mode = document.getElementById("detailMode").value; // confirm or update
  const action = (mode === "confirm") ? "confirmRecord" : "updateRecord";

  // 確定済みファイルの更新：変更内容を確認してから保存する（変更が無い場合は何もしない）
  if (mode === "update") {
    const changes = getDetailChanges();
    if (changes.length === 0) return;
    if (!(await confirmDetailChanges(changes))) return;
  }

  // 確定保存・更新のどちらも、金額が空（または0）なら確認を挟む（二重送信防止のボタン無効化より前に行う）
  if (isAmountBlankOrZero() && !(await confirmBlankAmount(mode === "confirm" ? "確定" : "更新"))) return;

  // 保存後に開くファイルを、保存前に決めておく（無ければ null＝保存後にモーダルを閉じる）
  const nextRecord = findAdjacentEditableRecord(1);
  const nextFileId = nextRecord ? nextRecord["ファイルID"] : "";

  // 二重送信防止：押した瞬間にボタンを無効化する
  const submitBtn = document.getElementById("detailSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = mode === "confirm" ? "保存中..." : "更新中...";
  isDetailSaving = true; // 保存が終わるまで、前後のファイルへは移動できない

  showToast(mode === "confirm" ? "確定保存中..." : "更新中...", true);

  // 【保存】失敗した場合、モーダルは開いたままなので、ボタンを再度押せるように戻す
  try {
    await apiCall(action, { fData: collectDetailFormData() });
  } catch (err) {
    Swal.close();
    showErrorDialog(err);
    submitBtn.disabled = false;
    submitBtn.textContent = mode === "confirm" ? "確定保存" : "更新する";
    isDetailSaving = false;
    return;
  }

  // 【一覧の更新】保存は完了している。ここで失敗しても、同じ内容を保存し直させないよう、モーダルは閉じる
  Swal.close(); // 表示し続けていた「処理中」トーストを閉じてから完了通知に切り替える
  try {
    await reloadAndRender();
  } catch (err) {
    closeDetailModal();
    isDetailSaving = false;
    showErrorDialog(new Error(`保存は完了しましたが、一覧の更新に失敗しました。画面を再読み込みしてください。（${err.message}）`));
    return;
  }

  const doneMessage = mode === "confirm" ? "確定保存が完了しました。" : "更新しました。";

  // 保存前に決めた次のファイルを、更新後の一覧から探して開く（編集できない状態になっていたら、閉じる）
  const refreshedNext = nextFileId
    ? currentListRecords.find(record => record["ファイルID"] === nextFileId)
    : null;
  if (refreshedNext && !isRecordLocked(refreshedNext)) {
    openDetailModal(refreshedNext); // isDetailSaving も、ここで元に戻る
    showToast(`${doneMessage}次のファイルを開きました。`);
  } else {
    closeDetailModal();
    isDetailSaving = false;
    showToast(doneMessage);
  }
}

window.handleDeleteFromDetail = async function() {
  if (!(await confirmMoveToTrash('ゴミ箱へ移動しますか？'))) return;

  const fileId = document.getElementById("detailFileId").value;
  const rowNumber = Number(document.getElementById("detailRowNumber").value);

  closeDetailModal();

  // 1段階目：一覧からは即座に消す
  allRecordsCache = allRecordsCache.filter(r => r["ファイルID"] !== fileId);
  search();

  showToast("ゴミ箱へ移動中...", true); // 2段階目の結果が出るまで表示し続ける

  try {
    await apiCall("moveToTrash", { fData: { fileId, rowNumber } });
    await reloadAndRender();
    Swal.close();
    showToast("ゴミ箱へ移動しました。");
  } catch (err) {
    Swal.close();
    // 失敗時は一覧の見た目を正しい状態に戻すため再取得する
    await reloadAndRender();
    showErrorDialog(err);
  }
};
