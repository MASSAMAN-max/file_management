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
  setTaxInputValues("detailTaxRate", "detailAmountExcl", "detailAmountIncl", record["税率"], record["金額（税抜）"], record["金額（税込）"]);
  document.getElementById("detailTransactionDate").value = toDateInputValue(record["取引日"]);
  document.getElementById("detailSubmitBtn").textContent = isConfirmMode ? "確定保存" : "更新する";
  document.getElementById("detailSubmitBtn").disabled = false; // 前回エラーで無効化されたままの状態を確実に解除する

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

  // Driveプレビュー（画像・PDF・Office文書いずれもDriveの標準プレビューiframeで表示可能）
  const previewArea = document.getElementById("detailPreviewArea");
  const driveFileId = extractDriveFileId(record["DriveファイルURL"]);
  previewArea.innerHTML = driveFileId
    ? `<iframe src="https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/preview" style="width:100%; height:320px; border:1px solid #e2e8f0; border-radius:8px;" allow="autoplay"></iframe>`
    : '<div style="color:#94a3b8; font-size:13px;">プレビューを表示できません（Drive保存前のファイルです）</div>';

  const ocrText = record["OCRテキスト（全文）"];
  const ocrStatus = record["OCRステータス"];
  document.getElementById("detailOcrPreview").textContent = ocrText
    ? `【OCR抽出結果】\n${ocrText}`
    : `【OCR抽出結果】未取得（OCRステータス: ${ocrStatus || "未実施"}）`;

  document.getElementById("detailModal").style.display = "flex";
};

bindTaxInputs("detailTaxRate", "detailAmountExcl", "detailAmountIncl");

window.closeDetailModal = function() {
  document.getElementById("detailModal").style.display = "none";
};

async function handleDetailSubmit(event) {
  event.preventDefault();
  const mode = document.getElementById("detailMode").value; // confirm or update
  const action = (mode === "confirm") ? "confirmRecord" : "updateRecord";

  // 二重送信防止：押した瞬間にボタンを無効化する
  const submitBtn = document.getElementById("detailSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = mode === "confirm" ? "保存中..." : "更新中...";

  showToast(mode === "confirm" ? "確定保存中..." : "更新中...", true);

  try {
    await apiCall(action, {
      fData: {
        fileId: document.getElementById("detailFileId").value,
        rowNumber: Number(document.getElementById("detailRowNumber").value),
        displayName: document.getElementById("detailDisplayName").value.trim(),
        useTypeId: document.getElementById("detailUseTypeId").value.trim(),
        tagIds: getCheckedTagIdsIn("detailTagCheckboxes"),
        client: document.getElementById("detailClient").value.trim(),
        issuedOrReceived: document.getElementById("detailIssuedOrReceived").value,
        invoiceRegistrationNumber: document.getElementById("detailInvoiceRegistrationNumber").value.trim(),
        taxRate: document.getElementById("detailTaxRate").value,
        amountExcl: document.getElementById("detailAmountExcl").value.trim(),
        amountIncl: document.getElementById("detailAmountIncl").value.trim(),
        transactionDate: document.getElementById("detailTransactionDate").value,
        description: document.getElementById("detailDescription").value.trim(),
        caseNos: detailLinks.slice() // サーバー側で、このファイルの案件の紐付けをこの一覧と同じ状態にそろえる
      }
    });

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
