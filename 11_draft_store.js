/**
 * 11_draft_store.js
 * 入力途中のデータを、端末の IndexedDB に保存・取得・削除する「保存庫」。
 *
 * 【役割】フォームの入力値と、選んだファイル（写真など）を端末内に置く。
 *         画面（フォーム）の中身は知らない。「何を保存するか」は呼び出し側が決める。
 *           ・12_upload_draft.js … 入力途中の下書き
 *           ・13_send_queue.js   … 送信待ちのファイル（ファイル行に status・clientKey・fileId などの項目を足して使う）
 * 【なぜ IndexedDB か】localStorage は文字列のみ・容量が小さい（目安5MB）ため、写真（Blob）を保存できない。
 *         IndexedDB は、ファイルをそのまま保存できる。
 * 【保存の構造】
 *   drafts     … 入力データ1件につき1行（キー：id）。入力値・状態・更新日時などの軽いデータ
 *   draftFiles … ファイル1つにつき1行（キー："<draftId>#<連番>"）。ファイル本体（重いデータ）はここに分けて置く
 *   ファイルを分けるのは、1文字入力するたびに写真まで書き直さないため。
 * 【方針】
 *   ・すべて Promise を返し、失敗したら reject する（呼び出し側が try/catch で扱う。保存に失敗しても画面の操作は止めない）
 *   ・書き込みは、トランザクションの完了（oncomplete）を待ってから成功とする
 *     （「保存できたと思ったのに、端末には無かった」を防ぐため）
 * 【依存】なし（単独で動く）
 */
