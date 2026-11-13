/**
 * 12_upload_draft.js
 * 新規登録モーダルの「入力内容の自動保存・復元」。
 *
 * 【解決したい問題】入力の途中で、画面の切り替え・他のアプリへの移動・再読み込み・端末のメモリ不足による終了が起きると、
 *   メモリ上の入力内容が消える。このファイルは、入力中から端末内（IndexedDB）へ保存し続け、次に開いたとき続きから再開できるようにする。
 *   ※ 終了の直前に保存する方式には頼らない（強制終了では何も動かないため）。入力するたびに、少し待ってから保存する。
 *
 * 【保存するもの】入力欄の値・タグ・紐付け案件・OCRの設定、選んだファイル本体（写真など）。サーバーには何も送らない。
 *
 * 【保存の種類（id と state）】
 *   create-current … state "draft"  入力途中の下書き（常に1件。入力のたびに上書き）
 *   「登録する」を押すと、下書きは送信キュー（13_send_queue.js）へ移り、ここの下書きは消える（discardCurrent）。
 *   送信待ち・送信中・失敗の管理と、サーバーで保存できたあとの削除は、送信キューが行う。
 *   ※ 第1段階の版が作った state "submitting"／"failed" の保存データ（id が create-batch-…）が端末に残っている場合は、
 *     このファイルの案内（バナー）から「続きから再開」できる。新しい版では、これらは作られない（救済用）。
 *
 * 【復元の流れ】モーダルを開くと、保存データがあれば画面上部に案内（バナー）を出す。「続きから再開」か「破棄する」を選ぶ。
 *   案内を出している間は、自動保存を止める（保存済みのデータを、空の入力欄で上書きしないため）。
 *   案内は1回に1件。入力途中の下書きを先に、次に古い版が残した保存データ（新しい順）。
 *
 * 【依存】11_draft_store.js（DraftStore）、02_state.js（pendingLinks）、03_utils.js、06_upload.js、10_project_picker.js（projectPickers）
 *   ※ 06_upload.js から実行時に呼ばれる。読み込み順は、10 の後。
 */
