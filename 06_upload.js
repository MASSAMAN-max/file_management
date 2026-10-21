/**
 * =====================================================================
 * 06_upload.js：新規ファイル登録
 * =====================================================================
 * 【役割】
 *   登録モーダルの開閉・入力、OCR有無による詳細項目の折りたたみ、
 *   仮登録（1段目）→ Drive保存＋OCR（2段目）の送信処理
 *
 * 【読み込み順】05_list.js の後。
 * 【依存】02_state.js（pendingLinks）、03_utils.js（案件No入力・セレクト）、04_api_auth.js（apiCall・一覧の再取得）
 */

// =================================================================
// 新規登録（S03）：仮登録→OCR反映→確定保存フロー（設計書9章）
// =================================================================

window.openCreateModal = function() {
  document.getElementById("createForm").reset();
  setTaxInputValues("uploadTaxRate", "uploadAmountExcl", "uploadAmountIncl", "", "", ""); // 税率は10%に戻す
  pendingLinks.length = 0; // 一覧の中身だけを空にする（案件選択部品が同じ配列を参照し続けるため）
  projectPickers.upload.reset(); // 絞り込みを初期状態に戻し、選択中の案件を描画し直す
  renderUseTypeSelectInto("uploadUseTypeId", "", "未設定（ファイル名から自動判定）");
  renderTagCheckboxesInto("uploadTagCheckboxes", []);
  document.getElementById("uploadUseOcr").checked = true; // モーダルを開くたびOCRオンから開始する
  applyUploadOcrLockState(); // OCRオン状態に合わせ、詳細項目を折りたたんでおく

  // 前回エラーで「登録中...」のまま残っていた場合に備え、送信ボタンを必ず初期状態に戻す
  const submitBtn = document.getElementById("createSubmitBtn");
  submitBtn.disabled = false;
  submitBtn.textContent = "登録する";

  document.getElementById("createModal").style.display = "flex";
};

window.closeCreateModal = function() {
  document.getElementById("createModal").style.display = "none";
};

bindTaxInputs("uploadTaxRate", "uploadAmountExcl", "uploadAmountIncl");

// =================================================================
// OCR有効時の詳細項目の折りたたみ制御
// OCRが有効な間は「書類種別・タグ・発行／受領」以外の詳細項目を折りたたみ、
// OCR結果での自動入力とユーザー手入力が競合しないようにする。
// OCRが無効な場合は開いた状態にし、手入力できるようにする。
// =================================================================
window.applyUploadOcrLockState = function() {
  const useOcr = document.getElementById("uploadUseOcr").checked;
  setUploadDetailSectionOpen(!useOcr);
};

window.toggleUploadDetailSection = function() {
  // OCRオン時はユーザーの手動開閉自体を許可しない（自動入力される項目のため）
  if (document.getElementById("uploadUseOcr").checked) {
    showToast("OCRオンの間は詳細項目を開けません。手入力するにはOCRをオフにしてください。");
    return;
  }
  const body = document.getElementById("uploadDetailBody");
  const isOpen = body.style.display !== "none";
  setUploadDetailSectionOpen(!isOpen);
};

function setUploadDetailSectionOpen(isOpen) {
  const body = document.getElementById("uploadDetailBody");
  const icon = document.getElementById("uploadDetailToggleIcon");
  body.style.display = isOpen ? "block" : "none";
  icon.style.transform = isOpen ? "rotate(180deg)" : "rotate(0deg)";
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
  });
}

async function handleCreateSubmit(event) {
  event.preventDefault();
  const fileInput = document.getElementById("uploadFileInput");
  const file = fileInput.files[0];
  if (!file) return;

  // 二重送信防止：押した瞬間にボタンを無効化する。
  // モーダルが閉じるのは1段目（仮登録）のAPI応答が返ってきた後のため、
  // その間の連打による重複登録を防ぐのが目的。
  const submitBtn = document.getElementById("createSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = "登録中...";

  const displayName = document.getElementById("uploadDisplayName").value.trim();
  const useOcr = document.getElementById("uploadUseOcr").checked;

  const entryFields = {
    useTypeId: document.getElementById("uploadUseTypeId").value.trim(),
    tagIds: getCheckedTagIdsIn("uploadTagCheckboxes"),
    client: document.getElementById("uploadClient").value.trim(),
    issuedOrReceived: document.getElementById("uploadIssuedOrReceived").value,
    invoiceRegistrationNumber: document.getElementById("uploadInvoiceRegistrationNumber").value.trim(),
    taxRate: document.getElementById("uploadTaxRate").value,
    amountExcl: getAmountInputValue("uploadAmountExcl"),
    amountIncl: getAmountInputValue("uploadAmountIncl"),
    transactionDate: document.getElementById("uploadTransactionDate").value,
    description: document.getElementById("uploadDescription").value.trim()
  };

  showToast("仮登録中...");

  try {
    // 【1段目】シートへ仮登録（軽量。base64はまだ送らない）
    const createResult = await apiCall("createRecordSheetOnly", {
      fData: Object.assign({ fileName: file.name, mimeType: file.type, displayName: displayName, caseNos: pendingLinks.slice() }, entryFields)
    });

    closeCreateModal();
    // 1段階目完了のトーストは、2段階目（Drive保存＋OCR）が終わるまで自動で消さず表示し続ける
    showToast("仮登録が完了しました。バックグラウンド処理中...", true);
    await reloadAndRender();

    // 【2段目】Drive保存＋OCR（重い処理。完了を待ってから最新化する）
    const base64 = await fileToBase64(file);
    const bgResult = await apiCall("processBackgroundTasks", {
      fData: {
        fileId: createResult.fileId, rowNumber: createResult.rowNumber,
        base64: base64, mimeType: file.type, fileName: file.name, useOcr: useOcr
      }
    });

    // 2段階目が完了したら、表示し続けていた1段階目のトーストを閉じてから完了通知に切り替える
    Swal.close();
    // OCR反映後の最新データを一覧に確実に反映する
    await reloadAndRender();
    // サーバーが「別の処理が同じファイルを実行中」と判断した場合は、完了したとは言えないため案内を分ける
    showToast(bgResult.inProgress ? "このファイルは別の処理が実行中です。完了後に一覧を更新してください。" : "処理が完了しました。");

  } catch (err) {
    Swal.close(); // 表示し続けている1段階目のトーストが残らないよう、エラー時も必ず閉じる
    // エラー時も一覧を最新状態に合わせておく（1段目は成功している可能性があるため）
    await reloadAndRender();
    showErrorDialog(err, '登録エラー');
    // 1段目が失敗した場合、モーダルは開いたままなのでボタンを再度押せるように戻す
    submitBtn.disabled = false;
    submitBtn.textContent = "登録する";
  }
}
