/**
 * 13_send_queue.js
 * 送信キュー：登録するファイルをいったん端末に保存し、通信できるときに1件ずつサーバーへ送る。
 *
 * 【解決したい問題】登録の途中で通信が切れたり、ページが終了したりすると、ファイルが失われる・登録が重複する。
 *   ・「登録する」を押すと、まず端末（IndexedDB）に保存する。ここまで成功すれば、あとは通信やページの状態に左右されない。
 *   ・送信は、通信できるときに自動で行う。途中で止まっても、次の機会に続きから再開する。
 *   ・サーバーで保存できたことを確認してから、そのファイルを端末から外す。
 *
 * 【ファイル1件の状態（端末内のファイル行の status）】
 *   pending   … 送信待ち（通信待ち・順番待ち・再送待ち）
 *   uploading … 送信中
 *   failed    … 失敗（自動では再試行しない。画面の「今すぐ送信」で再試行する／「破棄」で外す）
 *   （uploaded）… サーバーで保存できたファイルは、端末から外すため、状態としては残らない
 *   ※ 入力途中の下書き（draft）は 12_upload_draft.js が別に持つ。「登録する」を押した時点で、ここ（pending）へ移る。
 *
 * 【ファイルの送り方（2段目）】ファイルの大きさで分ける。
 *   ・4MiB以下 … 1回の通信で送る（processBackgroundTasks。Drive保存＋OCR）
 *   ・4MiBより大きい … 分割して送る（16_分割アップロード.js）。4MiBずつDriveへ送り、通信が切れても、
 *       サーバーが受け取り済みの位置を確認して、途中から続ける。送り終えたら finalizeResumableUpload でOCRを行う。
 *       Driveへの接続（セッションURL）と、送り終えたファイルのIDは、端末に保存する（ページが終了しても、続きから再開できる）。
 *       途中まで進んでいた場合は、通信エラーでも「再試行の回数」に数えない（進み続けている限り、あきらめない）。
 *
 * 【二重登録の防止】ファイルごとに、端末で発行したUUID（clientKey）を持つ。
 *   ・1段目（仮登録）には、キー "app:<UUID>" を sourceKey として送る。サーバーは、同じキーの行が既にあれば、
 *     登録せずに既存の fileId・rowNumber を返す（通信が切れて応答だけ失われても、再送で二重登録にならない）。
 *   ・1段目の結果（fileId・rowNumber）は端末に保存する。再開するときは、1段目を飛ばして2段目から続ける。
 *   ・2段目（Drive保存＋OCR）は、サーバー側が、保存済み・処理中の重複呼び出しを成功として返す（既存の仕組み）。
 *
 * 【送信のきっかけ】登録した直後／アプリ起動時／通信の回復（online）／画面が前面に戻ったとき／「今すぐ送信」。
 *   ・自動の再試行は、通信エラー1回ごとに数え、3回に達したら failed にして手動待ちにする。
 *   ・通信エラーが起きたら、その回の送信は止める（通信が不安定なときに、続けて送り直さないため）。
 *   ・サーバーが返したエラー（仮登録の削除済みなど）は、再試行しても変わらないため、すぐ failed にして理由を表示する。
 *   ・ログインの有効期限切れは、状態を変えずに止める。ログインし直すと、続きから送信される。
 *   ・複数のタブで同時に送信しないよう、Web Locks で1つのタブだけが動く（非対応の端末は、サーバー側の重複防止に任せる）。
 *
 * 【ログインしているユーザー】自分の登録だけを扱う（共有の端末で、別の人の登録を送ってしまわないため）。
 *
 * 【依存】11_draft_store.js（DraftStore）、04_api_auth.js（apiCall）、03_utils.js（showToast・reloadAndRender）、
 *         06_upload.js（fileToBase64・showUploadFailures）、02_state.js（isAppInitialized・storage）
 *   ※ 画面（一覧上部の「未送信」の帯）は 14_send_queue_bar.js が、onChange で通知を受けて描画する。
 */