const DraftStore = (function () {
  const DB_NAME = "fs_drafts";
  const DB_VERSION = 1;
  const STORE_DRAFTS = "drafts";
  const STORE_FILES = "draftFiles";

  let dbPromise = null; // 接続は1回だけ開いて使い回す

  /** データベースを開く（無ければ作る） */
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("この端末ではIndexedDBが使えません。"));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_DRAFTS, { keyPath: "id" });
        request.result.createObjectStore(STORE_FILES, { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        // 他のタブが新しい版へ更新するときや、ブラウザに接続を閉じられたときは、次回あらためて開き直す
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("保存庫を開けませんでした（他のタブが使用中です）。"));
    });
    dbPromise.catch(() => { dbPromise = null; }); // 開けなかったときは、次回もう一度開こうとする
    return dbPromise;
  }

  /**
   * トランザクションを1つ実行する。
   * @param {string[]} storeNames 使うストア名
   * @param {"readonly"|"readwrite"} mode
   * @param {function(Object):*} work ストア名をキーにした { drafts, draftFiles } を受け取る。
   *        IDBRequest を返すと、その結果が戻り値になる。
   */
  function runTransaction(storeNames, mode, work) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = (e) => reject((e.target && e.target.error) || tx.error);
      tx.onabort = () => reject(tx.error || new Error("保存を中止しました。"));
      try {
        const stores = {};
        storeNames.forEach(name => { stores[name] = tx.objectStore(name); });
        const returned = work(stores);
        if (typeof IDBRequest !== "undefined" && returned instanceof IDBRequest) {
          returned.onsuccess = () => { result = returned.result; };
        } else {
          result = returned;
        }
      } catch (err) {
        try { tx.abort(); } catch (ignore) { /* すでに終了している場合は何もしない */ }
        reject(err);
      }
    }));
  }

  // ---- ファイル行のキー ----
  /** あるデータに属するファイル行を、まとめて指す範囲（"<draftId>#" で始まるキー全部） */
  function fileKeyRange(draftId) {
    return IDBKeyRange.bound(draftId + "#", draftId + "#\uffff");
  }
  function fileKey(draftId, seq) {
    return draftId + "#" + seq;
  }

  // =================================================================
  // 入力データ（軽いデータ）
  // =================================================================

  /** 入力データを1件保存する（同じ id があれば上書き）。record は { id, ... } の形 */
  function saveDraft(record) {
    return runTransaction([STORE_DRAFTS], "readwrite", s => { s[STORE_DRAFTS].put(record); });
  }

  /** 入力データを1件取得する（無ければ undefined） */
  function getDraft(id) {
    return runTransaction([STORE_DRAFTS], "readonly", s => s[STORE_DRAFTS].get(id));
  }

  /** 入力データをすべて取得する */
  function listDrafts() {
    return runTransaction([STORE_DRAFTS], "readonly", s => s[STORE_DRAFTS].getAll());
  }

  /** 入力データ1件を、ファイルも含めて削除する */
  function deleteDraft(id) {
    return runTransaction([STORE_DRAFTS, STORE_FILES], "readwrite", s => {
      s[STORE_DRAFTS].delete(id);
      s[STORE_FILES].delete(fileKeyRange(id));
    });
  }

  /** 保存しているものを、すべて削除する（ログアウト時） */
  function clearAll() {
    return runTransaction([STORE_DRAFTS, STORE_FILES], "readwrite", s => {
      s[STORE_DRAFTS].clear();
      s[STORE_FILES].clear();
    });
  }

  // =================================================================
  // ファイル（重いデータ）
  // =================================================================

  /**
   * あるデータのファイルを、まとめて入れ替える（連番は files の並び順。0から）。
   * 1つのトランザクションなので、途中で止まっても「古いまま」か「新しいまま」のどちらかになる。
   * @param {string} draftId
   * @param {File[]} files
   */
  function replaceFiles(draftId, files) {
    return runTransaction([STORE_FILES], "readwrite", s => {
      s[STORE_FILES].delete(fileKeyRange(draftId));
      files.forEach((file, seq) => {
        s[STORE_FILES].put({
          key: fileKey(draftId, seq),
          draftId: draftId,
          seq: seq,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          blob: file
        });
      });
    });
  }

  /**
   * あるデータのファイル行を、連番の順に取り出す（ファイル本体は Blob のまま。状態などの項目も含む）。
   * @return {Promise<Object[]>}
   */
  function getFileRows(draftId) {
    return runTransaction([STORE_FILES], "readonly", s => s[STORE_FILES].getAll(fileKeyRange(draftId)))
      .then(rows => rows.sort((a, b) => a.seq - b.seq));
  }

  /** ファイル行から、File オブジェクトを作る（名前・種類・更新日時を元どおりにする） */
  function rowToFile(row) {
    return new File([row.blob], row.name, { type: row.type, lastModified: row.lastModified });
  }

  /**
   * あるデータのファイルを、連番の順に取り出す。
   * @return {Promise<Array<{seq: number, file: File}>>}
   */
  function getFiles(draftId) {
    return getFileRows(draftId).then(rows => rows.map(row => ({ seq: row.seq, file: rowToFile(row) })));
  }

  /** あるデータに残っているファイルの数（ファイル本体は読み込まない） */
  function countFiles(draftId) {
    return runTransaction([STORE_FILES], "readonly", s => s[STORE_FILES].count(fileKeyRange(draftId)));
  }

  /** あるデータのファイルを、連番を指定して1つ外す（登録が終わったファイルを、端末から外すときに使う） */
  function removeFile(draftId, seq) {
    return runTransaction([STORE_FILES], "readwrite", s => { s[STORE_FILES].delete(fileKey(draftId, seq)); });
  }

  // =================================================================
  // 送信待ち（13_send_queue.js が使う）
  // =================================================================

  /**
   * 送信待ちの1件（job）と、そのファイル行を、1つのトランザクションで保存する。
   * （「jobだけ保存された」「ファイルだけ保存された」状態を作らないため）
   * @param {Object} job { id, ... }
   * @param {Array<{file: File, meta: Object}>} items meta は、ファイル行へそのまま足す項目（状態・clientKey など）
   */
  function saveJobWithFiles(job, items) {
    return runTransaction([STORE_DRAFTS, STORE_FILES], "readwrite", s => {
      s[STORE_DRAFTS].put(job);
      items.forEach((item, seq) => {
        s[STORE_FILES].put(Object.assign({
          key: fileKey(job.id, seq),
          draftId: job.id,
          seq: seq,
          name: item.file.name,
          type: item.file.type,
          lastModified: item.file.lastModified,
          blob: item.file
        }, item.meta));
      });
    });
  }

  /**
   * ファイル行の一部の項目だけを書き換える（読み出しと書き込みを1つのトランザクションで行う）。
   * すでに外されている行なら、何もしない。
   */
  function patchFile(draftId, seq, patch) {
    return runTransaction([STORE_FILES], "readwrite", s => {
      const request = s[STORE_FILES].get(fileKey(draftId, seq));
      request.onsuccess = () => {
        if (request.result) s[STORE_FILES].put(Object.assign({}, request.result, patch));
      };
    });
  }

  // =================================================================
  // 保存データの保護
  // =================================================================

  /**
   * ブラウザに「この保存データは、端末の空き容量が少なくなっても自動で消さないで」と頼む。
   * 許可されるかはブラウザ次第（拒否されても、保存・復元はそのまま使える）。
   */
  function requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
    return navigator.storage.persist().catch(() => false);
  }

  return {
    saveDraft, getDraft, listDrafts, deleteDraft, clearAll,
    replaceFiles, getFiles, getFileRows, rowToFile, countFiles, removeFile,
    saveJobWithFiles, patchFile,
    requestPersistentStorage
  };
})();