const UploadDraft = (function () {
  // ---- 定数 ----
  const CURRENT_ID = "create-current";
  const STATE_DRAFT = "draft";
  const STATE_SUBMITTING = "submitting";
  const STATE_FAILED = "failed";
  const SAVE_DELAY_MS = 500; // 入力が止まってから保存するまでの待ち時間（入力のたびに書き込まないため）

  // ---- 状態 ----
  let saveTimer = null;
  let isPaused = false;           // true の間は自動保存しない（復元の案内中・登録処理中）
  let saveQueue = Promise.resolve(); // 保存庫への処理を、呼んだ順に1つずつ実行するための列
  let bannerRecord = null;        // 案内に出している保存データ
  let hasWarnedStorage = false;   // 容量不足の通知は、1回だけ出す
  let hasRequestedPersist = false;

  // =================================================================
  // 保存庫への処理（順番を守る）
  // =================================================================

  /**
   * 保存庫への処理を、前の処理が終わってから実行する。
   * 返す Promise は処理の失敗で reject される（結果が必要な呼び出し側は try/catch で受ける）。
   * 結果を待たない呼び出し側のために、失敗はここで記録するだけにして、次の処理は止めない。
   */
  function enqueue(task) {
    const run = saveQueue.then(task);
    saveQueue = run.catch(handleStoreError);
    return run;
  }

  function handleStoreError(err) {
    console.warn("入力内容の自動保存に失敗しました:", err);
    if (err && err.name === "QuotaExceededError" && !hasWarnedStorage) {
      hasWarnedStorage = true;
      showToast("端末の空き容量が足りないため、入力内容を自動保存できませんでした。");
    }
  }

  // =================================================================
  // フォームの内容 ⇔ 保存データ
  // =================================================================

  function isModalOpen() {
    return document.getElementById("createModal").style.display !== "none";
  }

  function getLoginUserName() {
    return document.getElementById("userDisplayLabel").textContent.trim();
  }

  /** 登録フォームの、いまの入力内容を集める（ファイル本体は含めない） */
  function collectFormValues() {
    const valueOf = (id) => document.getElementById(id).value;
    return {
      displayName: valueOf("uploadDisplayName"),
      issuedOrReceived: valueOf("uploadIssuedOrReceived"),
      useTypeId: valueOf("uploadUseTypeId"),
      tagIds: getCheckedTagIdsIn("uploadTagCheckboxes"),
      caseNos: pendingLinks.slice(),
      useOcr: document.getElementById("uploadUseOcr").checked,
      client: valueOf("uploadClient"),
      invoiceRegistrationNumber: valueOf("uploadInvoiceRegistrationNumber"),
      transactionDate: valueOf("uploadTransactionDate"),
      currency: valueOf("uploadCurrency"),
      taxRate: valueOf("uploadTaxRate"),
      amountExcl: getAmountInputValue("uploadAmountExcl"), // 数字（と小数点）だけの文字列
      amountIncl: getAmountInputValue("uploadAmountIncl"),
      description: valueOf("uploadDescription")
    };
  }

  /**
   * 保存する価値のある入力があるか。何も入力していない（開いただけの）状態は保存しない。
   * ※ OCRのオン／オフ・通貨・税率は、初期値との区別がつかないため、判定に含めない。
   */
  function hasMeaningfulInput(values, fileCount) {
    return fileCount > 0 || Boolean(
      values.displayName || values.issuedOrReceived || values.useTypeId ||
      values.tagIds.length || values.caseNos.length || values.client ||
      values.invoiceRegistrationNumber || values.transactionDate ||
      values.amountExcl || values.amountIncl || values.description
    );
  }

  /** 保存データを入力欄へ戻す。モーダルを開くとき（openCreateModal）と同じ順序で、表示まで整える */
  function applyFormValues(values, files) {
    const setValue = (id, value) => { document.getElementById(id).value = value || ""; };
    setValue("uploadDisplayName", values.displayName);
    setValue("uploadIssuedOrReceived", values.issuedOrReceived);
    renderUseTypeSelectInto("uploadUseTypeId", values.useTypeId || "", "未設定（ファイル名から自動判定）");
    renderTagCheckboxesInto("uploadTagCheckboxes", values.tagIds || []);
    document.getElementById("uploadUseOcr").checked = values.useOcr !== false;
    setValue("uploadClient", values.client);
    setValue("uploadInvoiceRegistrationNumber", values.invoiceRegistrationNumber);
    setValue("uploadTransactionDate", values.transactionDate);
    setValue("uploadDescription", values.description);
    // 通貨を先に入れてから金額を入れる（03_utils.js の setTaxInputValues が、その順で処理する）
    setTaxInputValues("uploadTaxRate", "uploadAmountExcl", "uploadAmountIncl", "uploadCurrency",
      values.currency, values.taxRate, values.amountExcl, values.amountIncl);

    pendingLinks.length = 0; // 同じ配列を直接書き換える（案件選択部品と共有しているため）
    (values.caseNos || []).forEach(caseNo => pendingLinks.push(caseNo));
    projectPickers.upload.render();

    // 選んでいたファイルを、ファイル選択欄へ戻す（個別に外すときの処理と同じ方法）
    const dataTransfer = new DataTransfer();
    files.forEach(file => dataTransfer.items.add(file));
    document.getElementById("uploadFileInput").files = dataTransfer.files;

    renderUploadFileSummary();
    renderUploadFileList();
    refreshUploadDisplayNameState(); // 案件を紐付けていれば、表示名を入力できなくする
    applyUploadDetailLockState();
  }

  // =================================================================
  // 自動保存（入力中の下書き）
  // =================================================================

  /** いまの入力内容を「入力途中の下書き」として保存する。withFiles が true のときは、ファイル本体も入れ替える */
  function persistCurrent(withFiles) {
    const values = collectFormValues();
    const files = getSelectedUploadFiles();
    return enqueue(async () => {
      if (!hasMeaningfulInput(values, files.length)) {
        await DraftStore.deleteDraft(CURRENT_ID); // 入力が全部消えたら、下書きも消す
        return;
      }
      if (withFiles) await DraftStore.replaceFiles(CURRENT_ID, files);
      await DraftStore.saveDraft(buildRecord(CURRENT_ID, STATE_DRAFT, values, files.length));
      if (!hasRequestedPersist) {
        hasRequestedPersist = true;
        DraftStore.requestPersistentStorage(); // 結果は待たない
      }
    });
  }

  function buildRecord(id, state, values, fileCount) {
    return {
      id: id,
      kind: "create",
      state: state,
      userName: getLoginUserName(), // 別の人がログインしたときに、他人の下書きを出さないため
      updatedAt: Date.now(),
      fileCount: fileCount,
      values: values
    };
  }

  function canAutoSave() {
    return !isPaused && isModalOpen();
  }

  /** 入力が止まってから保存する（入力のたびに呼ぶ） */
  function scheduleSave() {
    if (!canAutoSave()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (canAutoSave()) persistCurrent(false);
    }, SAVE_DELAY_MS);
  }

  /** 待たずに、いますぐ保存する（モーダルを閉じるとき・画面が隠れるとき。補助的な保存で、これだけには頼らない） */
  function flushSave() {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (canAutoSave()) persistCurrent(false);
  }

  /** ファイルの選択が変わったとき（ファイル本体も保存し直す。入力のたびではなく、変わったときだけ） */
  function onFilesChanged() {
    if (!canAutoSave()) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    persistCurrent(true);
  }

  // =================================================================
  // 登録ボタンを押したあと（06_upload.js の handleCreateSubmit から呼ばれる）
  // =================================================================

  /** 「登録する」を押した直後：下書きの自動保存を止める（最新の入力内容は、先に保存しておく） */
  function pauseForSubmit() {
    flushSave();
    isPaused = true;
  }

  /** 1件も登録できず、入力画面に戻るとき：自動保存を再開する */
  function resumeAfterSubmitFailure() {
    isPaused = false;
    scheduleSave();
  }

  /**
   * 送信キューへ移し終えたとき：入力途中の下書き（入力値とファイル）を、端末から消す。
   * ※ 失敗しても、登録そのものには影響しない（残った下書きは、次に開いたとき案内に出るだけ）。
   */
  async function discardCurrent() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      await enqueue(() => DraftStore.deleteDraft(CURRENT_ID));
    } catch (err) {
      console.warn("下書きの削除に失敗しました:", err);
    }
  }

  // =================================================================
  // 復元の案内（バナー）
  // =================================================================

  function getBannerElements() {
    return {
      banner: document.getElementById("uploadDraftBanner"),
      message: document.getElementById("uploadDraftBannerMessage")
    };
  }

  function hideBanner() {
    getBannerElements().banner.hidden = true;
    bannerRecord = null;
  }

  /** 案内の文面（状態ごとに、何が起きたかを分けて伝える） */
  function describeRecord(record) {
    const when = new Date(record.updatedAt).toLocaleString("ja-JP",
      { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const fileText = record.fileCount > 0 ? `・ファイル${record.fileCount}件` : "";
    if (record.state === STATE_SUBMITTING) { // 第1段階の版が残したデータ
      return `前回の登録が途中で中断された可能性があります（${when}${fileText}）。` +
        "一覧に登録済みのファイルがないか確認してから、続きを登録してください。";
    }
    if (record.state === STATE_FAILED) {
      return `前回、登録できなかったファイルが${record.fileCount}件あります（${when}）。続きから登録し直せます。`;
    }
    return `前回の入力内容が残っています（${when}${fileText}）。`;
  }

  /** 保存データがあれば案内を出す（入力途中の下書きを先に、次に登録に失敗・中断したデータを新しい順に） */
  async function checkForSavedData() {
    let records;
    try {
      records = await enqueue(() => DraftStore.listDrafts());
    } catch (err) {
      return; // 読めないときは何もしない（これまでどおり、空の入力画面で使える）
    }
    if (!isModalOpen()) return; // 読み込み中に閉じられた

    const userName = getLoginUserName();
    const mine = records.filter(record => record.kind === "create" && record.userName === userName);
    if (mine.length === 0) return;

    mine.sort((a, b) => b.updatedAt - a.updatedAt);
    const target = mine.find(record => record.id === CURRENT_ID) || mine[0];

    isPaused = true; // 案内に答えるまで、自動保存で上書きしない
    bannerRecord = target;
    const { banner, message } = getBannerElements();
    message.textContent = describeRecord(target);
    banner.hidden = false;
  }

  /** 「続きから再開」：保存データを入力欄へ戻す */
  async function onRestoreClicked() {
    const record = bannerRecord;
    if (!record) return;

    // 案内を出している間に、すでに入力を始めていた場合は、上書きして良いか確認する
    if (hasMeaningfulInput(collectFormValues(), getSelectedUploadFiles().length)) {
      const answer = await Swal.fire({
        title: "いまの入力内容は消えます",
        text: "保存されている内容で上書きして、続きから再開しますか？",
        icon: "warning",
        showCancelButton: true,
        confirmButtonText: "再開する",
        cancelButtonText: "キャンセル"
      });
      if (!answer.isConfirmed) return;
    }

    let files;
    try {
      const rows = await enqueue(() => DraftStore.getFiles(record.id));
      files = rows.map(row => row.file);
    } catch (err) {
      console.warn("保存したファイルを読み込めませんでした:", err);
      showToast("保存したファイルを読み込めませんでした。");
      return; // 保存データは消さない
    }

    applyFormValues(record.values, files);
    hideBanner();
    isPaused = false;
    if (files.length < record.fileCount) {
      showToast("一部のファイルを復元できませんでした。もう一度選び直してください。");
    }

    // 入力中の下書きとして保存し直し、元のデータ（登録中断・失敗分）は、保存できたあとに消す
    try {
      await persistCurrent(true);
      if (record.id !== CURRENT_ID) await enqueue(() => DraftStore.deleteDraft(record.id));
    } catch (err) {
      console.warn("復元した内容の保存し直しに失敗しました:", err); // 元のデータは残るので、失われない
    }
  }

  /** 「破棄する」：保存データを削除し、次の保存データがあれば続けて案内する */
  async function onDiscardClicked() {
    const record = bannerRecord;
    if (!record) return;

    const answer = await Swal.fire({
      title: "保存されている内容を破棄しますか？",
      text: "破棄すると元に戻せません。",
      icon: "warning",
      showCancelButton: true,
      confirmButtonColor: "#dc2626",
      confirmButtonText: "破棄する",
      cancelButtonText: "キャンセル"
    });
    if (!answer.isConfirmed) return;

    try {
      await enqueue(() => DraftStore.deleteDraft(record.id));
    } catch (err) {
      console.warn("保存データの削除に失敗しました:", err);
      showToast("保存データを削除できませんでした。");
      return;
    }
    hideBanner();
    isPaused = false;
    await checkForSavedData(); // 次の保存データがあれば、続けて案内する
  }

  // =================================================================
  // 外から呼ばれる入口
  // =================================================================

  /** 登録モーダルを開いたとき（06_upload.js の openCreateModal の最後で呼ぶ） */
  function onModalOpened() {
    hideBanner();
    isPaused = false; // 登録処理中で止まっていた自動保存も、ここで再開する
    checkForSavedData();
  }

  /** ログアウト時：端末に保存しているものを、すべて消す（共有の端末で、次の人に見えないようにするため） */
  async function clearAll() {
    clearTimeout(saveTimer);
    saveTimer = null;
    isPaused = true;
    try {
      await enqueue(() => DraftStore.clearAll());
    } catch (err) {
      console.warn("保存データの削除に失敗しました:", err);
    }
  }

  // ---- 起動時に1回だけ、イベントを登録する ----
  const form = document.getElementById("createForm");
  form.addEventListener("input", scheduleSave);   // 文字入力
  form.addEventListener("change", scheduleSave);  // 選択・チェック・案件の紐付け（案件選択部品も change を通知する）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave(); // 他のアプリへ移るとき（補助。保存の本体は入力中の保存）
  });
  window.addEventListener("pagehide", flushSave);
  document.getElementById("uploadDraftRestoreBtn").addEventListener("click", onRestoreClicked);
  document.getElementById("uploadDraftDiscardBtn").addEventListener("click", onDiscardClicked);

  return {
    onModalOpened, flushSave, onFilesChanged,
    pauseForSubmit, resumeAfterSubmitFailure, discardCurrent,
    clearAll
  };
})();
