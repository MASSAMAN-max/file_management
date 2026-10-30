/**
 * =====================================================================
 * 08_master.js：マスタ管理（タグ・書類種別）
 * =====================================================================
 * 【役割】
 *   マスタ管理モーダルの表示、タグ・書類種別の追加・削除
 *   （削除と書類種別の追加は管理者のみ。サーバー側でも権限を必ず確認する）
 *   追加・削除は通信に時間がかかるため、完了するまでの間「処理中」を表示して操作を止める（withMasterBusy）
 *
 * 【読み込み順】07_detail.js の後。
 * 【依存】02_state.js（キャッシュ・権限）、03_utils.js、04_api_auth.js
 */

// =================================================================
// 追加・削除中の「処理中」表示（タグ・書類種別で共通）
// =================================================================
let isMasterBusy = false; // 追加・削除の処理中か（二重実行を防ぐ）

/** 処理中は、入力欄とボタンを押せなくする（「閉じる」ボタンと✕は、そのまま押せる） */
function setMasterControlsDisabled(isDisabled) {
  document.querySelectorAll("#tagModal input, #tagModal select, #tagModal .btn-primary, #tagModal .btn-danger-soft")
    .forEach(el => { el.disabled = isDisabled; });
}

/**
 * 追加・削除など、通信を伴う操作を実行する。完了するまで、押したボタンを「○○中...」（回転アイコン付き）に変え、
 * マスタ管理の入力欄・ボタンを押せなくする。成功すれば完了のお知らせを出し、失敗すればエラーを表示する。
 * @param {HTMLElement|null} button 押されたボタン（処理中の表示に使う。見つからない場合は null）
 * @param {string} busyLabel ボタンに出す処理中の文字（例：「追加中...」）
 * @param {string} doneMessage 完了時に出すお知らせ
 * @param {function(): Promise<boolean|void>} task 実際の処理。キャンセルされて何もしなかった場合は false を返す（お知らせは出さない）
 */
async function withMasterBusy(button, busyLabel, doneMessage, task) {
  if (isMasterBusy) return;
  isMasterBusy = true;
  const originalHtml = button ? button.innerHTML : "";
  setMasterControlsDisabled(true);
  if (button) {
    button.classList.add("is-busy");
    button.innerHTML = `<span class="material-symbols-outlined icon-spin">progress_activity</span> ${busyLabel}`;
  }
  try {
    const result = await task();
    if (result !== false) showToast(doneMessage);
  } catch (err) {
    showErrorDialog(err);
  } finally {
    isMasterBusy = false;
    setMasterControlsDisabled(false);
    // 一覧の再描画でボタン自体が作り直された場合（削除ボタン）は、元に戻す必要がない
    if (button && button.isConnected) {
      button.classList.remove("is-busy");
      button.innerHTML = originalHtml;
    }
  }
}

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

window.handleAddTag = async function(button) {
  const input = document.getElementById("newTagNameInput");
  const name = input.value.trim();
  if (!name) return;
  await withMasterBusy(button, "追加中...", "タグを追加しました。", async () => {
    await apiCall("addTag", { tagName: name });
    input.value = ""; // 追加に失敗した場合は、入力した内容を残す
    const tagData = await apiCall("loadTagMaster");
    allTagsCache = tagData.tags || [];
    renderTagList();
  });
};

window.handleDeleteTag = async function(tagId) {
  const button = document.querySelector(`#tagListArea [data-id="${CSS.escape(tagId)}"]`); // 押された削除ボタン
  await withMasterBusy(button, "削除中...", "タグを削除しました。", async () => {
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
      if (!confirmResult.isConfirmed) return false; // キャンセル（完了のお知らせは出さない）
      await apiCall("deleteTag", { tagId: tagId, force: true });
    }
    const tagData = await apiCall("loadTagMaster");
    allTagsCache = tagData.tags || [];
    renderTagList();
    await reloadAndRender(); // 削除したタグ・種別が外れた一覧を、画面にも反映する
  });
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

window.handleAddUseType = async function(button) {
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
  await withMasterBusy(button, "追加中...", "書類種別を追加しました。", async () => {
    await apiCall("addUseType", {
      useTypeId: idSelect.value,
      useTypeName: name,
      keywords: keywordInput.value.trim(),
      ocrDateLabel: ocrDateLabelInput.value.trim()
    });
    nameInput.value = ""; // 追加に失敗した場合は、入力した内容を残す
    keywordInput.value = "";
    ocrDateLabelInput.value = "";
    const data = await apiCall("loadUseTypeMaster");
    allUseTypesCache = data.useTypes || [];
    renderUseTypeList();
  });
};

window.handleDeleteUseType = async function(useTypeId) {
  const button = document.querySelector(`#useTypeListArea [data-id="${CSS.escape(useTypeId)}"]`); // 押された削除ボタン
  await withMasterBusy(button, "削除中...", "書類種別を削除しました。", async () => {
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
      if (!confirmResult.isConfirmed) return false; // キャンセル（完了のお知らせは出さない）
      await apiCall("deleteUseType", { useTypeId: useTypeId, force: true });
    }
    const data = await apiCall("loadUseTypeMaster");
    allUseTypesCache = data.useTypes || [];
    renderUseTypeList();
    await reloadAndRender(); // 削除したタグ・種別が外れた一覧を、画面にも反映する
  });
};
