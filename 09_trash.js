/**
 * =====================================================================
 * 09_trash.js：ゴミ箱・削除済みファイル（管理者専用）
 * =====================================================================
 * 【役割】
 *   ゴミ箱（30日以内）の表示と復元、削除済みファイルの表示と復元（管理者専用）
 *
 * 【読み込み順】最後。
 * 【依存】02_state.js、03_utils.js（bindListAction・escapeHtml）、04_api_auth.js
 */

// =================================================================
// ゴミ箱（S07・一般ユーザー向け・30日以内）
// =================================================================
window.openTrashModal = async function() {
  document.getElementById("trashListArea").innerHTML = "読み込み中...";
  document.getElementById("trashModal").style.display = "flex";
  try {
    const data = await apiCall("loadTrashList");
    renderTrashList(data.trashList || []);
  } catch (err) {
    document.getElementById("trashListArea").innerHTML = `<p style="color:#dc2626;">${escapeHtml(err.message)}</p>`;
  }
};

window.closeTrashModal = function() {
  document.getElementById("trashModal").style.display = "none";
};

function renderTrashList(trashList) {
  const area = document.getElementById("trashListArea");
  if (trashList.length === 0) {
    area.innerHTML = '<p style="color:#94a3b8; font-size:14px;">ゴミ箱は空です。</p>';
    return;
  }
  area.innerHTML = trashList.map(r => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 4px; border-bottom:1px solid #f1f5f9;">
      <div>
        <div style="font-weight:bold;">${escapeHtml(r["表示名"] || r["ファイル名"])}</div>
        <div style="font-size:12px; color:#94a3b8;">残り${escapeHtml(r["残り日数"])}日で「削除済み」へ移動します（以降は管理者のみ復元できます）</div>
      </div>
      <button class="btn btn-primary btn-sm" data-id="${escapeHtml(r["ファイルID"])}" data-row="${escapeHtml(r["_rowNumber"])}">復元</button>
    </div>
  `).join('');
}

bindListAction("trashListArea", (d) => handleRestoreFromTrash(d.id, Number(d.row)));

window.handleRestoreFromTrash = async function(fileId, rowNumber) {
  document.getElementById("trashListArea").innerHTML = "復元中...";
  try {
    await apiCall("restoreFromTrash", { fData: { fileId, rowNumber } });
    await reloadAndRender();
    await openTrashModal(); // ゴミ箱一覧を最新化（復元済みファイルが消えたことを確認できるようにする）
    showToast("復元しました。");
  } catch (err) {
    showErrorDialog(err);
    await openTrashModal();
  }
};

// =================================================================
// 削除済みファイル管理（S12・管理者専用）
// =================================================================
window.openDeletedFilesModal = async function() {
  document.getElementById("deletedFilesListArea").innerHTML = "読み込み中...";
  document.getElementById("deletedFilesModal").style.display = "flex";
  try {
    const data = await apiCall("loadDeletedFiles");
    renderDeletedFilesList(data.deletedFiles || []);
  } catch (err) {
    document.getElementById("deletedFilesListArea").innerHTML = `<p style="color:#dc2626;">${escapeHtml(err.message)}</p>`;
  }
};

window.closeDeletedFilesModal = function() {
  document.getElementById("deletedFilesModal").style.display = "none";
};

function renderDeletedFilesList(deletedFiles) {
  const area = document.getElementById("deletedFilesListArea");
  if (deletedFiles.length === 0) {
    area.innerHTML = '<p style="color:#94a3b8; font-size:14px;">削除済みファイルはありません。</p>';
    return;
  }
  area.innerHTML = deletedFiles.map(r => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 4px; border-bottom:1px solid #f1f5f9;">
      <div style="font-weight:bold;">${escapeHtml(r["表示名"] || r["ファイル名"])}</div>
      <button class="btn btn-primary btn-sm" data-id="${escapeHtml(r["ファイルID"])}" data-row="${escapeHtml(r["_rowNumber"])}">復元</button>
    </div>
  `).join('');
}

bindListAction("deletedFilesListArea", (d) => handleRestoreDeletedFile(d.id, Number(d.row)));

window.handleRestoreDeletedFile = async function(fileId, rowNumber) {
  document.getElementById("deletedFilesListArea").innerHTML = "復元中...";
  try {
    await apiCall("restoreDeletedFile", { fData: { fileId, rowNumber } });
    await reloadAndRender();
    await openDeletedFilesModal();
    showToast("復元しました。");
  } catch (err) {
    showErrorDialog(err);
    await openDeletedFilesModal();
  }
};
