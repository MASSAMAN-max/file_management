/**
 * 10_project_picker.js
 * 案件選択部品（登録モーダル・詳細モーダルの「紐付け先」）と、案件マスタ・発注元マスタの裏読込。
 *
 * 【画面】「紐付け先」のタブ（初期状態は閉じている。押すと開閉する）
 *           ├ タブの外：選択済みの案件（常に表示。×で解除。確認ダイアログあり）
 *           └ タブの中：発注元 → 担当者（発注元を選ぶまで選べない）→ 自由文字検索 → 絞り込んだ案件の一覧（クリックで追加）
 * 【データ】案件マスタ・発注元マスタは、ログイン後に画面を表示してから裏で読み込む（loadProjectsInBackground）。
 *           読み込み中・失敗中は、部品の中にその状態を表示する。
 *           発注元・担当者の選択肢は、ログインマスターの「発注元」「発注元ヨミ」「担当者」から作る。
 * 【依存】02_state.js、03_utils.js（escapeHtml）、04_api_auth.js（apiCall）、05_list.js（normalizeText）
 * 【注意】発注元・担当者は案件を絞り込むためだけの補助で、data シートには保存しない（保存するのは案件Noのみ）。
 */

// 絞り込み結果として一度に表示する最大件数（案件が1000件以上あっても画面を重くしないため）
const PROJECT_PICKER_MAX_ROWS = 100;

// =================================================================
// 発注元の表示・並び（あいうえお順）
// =================================================================

// 発注元の選択肢に付ける「行」の並び順（「その他」は漢字・英数字などで読みが取れないもの）
const GYOU_ORDER = ["あ行", "か行", "さ行", "た行", "な行", "は行", "ま行", "や行", "ら行", "わ行", "その他"];

/** 文字の先頭から、50音の「行」を判定する（ひらがな・カタカナのみ。それ以外は「その他」） */
function getGyou(text) {
  if (!text) return "その他";
  const char = String(text).trim().charAt(0);
  if (!char) return "その他";

  if (/^[あ-おア-オぁ-ぉァ-ォヴゔ]/i.test(char)) return "あ行";
  if (/^[か-ごカ-ゴヵヶ]/i.test(char)) return "か行";
  if (/^[さ-ぞサ-ゾ]/i.test(char)) return "さ行";
  if (/^[た-どタ-ドっッ]/i.test(char)) return "た行";
  if (/^[な-のナ-ノ]/i.test(char)) return "な行";
  if (/^[は-ぽハ-ポ]/i.test(char)) return "は行";
  if (/^[ま-もマ-モ]/i.test(char)) return "ま行";
  if (/^[や-よヤ-ヨゃ-ょャ-ョ]/i.test(char)) return "や行";
  if (/^[ら-ろラ-ロ]/i.test(char)) return "ら行";
  if (/^[わ-んワ-ンゎヮ]/i.test(char)) return "わ行";
  return "その他";
}

/**
 * 発注元の表示名から「株式会社」「有限会社」「合同会社」と、括弧付きの略称（株）（有）を除く。
 * ※「株」「有」を括弧なしで消すと「有田建設」などの社名まで壊れるため、括弧付きに限定している
 */
function formatClientDisplayName(name) {
  return String(name || "")
    .replace(/株式会社|有限会社|合同会社|[（(\[【][株有][）)\]】]/g, "")
    .trim();
}

/**
 * ログインマスターの行（発注元・発注元ヨミ・担当者）から、発注元の選択肢と担当者の索引を作る。
 * 発注元は「行（あ行…）の順 → ヨミの順」に並べ、各要素に gyou（行）を持たせる（見出し用のダミー要素は入れない）。
 * ヨミが空の発注元は、株式会社などを除いた名前で並べる。
 * @return {{clients: Array<{name: string, gyou: string}>, contactsByClient: Map<string, string[]>}}
 */
function buildClientIndex(masterRows) {
  const yomiByClient = new Map();
  const contactsByClient = new Map();
  masterRows.forEach(row => {
    if (!row.client) return;
    if (!yomiByClient.has(row.client) || (!yomiByClient.get(row.client) && row.yomi)) {
      yomiByClient.set(row.client, row.yomi || "");
    }
    if (!contactsByClient.has(row.client)) contactsByClient.set(row.client, []);
    const contacts = contactsByClient.get(row.client);
    if (row.contact && !contacts.includes(row.contact)) contacts.push(row.contact);
  });

  const clients = [...yomiByClient].map(([name, yomi]) => {
    const sortKey = yomi || formatClientDisplayName(name);
    return { name: name, sortKey: sortKey, gyou: getGyou(sortKey) };
  });
  clients.sort((a, b) =>
    GYOU_ORDER.indexOf(a.gyou) - GYOU_ORDER.indexOf(b.gyou) || a.sortKey.localeCompare(b.sortKey, "ja"));

  return { clients: clients.map(({ name, gyou }) => ({ name, gyou })), contactsByClient: contactsByClient };
}

