/**
 * =====================================================================
 * 06_upload.js：新規ファイル登録（複数ファイル対応）
 * =====================================================================
 * 【役割】
 *   登録モーダルの開閉・入力、OCR・ファイル数による詳細項目の折りたたみ、
 *   「登録する」で、入力内容とファイルを端末に保存し、送信キュー（13_send_queue.js）へ渡す。
 *   送信（仮登録の1段目 → Drive保存＋OCRの2段目）は、送信キューが行う。
 *
 * 【複数ファイルのときの動き】
 *   ・選んだファイル名を1件ずつ表示し、ゴミ箱アイコンで個別に外せる（1件だけのときも表示する）
 *   ・書類種別・発行／受領・タグ・案件No・OCR の設定は、全ファイルに共通で適用する
 *   ・表示名・取引先・通貨・税率・金額などは入力できない（登録後に1件ずつ編集する）。表示名は、OCR結果またはファイル名になる。
 *     通貨は円、税率は10%で登録される
 *   ・サーバーの負荷と実行時間を考え、1件ずつ順番に処理する（並列にはしない）
 *   ・サーバーがエラーを返したファイルがあっても、残りは続けて処理し、最後に失敗したファイルをまとめて知らせる。
 *     通信エラーのときは、その回の送信を止め、次の機会（通信の回復・起動・前面復帰・「今すぐ送信」）に続きから送る
 *
 * 【入力内容の自動保存】
 *   入力中の内容と選んだファイルは、12_upload_draft.js（UploadDraft）が端末内へ自動保存する。
 *   このファイルでは、保存のきっかけ（モーダルを開く・閉じる、ファイルを選び直す、登録を始める・終える）だけを呼び出す。
 *
 * 【読み込み順】05_list.js の後。
 * 【依存】02_state.js（pendingLinks）、03_utils.js（案件No入力・セレクト）、04_api_auth.js（apiCall・一覧の再取得）、
 *         12_upload_draft.js（UploadDraft）、13_send_queue.js（SendQueue）（どちらも実行時に呼ぶだけなので、読み込み順は問わない）
 *   ※ このファイルの fileToBase64・showUploadFailures は、13_send_queue.js からも呼ばれる。
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
  renderUseTypeSelectInto("uploadUseTypeId", "", "未設定（ファイル名から自動判定）");
  renderTagCheckboxesInto("uploadTagCheckboxes", []);
  document.getElementById("uploadUseOcr").checked = true; // モーダルを開くたびOCRオンから開始する
  renderUploadFileSummary();
  renderUploadFileList();
  refreshUploadDisplayNameState(); // 開いた直後は、ファイル未選択・紐付け案件無しなので、手入力できる状態に戻す
  applyUploadDetailLockState(); // OCRオン状態に合わせ、詳細項目を折りたたんでおく

  // 前回エラーで「登録中...」のまま残っていた場合に備え、送信ボタンを必ず初期状態に戻す
  const submitBtn = document.getElementById("createSubmitBtn");
  submitBtn.disabled = false;
  submitBtn.textContent = "登録する";

  document.getElementById("createModal").style.display = "flex";
  UploadDraft.onModalOpened(); // 前回の入力内容が端末に残っていれば、続きから再開できる案内を出す
};

// 案件の追加・解除のたびに、表示名を手入力できるか（紐付け案件無しのときだけ）を切り替える
document.getElementById("uploadProjectPicker").addEventListener("change", refreshUploadDisplayNameState);

window.closeCreateModal = function() {
  UploadDraft.flushSave(); // 閉じる直前の入力内容を、待たずに保存する（再度開くと続きから再開できる）
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
  renderUploadFileList();
  refreshUploadDisplayNameState();
  applyUploadDetailLockState();
  UploadDraft.onFilesChanged(); // 選んだファイルを、端末内へ保存し直す
};

/**
 * 表示名の入力欄の状態を、ファイル数と案件の紐付けに合わせて切り替える。
 *   ・複数ファイル　：1つの表示名を全ファイルに付けられないため、入力できない（OCR結果またはファイル名が表示名になる）
 *   ・案件に紐付け中：読み取り専用にして、案内文を出す（03_utils.js の applyDisplayNameLock）。
 *                     命名規則の名前は、登録後の「確定保存」のときに自動で入る（詳細モーダルと同じ）
 *   ・それ以外　　　：手入力できる（空欄ならOCR結果、OCRで取れなければファイル名）
 */
