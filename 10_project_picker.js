/**
 * 10_project_picker.js
 * 案件選択部品（登録モーダル・詳細モーダルの「紐付け先」）と、案件マスタの裏読込。
 *
 * 【画面】発注元 → 担当者（発注元を選ぶまで選べない）→ 自由文字検索（案件No・案件名）
 *         → 絞り込んだ案件の一覧（クリックで追加）→ 選択済みの案件（×で解除。確認ダイアログあり）
 * 【データ】案件マスタは、ログイン後に画面を表示してから裏で読み込む（loadProjectsInBackground）。
 *           読み込み中・失敗中は、部品の中にその状態を表示する。
 * 【依存】02_state.js、03_utils.js（escapeHtml）、04_api_auth.js（apiCall）、05_list.js（normalizeText）
 * 【注意】発注元・担当者は案件を絞り込むためだけの補助で、data シートには保存しない（保存するのは案件Noのみ）。
 */

// 絞り込み結果として一度に表示する最大件数（案件が1000件以上あっても画面を重くしないため）
const PROJECT_PICKER_MAX_ROWS = 100;

// =================================================================
// 案件マスタの読込
// =================================================================

/** 案件マスタをサーバーから取得する。画面の操作を止めないよう、呼び出し側は待たなくてよい */
async function loadProjectsInBackground() {
  projectListStatus = "loading";
  refreshAllProjectPickers();
  try {
    const data = await apiCall("loadProjects");
    const projects = data.projects || [];
    // 検索用テキストは、案件ごとに1回だけ作って使い回す（一覧のキーワード検索と同じ方式）
    projects.forEach(project => { project.__searchText = normalizeText(`${project.no} ${project.name}`); });
    projectListCache = projects;
    projectMapByNo = new Map(projects.map(project => [project.no, project]));
    projectListStatus = "ready";
  } catch (err) {
    console.error("案件マスタの読み込みに失敗しました:", err);
    projectListErrorMessage = (err && err.message) || "原因不明のエラー";
    projectListStatus = "error";
  }
  refreshAllProjectPickers();
}

/** 案件No → チップに表示する文字列。案件名が分かれば「番号＋案件名」、分からなければ「案件No.番号」 */
function getProjectChipLabel(caseNo) {
  const project = projectMapByNo.get(caseNo);
  return project && project.name ? `${caseNo} ${project.name}` : `案件No.${caseNo}`;
}

/** 「紐付けを解除しますか？」の確認ダイアログ。解除する場合は true を返す */
async function confirmRemoveProject(label) {
  const result = await Swal.fire({
    title: "紐付けを解除しますか？",
    text: label,
    icon: "warning",
    showCancelButton: true,
    confirmButtonColor: "#dc2626",
    confirmButtonText: "解除する",
    cancelButtonText: "キャンセル"
  });
  return result.isConfirmed;
}

/** 発注元・担当者・検索語で案件を絞り込む（発注元・担当者は完全一致、検索語は案件No・案件名に全て含まれること） */
function filterProjects(filters) {
  const tokens = normalizeText(filters.keyword).split(/\s+/).filter(Boolean);
  return projectListCache.filter(project => {
    if (filters.client && project.client !== filters.client) return false;
    if (filters.contact && project.contact !== filters.contact) return false;
    return tokens.every(token => project.__searchText.includes(token));
  });
}

// =================================================================
// 案件選択部品
// =================================================================

/**
 * 案件選択部品を、指定した要素の中に作る。
 * @param {string} containerId 部品を表示する要素のid
 * @param {string[]} selectedList 選択中の案件Noの配列（呼び出し元と同じ配列を直接書き換える）
 * @return {{render: function, reset: function}} render：再描画（絞り込みは保つ）／reset：絞り込みを初期状態に戻して再描画
 */