// =================================================================
// マスタの読込
// =================================================================

/** 案件マスタ・発注元マスタをサーバーから取得する。画面の操作を止めないよう、呼び出し側は待たなくてよい */
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

    const clientIndex = buildClientIndex(data.clientMaster || []);
    clientListCache = clientIndex.clients;
    contactsByClient = clientIndex.contactsByClient;
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
 * @param {{title: string, clientInputId: string}} options
 *        title：タブに表示するタイトル／clientInputId：案件を選んだとき、その発注元を自動入力する「取引先」入力欄のid
 * @return {{render: function, reset: function}} render：再描画（絞り込みは保つ）／reset：タブを閉じ、絞り込みを初期状態に戻して再描画
 * ※ 案件を追加・解除・自動入力したときは、部品の要素から bubbles付きの change イベントを発火する
 *    （詳細モーダルが、変更の有無を検知するため）。
 */
function createProjectPicker(containerId, selectedList, options) {
  const container = document.getElementById(containerId);
  const filters = { client: "", contact: "", keyword: "" };
  let lastAutoClient = ""; // 直前に自動入力した取引先（手入力した内容を上書きしないための目印）
  let isOpen = false;      // タブ（検索項目・案件候補）が開いているか

  container.innerHTML = `
    <div class="project-picker">
      <button type="button" class="project-picker-toggle" data-role="toggle" aria-expanded="false">
        <span>${escapeHtml(options.title)}</span>
        <span class="material-symbols-outlined project-picker-toggle-icon" data-role="icon">expand_more</span>
      </button>
      <div class="project-picker-selected" data-role="chips"></div>
      <div class="project-picker-body" data-role="body" style="display:none;">
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
      </div>
    </div>
  `;
  const pickerEl = container.querySelector('.project-picker'); // 枠（開閉に合わせて色を変える）
  const toggleBtn = container.querySelector('[data-role="toggle"]');
  const iconEl = container.querySelector('[data-role="icon"]');
  const bodyEl = container.querySelector('[data-role="body"]');
  const clientSelect = container.querySelector('[data-role="client"]');
  const contactSelect = container.querySelector('[data-role="contact"]');
  const keywordInput = container.querySelector('[data-role="keyword"]');
  const statusEl = container.querySelector('[data-role="status"]');
  const listEl = container.querySelector('[data-role="list"]');
  const chipsEl = container.querySelector('[data-role="chips"]');

  function setOpen(open) {
    isOpen = open;
    bodyEl.style.display = open ? "block" : "none";
    pickerEl.classList.toggle("is-open", open); // 開いている間は枠を青くして、範囲を強調する
    iconEl.style.transform = open ? "rotate(180deg)" : "";
    toggleBtn.setAttribute("aria-expanded", String(open));
  }

  /** 発注元の選択肢。ログインマスターのヨミ順に並べ、行（あ行…）ごとに見出し（optgroup）を付ける。表示は「株式会社」等を除く */
  function buildClientOptionsHtml() {
    let html = `<option value="">すべて</option>`;
    let currentGyou = null;
    clientListCache.forEach(client => {
      if (client.gyou !== currentGyou) {
        if (currentGyou !== null) html += `</optgroup>`;
        html += `<optgroup label="${escapeHtml(client.gyou)}">`;
        currentGyou = client.gyou;
      }
      html += `<option value="${escapeHtml(client.name)}">${escapeHtml(formatClientDisplayName(client.name))}</option>`;
    });
    if (currentGyou !== null) html += `</optgroup>`;
    return html;
  }

  function renderClientOptions() {
    if (filters.client && !clientListCache.some(client => client.name === filters.client)) filters.client = "";
    clientSelect.innerHTML = buildClientOptionsHtml();
    clientSelect.value = filters.client;
  }

  /** 担当者は、選んだ発注元の担当者だけを表示する（ログインマスターの行順）。発注元が未選択の間は選べない */
  function renderContactOptions() {
    contactSelect.disabled = !filters.client;
    const contacts = filters.client ? (contactsByClient.get(filters.client) || []) : [];
    if (filters.contact && !contacts.includes(filters.contact)) filters.contact = "";
    contactSelect.innerHTML = `<option value="">${filters.client ? "すべて" : "（発注元を先に選択）"}</option>` +
      contacts.map(contact => `<option value="${escapeHtml(contact)}">${escapeHtml(contact)}</option>`).join("");
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
      statusEl.textContent = `該当案件の先頭 ${PROJECT_PICKER_MAX_ROWS} 件を表示しています。発注元や検索語でさらに絞り込んでください。`;
    } else {
      statusEl.textContent = `該当 ${matched.length} 件`;
    }

    listEl.innerHTML = matched.slice(0, PROJECT_PICKER_MAX_ROWS).map(project => {
      const isSelected = selectedList.includes(project.no);
      const sub = isSelected ? "選択済み" : [formatClientDisplayName(project.client), project.contact].filter(Boolean).join(" / ");
      return `
        <button type="button" class="project-picker-item" data-no="${escapeHtml(project.no)}" ${isSelected ? "disabled" : ""}>
          <span class="project-picker-item-no">${escapeHtml(project.no)}</span>
          <span>${escapeHtml(project.name)}</span>
          <span class="project-picker-item-sub">${escapeHtml(sub)}</span>
        </button>`;
    }).join("");
    listEl.scrollTop = scrollTop;
  }

  /** 選択済みの案件を、「番号＋案件名」のチップで表示する（案件リストにない番号は番号のみ）。タブが閉じていても表示する */
  function renderChips() {
    chipsEl.innerHTML = selectedList.map(caseNo => `
      <span class="link-chip">${escapeHtml(getProjectChipLabel(caseNo))} <span class="remove" data-id="${escapeHtml(caseNo)}">×</span></span>
    `).join("");
  }

  /**
   * 選んだ案件の発注元を、「取引先」欄へ自動入力する（案件シートの正式名のまま入れる）。
   * 取引先が空、または前回の自動入力のままのときだけ入れる（手入力した内容・OCRの結果は上書きしない）。
   * 複数の案件を選んだ場合は、最後に選んだ案件の発注元になる。発注元が空の案件では何もしない。
   */
  function fillClientFromProject(project) {
    if (!project || !project.client) return;
    const input = document.getElementById(options.clientInputId);
    const current = input.value.trim();
    if (current === "" || current === lastAutoClient) {
      input.value = project.client;
      lastAutoClient = project.client;
    }
  }

  /** 案件の追加・解除・取引先の自動入力があったことを、フォームへ知らせる（変更検知用） */
  function notifyChange() {
    container.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function render() {
    renderClientOptions();
    renderContactOptions();
    renderList(false);
    renderChips();
  }

  function reset() {
    lastAutoClient = ""; // モーダルを開き直したら、入力済みの取引先は手入力として扱う
    filters.client = "";
    filters.contact = "";
    filters.keyword = "";
    keywordInput.value = "";
    setOpen(false); // 検索項目・案件候補は、開いた直後は閉じておく
    render();
  }

  // --- 操作 ---
  toggleBtn.addEventListener("click", () => setOpen(!isOpen));
  clientSelect.addEventListener("change", (e) => {
    e.stopPropagation(); // 絞り込み用の選択は、フォームの変更として扱わない
    filters.client = clientSelect.value;
    filters.contact = ""; // 発注元を変えたら、担当者は選び直す
    renderContactOptions();
    renderList(false);
  });
  contactSelect.addEventListener("change", (e) => {
    e.stopPropagation();
    filters.contact = contactSelect.value;
    renderList(false);
  });
  keywordInput.addEventListener("input", (e) => {
    e.stopPropagation(); // 検索語も、フォームの変更として扱わない
    filters.keyword = keywordInput.value;
    renderList(false);
  });
  keywordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.preventDefault(); // フォームが送信されてしまうのを防ぐ
  });
  listEl.addEventListener("click", (e) => {
    const item = e.target.closest("[data-no]");
    if (!item || item.disabled) return;
    const caseNo = item.dataset.no;
    if (!selectedList.includes(caseNo)) {
      selectedList.push(caseNo);
      fillClientFromProject(projectMapByNo.get(caseNo));
    }
    renderChips();
    renderList(true);
    notifyChange();
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
    notifyChange();
  });
  statusEl.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="retry"]')) loadProjectsInBackground();
  });

  render();
  return { render, reset };
}

// 登録モーダル・詳細モーダルの案件選択部品（読み込み時に1回だけ作る）
const projectPickers = {
  upload: createProjectPicker("uploadProjectPicker", pendingLinks, { title: "紐付け先（案件・任意・複数可）", clientInputId: "uploadClient" }),
  detail: createProjectPicker("detailProjectPicker", detailLinks, { title: "紐付け先（案件・複数可）", clientInputId: "detailClient" })
};

/** 案件マスタの読み込み状況が変わったときに、全ての部品を描画し直す（絞り込みは保つ） */
function refreshAllProjectPickers() {
  Object.values(projectPickers).forEach(picker => picker.render());
}
