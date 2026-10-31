/**
 * =====================================================================
 * 07_detail.js：ファイル詳細・確定保存／編集
 * =====================================================================
 * 【役割】
 *   詳細モーダルの表示、仮登録の確定保存・確定済みの編集、案件Noの紐付けの追加・解除、ゴミ箱への移動
 *
 * 【読み込み順】06_upload.js の後。
 * 【依存】02_state.js（detailLinks・キャッシュ）、03_utils.js（案件No入力・セレクト・確認ダイアログ）、04_api_auth.js
 */

// =================================================================
// 詳細確認・確定保存／編集（S04・S05・S06統合）
// =================================================================
window.openDetailModal = function(record) {
  const status = record["レコードステータス"];
  const isConfirmMode = (status === "仮登録"); // 仮登録＝確定保存フロー、通常＝編集フロー

  document.getElementById("detailModalTitle").textContent = isConfirmMode ? "内容の確認・確定保存" : "ファイル編集";
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
  document.getElementById("detailSubmitBtn").textContent = isConfirmMode ? "確定保存" : "更新する";

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
  previewArea.innerHTML = driveFileId
    ? `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/preview" style="width:100%; height:min(320px, 38vh); border:1px solid #e2e8f0; border-radius:8px;" allow="autoplay"></iframe>`
    : '<div style="color:#94a3b8; font-size:13px;">プレビューを表示できません（Drive保存前のファイルです）</div>';

  const ocrText = record["OCRテキスト（全文）"];
  const ocrStatus = record["OCRステータス"];
  document.getElementById("detailOcrPreview").textContent = ocrText
    ? `【OCR抽出結果】\n${ocrText}`
    : `【OCR抽出結果】未取得（OCRステータス: ${ocrStatus || "未実施"}）`;

  document.getElementById("detailModal").style.display = "flex";
  document.querySelector("#detailModal .modal-body").scrollTop = 0; // 一覧から開いたときは、常に一番上から表示する

  // 変更検知の基準にする、開いた時点の入力内容。
  // 確定済みファイルの更新では、変更が無い間は「更新する」を押せない（前回エラーで無効化されたままの状態もここで解除される）
  detailInitialData = collectDetailFormData();
  updateDetailSubmitState();
};

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

bindTaxInputs("detailTaxRate", "detailAmountExcl", "detailAmountIncl", "detailCurrency");

// 入力欄・セレクト・タグ・案件の変更を検知して、「更新する」ボタンの有効／無効を切り替える
["input", "change"].forEach(eventType => {
  document.getElementById("detailForm").addEventListener(eventType, updateDetailSubmitState);
});

window.closeDetailModal = function() {
  document.getElementById("detailModal").style.display = "none";
};

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

  // 二重送信防止：押した瞬間にボタンを無効化する
  const submitBtn = document.getElementById("detailSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = mode === "confirm" ? "保存中..." : "更新中...";

  showToast(mode === "confirm" ? "確定保存中..." : "更新中...", true);

  try {
    await apiCall(action, { fData: collectDetailFormData() });

    closeDetailModal();
    Swal.close(); // 表示し続けていた「処理中」トーストを閉じてから完了通知に切り替える
    await reloadAndRender();
    showToast(mode === "confirm" ? "確定保存が完了しました。" : "更新しました。");

  } catch (err) {
    Swal.close();
    showErrorDialog(err);
    // 失敗した場合、モーダルは開いたままなのでボタンを再度押せるように戻す
    submitBtn.disabled = false;
    submitBtn.textContent = mode === "confirm" ? "確定保存" : "更新する";
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