const SendQueue = (function () {
  // ---- 定数 ----
  const JOB_KIND = "send";
  const JOB_ID_PREFIX = "send-";
  const STATUS_PENDING = "pending";
  const STATUS_UPLOADING = "uploading";
  const STATUS_FAILED = "failed";
  const MAX_AUTO_ATTEMPTS = 3;     // 通信エラーでの自動再試行は、累計この回数まで
  const CHUNK_SIZE = 16 * 256 * 1024;       // 分割アップロード：1回に送るサイズ（4MiB）。Driveの単位（256KiB）の倍数にすること
  const SINGLE_POST_MAX_BYTES = CHUNK_SIZE; // これ以下のファイルは、分割せず1回で送る
  const MAX_SESSION_RESTARTS = 2;  // 分割アップロード：Driveの接続が無効になったとき、最初からやり直す回数の上限（1回の送信あたり）
  const MAX_RESYNC = 3;            // 分割アップロード：受け取り済みの位置が合わないとき、確認し直す回数の上限（1回の送信あたり）
  const SOURCE_KEY_PREFIX = "app:"; // Gmail取込のキー（"<メッセージID>#<番号>"）と区別する接頭辞
  const LOCK_NAME = "fs_send_queue";

  // ---- 状態 ----
  let entries = [];        // 端末に保存している、自分の送信待ち [{job, row}]（job：登録1回分の共通情報、row：ファイル1件）
  let isRunning = false;   // このページが送信中か
  let progress = null;     // 送信中の進み具合 {done, total}
  let fileProgress = null; // 分割アップロード中のファイルの進み具合 {fileName, sent, total}（画面表示用。端末には保存しない）
  let madeProgress = false; // いま送っているファイルが、今回の送信で、分割アップロードを1回分以上進められたか
  let isStarted = false;
  const listeners = [];

  function getLoginUserName() {
    return document.getElementById("userDisplayLabel").textContent.trim();
  }

  /** 送信できる状態か（通信できる・ログイン済み） */
  function canSend() {
    return navigator.onLine !== false && isAppInitialized && Boolean(storage.getItem("fs_login_token"));
  }

  function newClientKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  }

  function entryKey(entry) {
    return entry.job.id + "#" + entry.row.seq;
  }

  // =================================================================
  // 端末内のデータの読み込みと、画面への通知
  // =================================================================

  /** 自分の送信待ちを、登録した順・ファイルの順に読み込む（ファイルが1件も残っていない登録は、ここで片付ける） */
  async function readEntries() {
    const userName = getLoginUserName();
    const jobs = (await DraftStore.listDrafts())
      .filter(record => record.kind === JOB_KIND && record.userName === userName)
      .sort((a, b) => a.createdAt - b.createdAt);
    const result = [];
    for (const job of jobs) {
      const rows = await DraftStore.getFileRows(job.id);
      if (rows.length === 0) {
        await DraftStore.deleteDraft(job.id);
        continue;
      }
      rows.forEach(row => result.push({ job: job, row: row }));
    }
    return result;
  }

  async function refresh() {
    try {
      entries = await readEntries();
    } catch (err) {
      console.warn("送信待ちの読み込みに失敗しました:", err);
    }
    notify();
  }

  /** 画面が描画に使う、いまの状態 */
  function getState() {
    return {
      isRunning: isRunning,
      progress: progress ? { done: progress.done, total: progress.total } : null,
      fileProgress: fileProgress ? Object.assign({}, fileProgress) : null,
      isOnline: navigator.onLine !== false,
      items: entries.map(({ job, row }) => ({
        jobId: job.id,
        seq: row.seq,
        fileName: row.name,
        status: row.status,
        attempts: row.attempts || 0,
        lastError: row.lastError || "",
        hasServerRecord: Boolean(row.fileId) // 1段目（仮登録）まで済んでいるか
      }))
    };
  }

  /** 端末に残っている未送信のファイル数（ログアウト時の確認に使う） */
  function getUnsentCount() {
    return entries.length;
  }

  function onChange(listener) {
    listeners.push(listener);
  }

  function notify() {
    const state = getState();
    listeners.forEach(listener => {
      try { listener(state); } catch (err) { console.warn("送信キューの通知先でエラー:", err); }
    });
  }

  // =================================================================
  // 登録（端末への保存）
  // =================================================================

  /**
   * 登録するファイルを、端末に保存する（送信は kick で始める）。
   * 保存に失敗したら reject する（端末の空き容量不足など。呼び出し側は、入力内容を残したままエラーを知らせる）。
   * @param {{files: File[], entryFields: Object, displayName: string, caseNos: string[], useOcr: boolean}} params
   *   entryFields・displayName・caseNos は、1段目（仮登録）へ渡す項目。全ファイルに共通
   */
  async function enqueue(params) {
    const now = Date.now();
    const job = {
      id: JOB_ID_PREFIX + now + "-" + Math.random().toString(36).slice(2, 8),
      kind: JOB_KIND,
      userName: getLoginUserName(),
      createdAt: now,
      updatedAt: now,
      entryFields: params.entryFields,
      displayName: params.displayName,
      caseNos: params.caseNos,
      useOcr: params.useOcr
    };
    const items = params.files.map(file => ({
      file: file,
      meta: {
        status: STATUS_PENDING,
        clientKey: newClientKey(),
        fileId: "",       // 1段目（仮登録）が済んだら入る
        rowNumber: 0,
        uploadUri: "",    // 分割アップロードのDriveの接続（セッションURL）。大きなファイルで、送り始めたら入る
        driveFileId: "",  // 分割アップロードが完了したら入る（OCRなどの確定処理が残っている状態）
        attempts: 0,
        lastError: "",
        updatedAt: now
      }
    }));
    await DraftStore.saveJobWithFiles(job, items);
    await refresh();
    return job.id;
  }

  // =================================================================
  // 送信
  // =================================================================

  /** 送信を始める（待たずに戻る）。すでに送信中・通信できないときは何もしない */
  function kick(options) {
    run(options || {}).catch(err => console.warn("送信キューの実行に失敗しました:", err));
  }

  /** 別のタブが送信中のときは動かない（Web Locks 非対応の端末では、そのまま動く） */
  function withCrossTabLock(task) {
    if (!navigator.locks || typeof navigator.locks.request !== "function") return task();
    return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, lock => (lock ? task() : undefined));
  }

  async function run(options) {
    if (isRunning || !canSend()) {
      notify();
      return;
    }
    isRunning = true;
    notify();
    try {
      await withCrossTabLock(() => runLocked(options));
    } finally {
      isRunning = false;
      progress = null;
      fileProgress = null;
      await refresh();
    }
  }

  /** 送信待ちのファイルを、1件ずつ順番に送る（並列にはしない。サーバーの負荷と実行時間のため） */
  async function runLocked(options) {
    const summary = { succeeded: 0, inProgress: 0, failures: [], touched: false };

    // 前のページが送信中に終了した場合に備え、「送信中」のまま残っているものを、送信待ちに戻す
    entries = await readEntries();
    for (const entry of entries.filter(e => e.row.status === STATUS_UPLOADING)) {
      await DraftStore.patchFile(entry.job.id, entry.row.seq, { status: STATUS_PENDING });
    }
    entries = await readEntries();

    const isTarget = entry => entry.row.status === STATUS_PENDING;
    progress = { done: 0, total: entries.filter(isTarget).length };
    notify();

    const tried = new Set(); // この回で試したもの（同じファイルを、この回のうちに繰り返し送らない）
    while (true) {
      const target = entries.find(entry => isTarget(entry) && !tried.has(entryKey(entry)));
      if (!target) break;
      tried.add(entryKey(target));
      const outcome = await processEntry(target, summary);
      progress.done++;
      entries = await readEntries();
      notify();
      if (outcome === "stop") break;
    }

    if (summary.touched) {
      try { await reloadAndRender(); } catch (err) { console.warn("一覧の更新に失敗しました:", err); }
    }
    announce(summary, options);
  }

  /**
   * ファイル1件を送る。1段目が済んでいなければ仮登録し、続けて2段目（Drive保存＋OCR）を行う。
   * @return {"next"|"stop"} stop：この回の送信を止める（通信エラー・ログイン切れ）
   */
  async function processEntry(entry, summary) {
    const job = entry.job;
    const row = entry.row;
    const patch = fields => DraftStore.patchFile(job.id, row.seq, Object.assign({ updatedAt: Date.now() }, fields));

    madeProgress = false;
    await patch({ status: STATUS_UPLOADING });
    entries = await readEntries(); // 画面に「送信中」を出す
    notify();

    try {
      let fileId = row.fileId;
      let rowNumber = row.rowNumber;

      // 【1段目】仮登録（軽量）。端末で発行したキーを付けるので、再送しても二重登録にならない
      if (!fileId) {
        const created = await apiCall("createRecordSheetOnly", {
          fData: Object.assign({
            fileName: row.name,
            mimeType: row.type,
            displayName: job.displayName,
            caseNos: job.caseNos,
            sourceKey: SOURCE_KEY_PREFIX + row.clientKey
          }, job.entryFields)
        });
        if (!created || !created.fileId) {
          // 古いサーバー（重複時に fileId を返さない版）のままの場合
          throw makeServerError("サーバーの更新（GASの再デプロイ）が必要です。管理者にお知らせください。");
        }
        fileId = created.fileId;
        rowNumber = created.rowNumber;
        summary.touched = true;
        await patch({ fileId: fileId, rowNumber: rowNumber }); // ここまで済んだことを端末に残す（再開時に1段目を飛ばせる）
      }

      // 【2段目】Drive保存＋OCR（重い処理）
      const result = await sendFileBody(entry, fileId, rowNumber, patch);
      if (result && result.inProgress) summary.inProgress++;

      // サーバーで保存できたことを確認できたので、端末から外す
      await DraftStore.removeFile(job.id, row.seq);
      summary.succeeded++;
      summary.touched = true;
      return "next";
    } catch (err) {
      return handleFailure(entry, err, summary, patch);
    }
  }

  /** 2段目：ファイルの中身をDriveへ保存し、OCRを行う。大きさで、送り方を分ける */
  async function sendFileBody(entry, fileId, rowNumber, patch) {
    const job = entry.job;
    const row = entry.row;
    const file = DraftStore.rowToFile(row);

    if (file.size <= SINGLE_POST_MAX_BYTES) {
      return apiCall("processBackgroundTasks", {
        fData: {
          fileId: fileId, rowNumber: rowNumber,
          base64: await fileToBase64(file), mimeType: row.type, fileName: row.name, useOcr: job.useOcr
        }
      });
    }

    const driveFileId = await uploadInChunks(row, file, fileId, rowNumber, patch);
    return apiCall("finalizeResumableUpload", {
      fData: {
        fileId: fileId, rowNumber: rowNumber, driveFileId: driveFileId,
        fileName: row.name, mimeType: row.type, useOcr: job.useOcr
      }
    });
  }

  /**
   * 大きなファイルを、4MiBずつDriveへ送る。中断したときは、サーバーが受け取り済みの位置を確認して、そこから続ける。
   * （通信エラーのときは、送った分が届いたか分からないため、端末の記録ではなく、必ずサーバーに確認する）
   * @return {Promise<string>} DriveのファイルID（送り終えたもの）
   */
  async function uploadInChunks(row, file, fileId, rowNumber, patch) {
    if (row.driveFileId) return row.driveFileId; // 送信は完了済み（OCRなどの確定処理だけが残っていた）

    const total = file.size;
    let uploadUri = row.uploadUri || "";
    let needsStatusCheck = Boolean(uploadUri); // 前回の続きのときは、受け取り済みの位置を確認してから始める
    let offset = 0;
    let restarts = 0;
    let resyncs = 0;
    let driveFileId = "";
    const showProgress = sent => { fileProgress = { fileName: row.name, sent: sent, total: total }; notify(); };
    const communicationError = message => new Error(message); // isServerError を付けない＝通信エラーとして、次の機会に再試行される

    try {
      while (!driveFileId) {
        // Driveの接続（セッション）が無ければ作る
        if (!uploadUri) {
          const started = await apiCall("startResumableUpload", {
            fData: { fileId: fileId, rowNumber: rowNumber, fileName: row.name, mimeType: row.type, size: total }
          });
          uploadUri = started.uploadUri;
          offset = 0;
          needsStatusCheck = false;
          await patch({ uploadUri: uploadUri }); // 端末に残す（ページが終了しても、続きから再開できる）
        }

        // 再開のとき：Driveが実際に受け取っている位置を確認する
        if (needsStatusCheck) {
          needsStatusCheck = false;
          const status = await apiCall("getUploadStatus", { fData: { uploadUri: uploadUri, size: total } });
          if (status.status === "complete") { driveFileId = status.driveFileId; break; }
          if (status.status === "incomplete") { offset = status.receivedBytes; }
          else if (status.status === "expired") {
            if (++restarts > MAX_SESSION_RESTARTS) throw communicationError("Driveとの接続が切れました。しばらくしてからもう一度お試しください。");
            uploadUri = ""; // 接続が無効になっていた。最初からやり直す
            await patch({ uploadUri: "" });
            continue;
          } else {
            throw communicationError("Driveの状態を確認できませんでした。");
          }
        }

        // 1回分を送る
        showProgress(offset);
        const end = Math.min(offset + CHUNK_SIZE, total);
        const result = await apiCall("uploadChunk", {
          fData: { uploadUri: uploadUri, offset: offset, size: total, base64: await fileToBase64(file.slice(offset, end)) }
        });

        if (result.status === "complete") {
          driveFileId = result.driveFileId;
          madeProgress = true;
        } else if (result.status === "incomplete") {
          if (result.receivedBytes <= offset) throw communicationError("アップロードが進みませんでした。");
          offset = result.receivedBytes;
          madeProgress = true;
        } else if (result.status === "resync") {
          if (++resyncs > MAX_RESYNC) throw communicationError("アップロードの位置を合わせられませんでした。");
          needsStatusCheck = true; // 位置がずれた。Driveに聞き直してから続ける
        } else if (result.status === "expired") {
          if (++restarts > MAX_SESSION_RESTARTS) throw communicationError("Driveとの接続が切れました。しばらくしてからもう一度お試しください。");
          uploadUri = "";
          await patch({ uploadUri: "" });
        } else {
          throw communicationError(`Driveが一時的に応答しません。（HTTP ${result.httpCode || "不明"}）`);
        }
      }
    } finally {
      fileProgress = null;
    }

    showProgress(total);
    fileProgress = null;
    await patch({ driveFileId: driveFileId }); // 送り終えたことを端末に残す（このあとの確定処理だけを、やり直せるようにする）
    return driveFileId;
  }

  function makeServerError(message) {
    const error = new Error(message);
    error.isServerError = true;
    return error;
  }

  /** 失敗の種類に応じて、状態を決める */
  async function handleFailure(entry, err, summary, patch) {
    const row = entry.row;
    const message = (err && err.message) || "原因不明のエラー";

    // ログインの有効期限切れ：状態は変えない（再ログインの案内は apiCall 側が出す）。ログインし直すと続きから送信される
    if (err && err.code === "AUTH_EXPIRED") {
      await patch({ status: STATUS_PENDING });
      return "stop";
    }

    const attempts = (row.attempts || 0) + 1;

    // サーバーが返したエラー：再試行しても結果が変わらないため、自動では再試行しない
    if (err && err.isServerError) {
      await patch({ status: STATUS_FAILED, attempts: attempts, lastError: message });
      summary.failures.push({ fileName: row.name, message: message });
      return "next";
    }

    // 通信エラー（タイムアウト・HTTPエラーなど）：回数に達するまで、次の機会に自動で再試行する
    // 分割アップロードが1回分以上進んでいたときは、回数に数えない（進み続けている限り、次の機会に続きから送る）
    const countedAttempts = madeProgress ? 0 : attempts;
    const isFinal = countedAttempts >= MAX_AUTO_ATTEMPTS;
    await patch({ status: isFinal ? STATUS_FAILED : STATUS_PENDING, attempts: countedAttempts, lastError: message });
    if (isFinal) summary.failures.push({ fileName: row.name, message: message });
    return "stop";
  }

  /** 送信が終わったときの通知。登録した直後の送信（announce）は結果を知らせ、自動の送信は静かに終える */
  function announce(summary, options) {
    if (summary.succeeded === 0 && summary.failures.length === 0) return;

    if (summary.failures.length > 0) {
      if (options.announce) {
        const title = summary.succeeded > 0 ? "一部のファイルでエラーが発生しました" : "登録エラー";
        showUploadFailures(summary.failures, summary.failures.length > 1, title);
      }
      return; // 自動の送信での失敗は、一覧上部の帯で確認できる
    }
    if (summary.inProgress > 0) {
      showToast(`処理が完了しました。（${summary.inProgress}件は別の処理が実行中です。完了後に一覧を更新してください）`);
    } else if (options.announce) {
      showToast(summary.succeeded > 1 ? `${summary.succeeded}件の処理が完了しました。` : "処理が完了しました。");
    } else {
      showToast(`未送信だったファイル${summary.succeeded}件を送信しました。`);
    }
  }

  // =================================================================
  // 画面からの操作
  // =================================================================

  /** 「今すぐ送信」：失敗して止まっているものも、送信待ちに戻して送り直す（再試行の回数も0に戻す） */
  async function retryAll() {
    if (!canSend()) {
      showToast(navigator.onLine === false
        ? "通信できません。通信が回復したら自動で送信します。"
        : "いまは送信できません。しばらくしてからお試しください。");
      return;
    }
    for (const entry of entries.filter(e => e.row.status === STATUS_FAILED)) {
      await DraftStore.patchFile(entry.job.id, entry.row.seq, { status: STATUS_PENDING, attempts: 0, lastError: "" });
    }
    await refresh();
    kick({ announce: true });
  }

  /** 端末に保存しているファイルを1件外す（送信しない）。確認ダイアログは呼び出し側が出す */
  async function discardItem(jobId, seq) {
    await DraftStore.removeFile(jobId, seq);
    await refresh();
  }

  /** 起動時に1回だけ呼ぶ（ログインして画面を表示したあと）。端末に残っている送信待ちを読み込み、送信を始める */
  function start() {
    if (!isStarted) {
      isStarted = true;
      window.addEventListener("online", () => { notify(); kick({}); });
      window.addEventListener("offline", notify);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") kick({});
      });
    }
    refresh().then(() => kick({}));
  }

  return { start, kick, enqueue, retryAll, discardItem, getState, getUnsentCount, onChange };
})();
