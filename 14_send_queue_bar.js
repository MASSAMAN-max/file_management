/**
 * 14_send_queue_bar.js
 * 一覧画面の上部に出す「未送信」の帯（送信キューの状況表示）。
 *
 * 【画面】未送信のファイルがあるときだけ表示する。
 *   ・1行目：状況（送信中 2/5件／通信できません…／未送信 3件（失敗 1件））と、「詳細」「今すぐ送信」ボタン
 *   ・「詳細」を押すと、ファイルごとの状態と理由を一覧する。失敗したファイルは「破棄」で端末から外せる
 * 【仕組み】SendQueue.onChange の通知を受けて描画するだけ。送信の判断・状態の管理は 13_send_queue.js が持つ。
 * 【依存】13_send_queue.js（SendQueue）、03_utils.js（showToast）、index.html の #sendQueueBar
 */
(function () {
  const barEl = document.getElementById("sendQueueBar");
  const textEl = document.getElementById("sendQueueText");
  const detailBtn = document.getElementById("sendQueueDetailBtn");
  const retryBtn = document.getElementById("sendQueueRetryBtn");
  const listEl = document.getElementById("sendQueueList");

  let isDetailOpen = false;

  /** ファイル1件の状態の表示（詳細の一覧用） */
  function describeStatus(item) {
    if (item.status === "uploading") return "送信中";
    if (item.status === "failed") return "失敗";
    return item.attempts > 0 ? `再送待ち（通信エラー${item.attempts}回）` : "送信待ち";
  }

  /** 帯の1行目の文章 */
  function buildSummaryText(state) {
    const total = state.items.length;
    const failedCount = state.items.filter(item => item.status === "failed").length;
    if (state.isRunning && state.progress && state.progress.total > 0) {
      const current = Math.min(state.progress.done + 1, state.progress.total);
      // 大きなファイルは、分割して送るため、進み具合（％）も出す
      const percent = state.fileProgress && state.fileProgress.total > 0
        ? `（${Math.floor(state.fileProgress.sent * 100 / state.fileProgress.total)}%）` : "";
      return `送信中… ${current}/${state.progress.total}件${percent}（画面を閉じても、端末に保存されているので失われません）`;
    }
    if (!state.isOnline) {
      return `通信できません。未送信の${total}件を端末に保存しています。通信が回復したら自動で送信します。`;
    }
    return `未送信 ${total}件` + (failedCount > 0 ? `（失敗 ${failedCount}件）` : "");
  }

  /** 詳細の一覧を作る（ファイル名・理由は textContent で入れる。画面を壊す文字が入っていても、そのまま表示される） */
  function renderList(state) {
    listEl.textContent = "";
    state.items.forEach(item => {
      const row = document.createElement("div");
      row.className = "send-queue-row";

      const head = document.createElement("div");
      head.className = "send-queue-row-head";
      const name = document.createElement("span");
      name.className = "send-queue-row-name";
      name.textContent = item.fileName;
      const status = document.createElement("span");
      status.className = "send-queue-row-status" + (item.status === "failed" ? " is-failed" : "");
      status.textContent = describeStatus(item);
      head.appendChild(name);
      head.appendChild(status);
      row.appendChild(head);

      if (item.lastError) {
        const reason = document.createElement("div");
        reason.className = "send-queue-row-reason";
        reason.textContent = item.lastError;
        row.appendChild(reason);
      }
      if (item.status === "failed") {
        const discard = document.createElement("button");
        discard.type = "button";
        discard.className = "btn btn-danger-soft btn-sm";
        discard.textContent = "破棄";
        discard.addEventListener("click", () => confirmDiscard(item));
        row.appendChild(discard);
      }
      listEl.appendChild(row);
    });
  }

  function render(state) {
    const hasItems = state.items.length > 0;
    barEl.hidden = !hasItems;
    if (!hasItems) {
      isDetailOpen = false; // 全部送り終えたら、次に出るときは閉じた状態から
      return;
    }
    barEl.classList.toggle("has-failed", state.items.some(item => item.status === "failed"));
    textEl.textContent = buildSummaryText(state);
    retryBtn.disabled = state.isRunning;
    detailBtn.textContent = isDetailOpen ? "閉じる" : "詳細";
    listEl.hidden = !isDetailOpen;
    if (isDetailOpen) renderList(state);
  }

  /** 失敗したファイルを端末から外す（確認あり）。1段目まで済んでいる場合は、サーバーに仮登録の行が残ることを伝える */
  async function confirmDiscard(item) {
    const answer = await Swal.fire({
      icon: "warning",
      title: "このファイルを破棄しますか？",
      text: item.hasServerRecord
        ? `「${item.fileName}」は端末から削除され、送信されません。サーバー側に仮登録の行が残っている場合は、一覧で確認し、不要ならゴミ箱へ移動してください。`
        : `「${item.fileName}」は端末から削除され、送信されません。元に戻せません。`,
      showCancelButton: true,
      confirmButtonColor: "#dc2626",
      confirmButtonText: "破棄する",
      cancelButtonText: "キャンセル"
    });
    if (!answer.isConfirmed) return;
    try {
      await SendQueue.discardItem(item.jobId, item.seq);
    } catch (err) {
      console.warn("破棄に失敗しました:", err);
      showToast("破棄できませんでした。");
    }
  }

  detailBtn.addEventListener("click", () => {
    isDetailOpen = !isDetailOpen;
    render(SendQueue.getState());
  });
  retryBtn.addEventListener("click", () => SendQueue.retryAll());
  SendQueue.onChange(render);
})();
