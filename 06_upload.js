/**
 * =====================================================================
 * 06_upload.js：新規ファイル登録（複数ファイル対応）
 * =====================================================================
 * 【役割】
 *   登録モーダルの開閉・入力、OCR・ファイル数による詳細項目の折りたたみ、
 *   仮登録（1段目）→ Drive保存＋OCR（2段目）の送信処理
 *
 * 【複数ファイルのときの動き】
 *   ・書類種別・発行／受領・タグ・案件No・OCR の設定は、全ファイルに共通で適用する
 *   ・表示名・取引先・通貨・税率・金額などの詳細項目は入力できない（登録後に1件ずつ編集する）。
 *     通貨は円、税率は10%で登録される
 *   ・サーバーの負荷と実行時間を考え、1件ずつ順番に処理する（並列にはしない）
 *   ・途中で失敗したファイルがあっても、残りは続けて処理し、最後に失敗したファイルをまとめて知らせる
 *
 * 【読み込み順】05_list.js の後。
 * 【依存】02_state.js（pendingLinks）、03_utils.js（案件No入力・セレクト）、04_api_auth.js（apiCall・一覧の再取得）
 */

// 一度に登録できるファイル数の上限（1件ごとにbase64を送るため、GASの実行時間を考えた値）
const MAX_UPLOAD_FILES = 10;

// =================================================================
// 新規登録（S03）：仮登録→OCR反映→確定保存フロー（設計書9章）
// =================================================================

window.openCreateModal = function() {
  document.getElementById("createForm").reset(); // ファイルの選択も空に戻る
  setTaxInputValues("uploadTaxRate", "uploadAmountExcl", "uploadAmountIncl", "uploadCurrency", "", "", "", ""); // 通貨は円、税率は10%に戻す
  pendingLinks.length = 0; // 一覧の中身だけを空にする（案件選択部品が同じ配列を参照し続けるため）
  projectPickers.upload.reset(); // 絞り込みを初期状態に戻し、選択中の案件を描画し直す
  applyDisplayNameLock(document.getElementById("uploadDisplayName"), false); // 開いた直後は紐付け案件無しなので、手入力できる状態に戻す
  renderUseTypeSelectInto("uploadUseTypeId", "", "未設定（ファイル名から自動判定）");
  renderTagCheckboxesInto("uploadTagCheckboxes", []);
  document.getElementById("uploadUseOcr").checked = true; // モーダルを開くたびOCRオンから開始する
  renderUploadFileSummary();
  applyUploadDetailLockState(); // OCRオン状態に合わせ、詳細項目を折りたたんでおく

  // 前回エラーで「登録中...」のまま残っていた場合に備え、送信ボタンを必ず初期状態に戻す
  const submitBtn = document.getElementById("createSubmitBtn");
  submitBtn.disabled = false;
  submitBtn.textContent = "登録する";

  document.getElementById("createModal").style.display = "flex";
};

// 案件の追加・解除のたびに、表示名を手入力できるか（紐付け案件無しのときだけ）を切り替える
document.getElementById("uploadProjectPicker").addEventListener("change", () => {
  applyDisplayNameLock(document.getElementById("uploadDisplayName"), pendingLinks.length > 0);
});

window.closeCreateModal = function() {
  document.getElementById("createModal").style.display = "none";
};

bindTaxInputs("uploadTaxRate", "uploadAmountExcl", "uploadAmountIncl", "uploadCurrency");

// =================================================================
// ファイル選択
// =================================================================

/** 選択中のファイルの一覧（0件なら空配列） */
function getSelectedUploadFiles() {
  return Array.from(document.getElementById("uploadFileInput").files);
}

/** ファイルが選ばれ直したときの処理（上限チェック → 案内文と詳細項目の状態を更新） */
window.onUploadFilesChanged = function() {
  const fileInput = document.getElementById("uploadFileInput");
  if (fileInput.files.length > MAX_UPLOAD_FILES) {
    showToast(`一度に登録できるのは${MAX_UPLOAD_FILES}件までです。選び直してください。`);
    fileInput.value = ""; // 上限を超えたまま登録されないよう、選択を取り消す
  }
  renderUploadFileSummary();
  applyUploadDetailLockState();
};

/** 2件以上選んでいるときだけ、共通項目が全ファイルに適用されることを案内する */
function renderUploadFileSummary() {
  const summaryEl = document.getElementById("uploadFileSummary");
  const count = getSelectedUploadFiles().length;
  if (count < 2) {
    summaryEl.style.display = "none";
    summaryEl.textContent = "";
    return;
  }
  summaryEl.style.display = "block";
  summaryEl.textContent = `${count}件のファイルを選択中です。書類種別・発行／受領・タグ・案件・OCRの設定は全ファイルに共通で適用されます。通貨は円、税率は10%で登録されます。表示名・取引先・金額などは、登録後に1件ずつ編集してください。`;
}

