/**
 * =====================================================================
 * 08_master.js：マスタ管理（タグ・書類種別）
 * =====================================================================
 * 【役割】
 *   マスタ管理モーダルの表示、タグ・書類種別の追加・削除
 *   （削除と書類種別の追加は管理者のみ。サーバー側でも権限を必ず確認する）
 *
 * 【読み込み順】07_detail.js の後。
 * 【依存】02_state.js（キャッシュ・権限）、03_utils.js、04_api_auth.js
 */

// =================================================================
// タグ管理（S08）
// =================================================================
window.openTagModal = function() {
  document.getElementById("useTypeAddArea").style.display = isAdminUser() ? "block" : "none"; // 書類種別の追加は管理者のみ
  renderTagList();
  renderUseTypeList();
  document.getElementById("tagModal").style.display = "flex";
};

window.closeTagModal = function() {
  document.getElementById("tagModal").style.display = "none";
};

function renderTagList() {
  const area = document.getElementById("tagListArea");
  if (allTagsCache.length === 0) {
    area.innerHTML = '<p style="color:#94a3b8; font-size:14px;">タグはまだ登録されていません。</p>';
    return;
  }
  area.innerHTML = allTagsCache.map(tag => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 4px; border-bottom:1px solid #f1f5f9;">
      <span>${escapeHtml(tag.tagName)}<span style="color:#94a3b8; font-size:12px; margin-left:8px;">${escapeHtml(tag.tagId)}</span></span>
      ${isAdminUser() ? `<button class="btn btn-danger-soft btn-sm" data-id="${escapeHtml(tag.tagId)}">削除</button>` : ""}
    </div>
  `).join('');
}

bindListAction("tagListArea", (d) => handleDeleteTag(d.id));

window.handleAddTag = async function() {
  const input = document.getElementById("newTagNameInput");
  const name = input.value.trim();
  if (!name) return;
  try {
    await apiCall("addTag", { tagName: name });
    input.value = "";
    const tagData = await apiCall("loadTagMaster");
    allTagsCache = tagData.tags || [];
    renderTagList();
  } catch (err) {
    showErrorDialog(err);
  }
};

window.handleDeleteTag = async function(tagId) {
  try {
    const result = await apiCall("deleteTag", { tagId: tagId, force: false });
    if (!result.success) {
      // 使用中の場合は確認の上、強制削除（該当ファイルのタグ一覧からも自動で外れる）
      const confirmResult = await Swal.fire({
        title: `このタグは${result.inUseCount}件のファイルで使用中です`,
        text: '削除すると、該当ファイルからもこのタグが自動的に外れます。続行しますか？',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#dc2626',
        confirmButtonText: '削除する',
        cancelButtonText: 'キャンセル'
      });
      if (!confirmResult.isConfirmed) return;
      await apiCall("deleteTag", { tagId: tagId, force: true });
    }
    const tagData = await apiCall("loadTagMaster");
    allTagsCache = tagData.tags || [];
    renderTagList();
    await reloadAndRender(); // 削除したタグ・種別が外れた一覧を、画面にも反映する
  } catch (err) {
    showErrorDialog(err);
  }
};

// =================================================================
// 用途種別マスタ管理（S10の一部）
// =================================================================
/** 書類種別IDの選択肢（01〜99）を作り直す。すでに使われているIDは選べないようにする */
function renderUseTypeIdOptions() {
  const select = document.getElementById("newUseTypeIdSelect");
  const usedIds = new Set(allUseTypesCache.map(ut => String(ut.useTypeId).padStart(2, "0")));
  const options = ['<option value="">ID選択</option>'];
  for (let n = 1; n <= 99; n++) {
    const id = String(n).padStart(2, "0");
    if (!usedIds.has(id)) options.push(`<option value="${id}">${id}</option>`);
  }
  select.innerHTML = options.join("");
}

function renderUseTypeList() {
  renderUseTypeIdOptions(); // 追加・削除のたびに、選べるIDを最新にする
  const area = document.getElementById("useTypeListArea");
  if (allUseTypesCache.length === 0) {
    area.innerHTML = '<p style="color:#94a3b8; font-size:14px;">書類種別はまだ登録されていません。</p>';
    return;
  }
  area.innerHTML = allUseTypesCache.map(ut => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 4px; border-bottom:1px solid #f1f5f9;">
      <span>${escapeHtml(ut.useTypeName)}<span style="color:#94a3b8; font-size:12px; margin-left:8px;">${escapeHtml(ut.useTypeId)}${ut.keywords ? escapeHtml(" / キーワード: " + ut.keywords) : ""}${ut.ocrDateLabel ? escapeHtml(" / OCR基準日: " + ut.ocrDateLabel) : ""}</span></span>
      ${isAdminUser() ? `<button class="btn btn-danger-soft btn-sm" data-id="${escapeHtml(ut.useTypeId)}">削除</button>` : ""}
    </div>
  `).join('');
}

bindListAction("useTypeListArea", (d) => handleDeleteUseType(d.id));

window.handleAddUseType = async function() {
  const idSelect = document.getElementById("newUseTypeIdSelect");
  const nameInput = document.getElementById("newUseTypeNameInput");
  const keywordInput = document.getElementById("newUseTypeKeywordsInput");
  const ocrDateLabelInput = document.getElementById("newUseTypeOcrDateLabelInput");
  const name = nameInput.value.trim();
  if (!name) return;
  if (!idSelect.value) {
    showToast("書類種別のIDを選択してください。");
    return;
  }
  try {
    await apiCall("addUseType", {
      useTypeId: idSelect.value,
      useTypeName: name,
      keywords: keywordInput.value.trim(),
      ocrDateLabel: ocrDateLabelInput.value.trim()
    });
    nameInput.value = "";
    keywordInput.value = "";
    ocrDateLabelInput.value = "";
    const data = await apiCall("loadUseTypeMaster");
    allUseTypesCache = data.useTypes || [];
    renderUseTypeList();
  } catch (err) {
    showErrorDialog(err);
  }
};

window.handleDeleteUseType = async function(useTypeId) {
  try {
    const result = await apiCall("deleteUseType", { useTypeId: useTypeId, force: false });
    if (!result.success) {
      const confirmResult = await Swal.fire({
        title: `この書類種別は${result.inUseCount}件のファイルで使用中です`,
        text: '削除すると、該当ファイルの書類種別は未設定に戻ります。続行しますか？',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#dc2626',
        confirmButtonText: '削除する',
        cancelButtonText: 'キャンセル'
      });
      if (!confirmResult.isConfirmed) return;
      await apiCall("deleteUseType", { useTypeId: useTypeId, force: true });
    }
    const data = await apiCall("loadUseTypeMaster");
    allUseTypesCache = data.useTypes || [];
    renderUseTypeList();
    await reloadAndRender(); // 削除したタグ・種別が外れた一覧を、画面にも反映する
  } catch (err) {
    showErrorDialog(err);
  }
};