function refreshUploadDisplayNameState() {
  const isMultiple = getSelectedUploadFiles().length > 1;
  document.getElementById("uploadDisplayName").disabled = isMultiple;
  document.getElementById("uploadDisplayNameMultiNote").hidden = !isMultiple;
  applyDisplayNameLock(document.getElementById("uploadDisplayName"), pendingLinks.length > 0);
}

/** 選んでいるファイル名を1件ずつ、外すためのゴミ箱ボタンつきで表示する（0件なら何も出さない） */
function renderUploadFileList() {
  const files = getSelectedUploadFiles();
  document.getElementById("uploadFileList").innerHTML = files.length === 0 ? "" : files.map((file, index) => `
    <div class="upload-file-row">
      <span class="upload-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <button type="button" class="btn btn-danger-soft btn-sm" data-remove-index="${index}"
        title="このファイルを外す" aria-label="${escapeHtml(file.name)}を外す">
        <span class="material-symbols-outlined">delete</span>
      </button>
    </div>
  `).join("");
}

/**
 * 選択中のファイルから、指定した1件を外す。
 * ファイル選択欄の files は直接書き換えられないため、外すファイル以外で作り直した一覧（DataTransfer）に差し替える。
 * 差し替えただけでは change イベントが発生しないため、onUploadFilesChanged を呼んで表示と状態を更新する。
 */
function removeUploadFile(index) {
  const dataTransfer = new DataTransfer();
  getSelectedUploadFiles().forEach((file, i) => { if (i !== index) dataTransfer.items.add(file); });
  document.getElementById("uploadFileInput").files = dataTransfer.files;
  onUploadFilesChanged();
}

// ファイル名の一覧は描画のたびに作り直すため、ゴミ箱ボタンの操作は一覧の枠で1回だけ受け取る
document.getElementById("uploadFileList").addEventListener("click", (e) => {
  const removeButton = e.target.closest("[data-remove-index]");
  if (removeButton) removeUploadFile(Number(removeButton.dataset.removeIndex));
});

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
// ※ 表示名・書類種別・発行／受領・タグ・案件は詳細項目の外にあり、常に操作できる（表示名は、複数ファイルのときだけ入力できない）。
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

  // 二重送信防止：押した瞬間にボタンを無効化する（端末への保存が終わるまでの連打を防ぐ）
  const submitBtn = document.getElementById("createSubmitBtn");
  submitBtn.disabled = true;
  submitBtn.textContent = "保存中...";
  UploadDraft.pauseForSubmit(); // 登録中は、入力途中の下書きとしての自動保存を止める（最新の入力内容は、止める前に保存される）

  const isMultiple = files.length > 1;
  const useOcr = document.getElementById("uploadUseOcr").checked;
  const entryFields = collectUploadEntryFields(isMultiple, useOcr);
  const displayName = isMultiple ? "" : document.getElementById("uploadDisplayName").value.trim(); // 空ならファイル名が表示名になる
  const caseNos = pendingLinks.slice();

  // 【端末に保存】ファイルと入力内容を、送信キューとして端末に保存する。
  // ここまで成功すれば、通信が切れていても、ページが終了しても、ファイルは失われない。
  // 保存に失敗したとき（端末の空き容量不足など）は、入力内容を残したままエラーを知らせる。
  try {
    await SendQueue.enqueue({ files: files, entryFields: entryFields, displayName: displayName, caseNos: caseNos, useOcr: useOcr });
  } catch (err) {
    console.error("端末への保存に失敗しました:", err);
    UploadDraft.resumeAfterSubmitFailure();
    showErrorDialog(new Error("端末にファイルを保存できませんでした。端末の空き容量を確認してから、もう一度お試しください。（入力内容は残っています）"), "登録エラー");
    submitBtn.disabled = false;
    submitBtn.textContent = "登録する";
    return;
  }

  await UploadDraft.discardCurrent(); // 送信キューへ移したので、入力途中の下書きは不要
  closeCreateModal();
  showToast(navigator.onLine === false
    ? "オフラインのため端末に保存しました。通信が回復したら自動で送信します。"
    : "登録を受け付けました。送信を始めます。進み具合は一覧の上部に表示されます。");

  // 【送信】仮登録（1段目）→ Drive保存＋OCR（2段目）。1件ずつ順番に行う（13_send_queue.js）。
  // 通信できないときは何もしない（回復したら自動で送信される）。結果は、送信が終わったときに知らせる
  SendQueue.kick({ announce: true });
}