// =================================================================
// 詳細項目の折りたたみ制御
// 次のどちらかの間は詳細項目を折りたたみ、手動でも開けないようにする。
//   ・OCRがオン：OCR結果での自動入力とユーザー手入力が競合しないようにするため
//   ・複数ファイルを選択中：詳細項目はファイルごとに違い、全ファイル共通では入力できないため
// どちらでもない場合（OCRオフ・ファイル1件以下）は開いた状態にし、手入力できるようにする。
// ※ 書類種別・発行／受領・タグ・案件は詳細項目の外にあり、常に操作できる。
// ※ 通貨・税率は詳細項目の中にあるため、折りたたんでいる間は円・税率10%固定で登録される。
// =================================================================
window.applyUploadDetailLockState = function() {
  const useOcr = document.getElementById("uploadUseOcr").checked;
  const isMultiple = getSelectedUploadFiles().length > 1;
  setUploadDetailSectionOpen(!useOcr && !isMultiple);
};

window.toggleUploadDetailSection = function() {
  // 手動で開閉できないのは、自動入力される項目・ファイルごとに違う項目のため（理由に合わせて案内を分ける）
  if (getSelectedUploadFiles().length > 1) {
    showToast("複数ファイルの間は詳細項目を入力できません。登録後に1件ずつ編集してください。");
    return;
  }
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

// =================================================================
// 送信処理
// =================================================================

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
  });
}

/**
 * 入力欄の値を、仮登録APIに渡す項目にまとめる。
 * 詳細項目（取引先・通貨・税率・金額など）は、次のとおり扱いを分ける。
 *   ・複数ファイル：ファイルごとに違うため空にして渡す（全ファイルに同じ金額などが登録されるのを防ぐ）
 *   ・OCRオン：通貨・税率は空にして渡す（サーバー側で、円・税率10%になる）。それ以外の詳細項目は入力欄の値を渡す
 *   ・OCRオフ：入力欄の値をそのまま渡す
 * @param {boolean} isMultiple 複数ファイルの登録か
 * @param {boolean} useOcr OCRがオンか
 */
function collectUploadEntryFields(isMultiple, useOcr) {
  const commonFields = {
    useTypeId: document.getElementById("uploadUseTypeId").value.trim(),
    tagIds: getCheckedTagIdsIn("uploadTagCheckboxes"),
    issuedOrReceived: document.getElementById("uploadIssuedOrReceived").value
  };
  if (isMultiple) {
    return Object.assign(commonFields, {
      client: "", invoiceRegistrationNumber: "", currency: "", taxRate: "",
      amountExcl: "", amountIncl: "", transactionDate: "", description: ""
    });
  }
  return Object.assign(commonFields, {
    client: document.getElementById("uploadClient").value.trim(),
    invoiceRegistrationNumber: document.getElementById("uploadInvoiceRegistrationNumber").value.trim(),
    currency: useOcr ? "" : document.getElementById("uploadCurrency").value,
    taxRate: useOcr ? "" : document.getElementById("uploadTaxRate").value,
    amountExcl: getAmountInputValue("uploadAmountExcl"),
    amountIncl: getAmountInputValue("uploadAmountIncl"),
    transactionDate: document.getElementById("uploadTransactionDate").value,
    description: document.getElementById("uploadDescription").value.trim()
  });
}

/**
 * 失敗したファイルを、エラーダイアログで知らせる。
 * 1件だけの登録（従来どおり）はメッセージのみ。複数ファイルのときは、ファイル名ごとに並べて表示する。
 * @param {Array<{fileName: string, message: string}>} failures
 * @param {boolean} isMultiple 複数ファイルの登録か
 * @param {string} title ダイアログの見出し
 */
function showUploadFailures(failures, isMultiple, title) {
  if (!isMultiple) return showErrorDialog(new Error(failures[0].message), title);
  const items = failures
    .map(f => `<li style="margin-bottom:6px;"><b>${escapeHtml(f.fileName)}</b><br>${escapeHtml(f.message)}</li>`)
    .join("");
  return Swal.fire({
    icon: "error", title: title, confirmButtonText: "OK",
    html: `<ul style="text-align:left; font-size:14px; padding-left:20px; margin:0;">${items}</ul>`
  });
}