function createProjectPicker(containerId, selectedList) {
  const container = document.getElementById(containerId);
  const filters = { client: "", contact: "", keyword: "" };

  container.innerHTML = `
    <div class="project-picker">
      <div class="project-picker-row">
        <div class="project-picker-col">
          <label class="project-picker-label">発注元</label>
          <select data-role="client"></select>
        </div>
        <div class="project-picker-col">
          <label class="project-picker-label">担当者</label>
          <select data-role="contact"></select>
        </div>
      </div>
      <input type="text" data-role="keyword" placeholder="案件No・案件名で絞り込み">
      <div class="project-picker-status" data-role="status"></div>
      <div class="project-picker-list" data-role="list"></div>
      <div class="project-picker-selected" data-role="chips"></div>
    </div>
  `;
  const clientSelect = container.querySelector('[data-role="client"]');
  const contactSelect = container.querySelector('[data-role="contact"]');
  const keywordInput = container.querySelector('[data-role="keyword"]');
  const statusEl = container.querySelector('[data-role="status"]');
  const listEl = container.querySelector('[data-role="list"]');
  const chipsEl = container.querySelector('[data-role="chips"]');

  /** 重複・空を除いて、五十音順に並べる */
  function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  }

  function buildOptionsHtml(firstLabel, values) {
    return `<option value="">${escapeHtml(firstLabel)}</option>` +
      values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  }

  function renderClientOptions() {
    const clients = uniqueSorted(projectListCache.map(project => project.client));
    if (filters.client && !clients.includes(filters.client)) filters.client = "";
    clientSelect.innerHTML = buildOptionsHtml("すべて", clients);
    clientSelect.value = filters.client;
  }

  /** 担当者は、選んだ発注元の案件にいる担当者だけを表示する。発注元が未選択の間は選べない */
  function renderContactOptions() {
    contactSelect.disabled = !filters.client;
    const contacts = filters.client
      ? uniqueSorted(projectListCache.filter(project => project.client === filters.client).map(project => project.contact))
      : [];
    if (filters.contact && !contacts.includes(filters.contact)) filters.contact = "";
    contactSelect.innerHTML = buildOptionsHtml(filters.client ? "すべて" : "（発注元を先に選択）", contacts);
    contactSelect.value = filters.contact;
  }

  /** @param {boolean} keepScroll 一覧のスクロール位置を保つ（案件を追加・解除した直後など） */
  function renderList(keepScroll) {
    const scrollTop = keepScroll ? listEl.scrollTop : 0;

    if (projectListStatus === "error") {
      statusEl.className = "project-picker-status is-error";
      statusEl.innerHTML = `案件リストを読み込めませんでした（${escapeHtml(projectListErrorMessage)}）
        <button type="button" class="project-picker-retry" data-action="retry">再読み込み</button>`;
      listEl.innerHTML = "";
      return;
    }
    if (projectListStatus !== "ready") { // idle（ログイン前）・loading
      statusEl.className = "project-picker-status";
      statusEl.textContent = "案件リストを読み込み中です…";
      listEl.innerHTML = "";
      return;
    }

    const matched = filterProjects(filters);
    statusEl.className = "project-picker-status";
    if (matched.length === 0) {
      statusEl.textContent = "該当する案件がありません。";
    } else if (matched.length > PROJECT_PICKER_MAX_ROWS) {
      statusEl.textContent = `該当 ${matched.length} 件のうち、先頭 ${PROJECT_PICKER_MAX_ROWS} 件を表示しています。発注元や検索語でさらに絞り込んでください。`;
    } else {
      statusEl.textContent = `該当 ${matched.length} 件`;
    }

    listEl.innerHTML = matched.slice(0, PROJECT_PICKER_MAX_ROWS).map(project => {
      const isSelected = selectedList.includes(project.no);
      const sub = isSelected ? "選択済み" : [project.client, project.contact].filter(Boolean).join(" / ");
      return `
        <button type="button" class="project-picker-item" data-no="${escapeHtml(project.no)}" ${isSelected ? "disabled" : ""}>
          <span class="project-picker-item-no">${escapeHtml(project.no)}</span>
          <span>${escapeHtml(project.name)}</span>
          <span class="project-picker-item-sub">${escapeHtml(sub)}</span>
        </button>`;
    }).join("");
    listEl.scrollTop = scrollTop;
  }

  /** 選択済みの案件を、「番号＋案件名」のチップで表示する（案件リストにない番号は番号のみ） */
  function renderChips() {
    chipsEl.innerHTML = selectedList.map(caseNo => `
      <span class="link-chip">${escapeHtml(getProjectChipLabel(caseNo))} <span class="remove" data-id="${escapeHtml(caseNo)}">×</span></span>
    `).join("");
  }

  function render() {
    renderClientOptions();
    renderContactOptions();
    renderList(false);
    renderChips();
  }

  function reset() {
    filters.client = "";
    filters.contact = "";
    filters.keyword = "";
    keywordInput.value = "";
    render();
  }

  // --- 操作 ---
  clientSelect.addEventListener("change", () => {
    filters.client = clientSelect.value;
    filters.contact = ""; // 発注元を変えたら、担当者は選び直す
    renderContactOptions();
    renderList(false);
  });
  contactSelect.addEventListener("change", () => {
    filters.contact = contactSelect.value;
    renderList(false);
  });
  keywordInput.addEventListener("input", () => {
    filters.keyword = keywordInput.value;
    renderList(false);
  });
  keywordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault(); // フォームが送信されてしまうのを防ぐ
  });
  listEl.addEventListener("click", (e) => {
    const item = e.target.closest("[data-no]");
    if (!item || item.disabled) return;
    if (!selectedList.includes(item.dataset.no)) selectedList.push(item.dataset.no);
    renderChips();
    renderList(true);
  });
  chipsEl.addEventListener("click", async (e) => {
    const target = e.target.closest("[data-id]");
    if (!target) return;
    const caseNo = target.dataset.id;
    if (!(await confirmRemoveProject(getProjectChipLabel(caseNo)))) return;
    const index = selectedList.indexOf(caseNo);
    if (index >= 0) selectedList.splice(index, 1);
    renderChips();
    renderList(true);
  });
  statusEl.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="retry"]')) loadProjectsInBackground();
  });

  render();
  return { render, reset };
}

// 登録モーダル・詳細モーダルの案件選択部品（読み込み時に1回だけ作る）
const projectPickers = {
  upload: createProjectPicker("uploadProjectPicker", pendingLinks),
  detail: createProjectPicker("detailProjectPicker", detailLinks)
};

/** 案件マスタの読み込み状況が変わったときに、全ての部品を描画し直す（絞り込みは保つ） */
function refreshAllProjectPickers() {
  Object.values(projectPickers).forEach(picker => picker.render());
}