async function handleCreateSubmit(event) {
  event.preventDefault();
  const files = getSelectedUploadFiles();
  if (files.length === 0) return;
  if (files.length > MAX_UPLOAD_FILES) {
    showToast(`一度に登録できるのは${MAX_UPLOAD_FILES}件までです。選び直してください。`);
    return;
  }

  // 二重送信防止：押した瞬間にボタンを無効化する。
  // モーダルが閉じるのは1段目（仮登録）のAPI応答が返ってきた後のため、
  // その間の連打による重複登録を防ぐのが目的。
  const submitBtn = document.getElementById("createSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = "登録中...";

  const isMultiple = files.length > 1;
  const useOcr = document.getElementById("uploadUseOcr").checked;
  const entryFields = collectUploadEntryFields(isMultiple, useOcr);
  const displayName = isMultiple ? "" : document.getElementById("uploadDisplayName").value.trim(); // 空ならファイル名が表示名になる
  const caseNos = pendingLinks.slice();

  showToast(isMultiple ? `仮登録中...（${files.length}件）` : "仮登録中...");

  try {
    // 【1段目】シートへ仮登録（軽量。base64はまだ送らない）。1件ずつ順番に行い、失敗したファイルは記録して続ける
    const registered = []; // 仮登録できたファイル {file, createResult}
    const failures = [];   // 失敗したファイル {fileName, message}
    for (const file of files) {
      try {
        const createResult = await apiCall("createRecordSheetOnly", {
          fData: Object.assign({ fileName: file.name, mimeType: file.type, displayName: displayName, caseNos: caseNos }, entryFields)
        });
        registered.push({ file: file, createResult: createResult });
      } catch (err) {
        failures.push({ fileName: file.name, message: err.message });
      }
    }

    // 1件も仮登録できなかった場合は、モーダルを開いたままにして、直して再度押せるようにする
    if (registered.length === 0) {
      await reloadAndRender(); // 通信エラーなどで、実際には登録されていた場合に備えて一覧を最新にしておく
      showUploadFailures(failures, isMultiple, "登録エラー");
      submitBtn.disabled = false;
      submitBtn.textContent = "登録する";
      return;
    }

    closeCreateModal();
    // 1段階目完了のトーストは、2段階目（Drive保存＋OCR）が終わるまで自動で消さず表示し続ける
    showToast("仮登録が完了しました。バックグラウンド処理中...", true);
    await reloadAndRender();

    // 【2段目】Drive保存＋OCR（重い処理）。1件ずつ順番に行い、完了を待つ
    let inProgressCount = 0; // 「別の処理が同じファイルを実行中」とサーバーが判断した件数
    for (let i = 0; i < registered.length; i++) {
      const file = registered[i].file;
      const createResult = registered[i].createResult;
      if (isMultiple) showToast(`処理中... ${i + 1}/${registered.length}件（画面を閉じないでください）`, true);
      try {
        const base64 = await fileToBase64(file);
        const bgResult = await apiCall("processBackgroundTasks", {
          fData: {
            fileId: createResult.fileId, rowNumber: createResult.rowNumber,
            base64: base64, mimeType: file.type, fileName: file.name, useOcr: useOcr
          }
        });
        if (bgResult.inProgress) inProgressCount++;
      } catch (err) {
        failures.push({ fileName: file.name, message: err.message });
      }
    }

    // 全件が終わったら、表示し続けていたトーストを閉じてから、OCR反映後の最新データを一覧に反映する
    Swal.close();
    await reloadAndRender();

    // 結果の通知。失敗があればファイル名つきで知らせ、なければ完了を知らせる
    if (failures.length > 0) {
      const title = registered.length > 0 && failures.length < files.length ? "一部のファイルでエラーが発生しました" : "登録エラー";
      showUploadFailures(failures, isMultiple, title);
    } else if (inProgressCount > 0) {
      showToast(isMultiple
        ? `処理が完了しました。（${inProgressCount}件は別の処理が実行中です。完了後に一覧を更新してください）`
        : "このファイルは別の処理が実行中です。完了後に一覧を更新してください。");
    } else {
      showToast(isMultiple ? `${files.length}件の処理が完了しました。` : "処理が完了しました。");
    }

  } catch (err) {
    Swal.close(); // 表示し続けているトーストが残らないよう、エラー時も必ず閉じる
    // 想定外のエラー時も一覧を最新状態に合わせておく（途中まで登録されている可能性があるため）
    await reloadAndRender();
    showErrorDialog(err, '登録エラー');
    // モーダルが開いたままの場合に、ボタンを再度押せるように戻す
    submitBtn.disabled = false;
    submitBtn.textContent = "登録する";
  }
}
