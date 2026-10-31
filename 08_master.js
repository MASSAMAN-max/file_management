/**
 * =====================================
 * ファイルメタデータの読み取り・登録・更新処理
 * =====================================
 * 一覧の取得は全件取得のみ。
 * 絞り込み・検索ロジックは案件管理アプリと同様、フロント側（HTML）に一本化し、
 * サーバー側では持たない方針を踏襲する（サーバー・フロントの二重管理を防ぐため）。
 */

// 一覧画面へ返す data シートの項目
const DATA_FIELD_NAMES = [
  "ファイルID", "ファイル名", "表示名", "形式ID", "用途種別ID", "タグID一覧",
  "取引先", "発行受領区分", "適格事業者登録番号", "通貨", "税率", "金額（税抜）", "金額（税込）", "取引日",
  "説明・備考", "案件No", "DriveファイルURL",
  "OCRテキスト（全文）", "OCR構造化データ（JSON）", "OCRステータス",
  "レコードステータス", "元ステータス", "削除日時", "アップロード者",
  "作成日時", "更新日時", "変更履歴"
];

/**
 * 日付のみの値（取引日など）を "yyyy-MM-dd" の文字列にする（日本時間）。
 * Date型かどうかは instanceof ではなく Object.prototype.toString で判定する
 * （実行環境をまたいだ Date は instanceof で判定できない場合があるため）。
 * 文字列などは、そのまま文字列で返す。
 */
function formatDateOnly_(value) {
  if (!value) return "";
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return Utilities.formatDate(value, "Asia/Tokyo", "yyyy-MM-dd");
  }
  return String(value);
}

/**
 * data シートの全レコードを取得する。
 *
 * 【速度改善】
 * 以前は「行数 × 項目数」回、共通ライブラリの getValue を呼んでいた。ライブラリの関数呼び出しは
 * 通常の関数より遅く、件数が増えるほど時間がかかるため、列の位置を1回だけ求めて直接参照する方式に変えた。
 * @return {Array<Object>} ファイルメタデータの配列
 */
function loadAllRecords() {
  const values = timed_("一覧読込(ファイルを開く含む)", () => Sheets.data.main().getDataRange().getValues());
  if (values.length < 2) return []; // ヘッダーのみ＝データ0件

  const columnIndex = buildColumnIndex_(values[0]);

  const records = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const record = { "_rowNumber": i + 1 }; // シート上の実際の行番号（更新系APIの引数に使用）
    DATA_FIELD_NAMES.forEach(name => {
      const idx = columnIndex.get(name);
      record[name] = idx === undefined ? "" : row[idx]; // 列が存在しない場合は空文字
    });
    // 「取引日」はSheets側が自動的に日付型セルへ変換することがあり、その場合Date型で返ってくる。
    // フォーマットせずJSON化するとUTC変換された日時文字列になってしまうため、
    // 常に yyyy-MM-dd の文字列へ揃えてから返す（<input type="date">にもそのまま使える形式）。
    record["取引日"] = formatDateOnly_(record["取引日"]);
    // 用途種別IDは2桁の文字列にそろえる（シートのセルが数値の 8 になっていても、"08" として画面へ返す）
    record["用途種別ID"] = normalizeUseTypeId_(record["用途種別ID"]);
    // 実行が途中で止まり、いつまでも「処理中」のままのレコードは「失敗」として画面へ返す
    // （「処理中」は編集・ゴミ箱移動ができないため、そのままだと永久に固まってしまう。シートは書き換えない）
    if (record["OCRステータス"] === "処理中" && isBackgroundTaskStale_(record["更新日時"])) {
      record["OCRステータス"] = "失敗";
    }
    records.push(record);
  }
  return records;
}

/**
 * 次のファイルIDを発番する（F+4桁、例：F0001）。
 * これまでの形式変更履歴（F+6桁 → 4桁数字のみ）が混在していても、最大値算出は両方許容する。
 */
function generateNextFileId(sheet, headers) {
  const idColIdx = headers.indexOf("ファイルID");
  const lastRow = sheet.getLastRow();
  let maxNum = 0;

  if (idColIdx !== -1 && lastRow >= 2) {
    const idValues = sheet.getRange(2, idColIdx + 1, lastRow - 1, 1).getValues().map(r => r[0]);
    maxNum = getMaxIdNumber_(idValues, /^F?(\d+)$/);
  }
  return "F" + String(maxNum + 1).padStart(4, "0");
}

/**
 * 【1段目】仮登録として data シートへ高速書き込みする（Drive保存・OCRは含まない）。
 * @param {Object} fData { fileName, mimeType, displayName, links: [{type, id}, ...], sourceKey(任意) }
 *   sourceKey: メール取込など、取込元を特定するキー。同じキーのレコードが既にあれば登録せず、
 *              { duplicate: true } を返す（二重取込の防止。data シートの「取込元メッセージID」列に保存する）
 * @param {string} loginUserName
 * @return {{fileId: string, rowNumber: number}|{duplicate: true}}
 */
function createRecordSheetOnly(fData, loginUserName) {
  return withScriptLock_(10000, () => {
    const sheet = Sheets.data.main();
    const headers = CommonLib.getHeaders(sheet);

    // 取込元キーの重複確認は、ロックの中で行う（同時に動いた処理が、同じ取込元を二重に登録しないため）
    const sourceKey = fData.sourceKey ? String(fData.sourceKey) : "";
    if (sourceKey) {
      const sourceColIdx = headers.indexOf("取込元メッセージID");
      if (sourceColIdx === -1) {
        throw new Error("data シートに「取込元メッセージID」列がありません。ヘッダー行の末尾に追加してください。");
      }
      const lastDataRow = sheet.getLastRow();
      if (lastDataRow >= 2) {
        const existingKeys = sheet.getRange(2, sourceColIdx + 1, lastDataRow - 1, 1).getValues();
        if (existingKeys.some(r => String(r[0]) === sourceKey)) return { duplicate: true };
      }
    }

    const fileId = generateNextFileId(sheet, headers);
    const now = new Date();

    const rowObject = {
      // "F"+4桁の形式のため、Sheets側で数値として自動変換される心配はない
      "ファイルID": fileId,
      "ファイル名": fData.fileName,
      "表示名": fData.displayName || fData.fileName,
      "形式ID": detectFormatId(fData.mimeType),
      // 用途種別・タグはアップロード時にユーザーが選択していればそれを優先し、未選択ならファイル名から自動判定する
      "用途種別ID": fData.useTypeId || detectUseTypeId(fData.fileName),
      "タグID一覧": Array.isArray(fData.tagIds) ? fData.tagIds.join(",") : "",
      "取引先": fData.client || "",
      "発行受領区分": fData.issuedOrReceived || "",
      "適格事業者登録番号": fData.invoiceRegistrationNumber || "",
      ...buildAmountFields_(fData), // 通貨・税率・金額（税抜）・金額（税込）
      "取引日": fData.transactionDate || "",
      "説明・備考": fData.description || "",
      "案件No": normalizeCaseNos_(fData.caseNos).join(","), // 紐付ける案件No（カンマ区切り）
      "DriveファイルURL": "",
      "OCRテキスト（全文）": "",
      "OCR構造化データ（JSON）": "",
      "OCRステータス": "未実施",
      "レコードステータス": "仮登録",
      "元ステータス": "",
      "削除日時": "",
      "アップロード者": loginUserName,
      "作成日時": now,
      "更新日時": now,
      "変更履歴": "",
      "取込元メッセージID": sourceKey
    };

    assertCurrencyColumnExists_(headers, rowObject);

    // 数式として解釈されないよう、値を安全化して書き込む
    const rowValues = headers.map(h => rowObject.hasOwnProperty(h) ? toSafeCellValue_(rowObject[h]) : "");
    const rowNumber = sheet.getLastRow() + 1;
    // 「08」のような数字だけの文字列が数値に変換されないよう、書き込む前に書式を文字列にする
    // （appendRow は書式を指定できないため、同じ末尾の行へ setValues で書き込む）
    const textFormatCells = TEXT_FORMAT_COLUMNS
      .filter(name => headers.indexOf(name) !== -1 && isNumericLikeText_(rowValues[headers.indexOf(name)]))
      .map(name => columnLetter_(headers.indexOf(name) + 1) + rowNumber);
    ensureSheetRowCapacity_(sheet, rowNumber);
    if (textFormatCells.length > 0) sheet.getRangeList(textFormatCells).setNumberFormat("@");
    sheet.getRange(rowNumber, 1, 1, rowValues.length).setValues([rowValues]);

    logGasOperation("ファイル仮登録", loginUserName, [fileId, fData.fileName, "仮登録"]);

    return { fileId: fileId, rowNumber: rowNumber };
  });
}

// 「08」のような数字だけの文字列が、シートへ書き込んだとき数値の 8 に変換されてしまう列。
// 書き込む前に、セルの書式を文字列にしておく（書式を文字列にしたセルは、数字だけの値でも文字列のまま保存される）。
const TEXT_FORMAT_COLUMNS = ["用途種別ID", "形式ID", "案件No"];

/** シートが数値に変換しかねない文字列か（"08"・"12"・"12,15" など） */
function isNumericLikeText_(value) {
  return typeof value === "string" && /^[0-9][0-9.,]*$/.test(value);
}

/** 列番号（1始まり）を、A1形式の列記号にする（1→A、27→AA） */
function columnLetter_(columnNumber) {
  let letters = "";
  for (let n = columnNumber; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/**
 * 書き込もうとしている行の、行番号が、シートの行数を超えないようにする（超える場合は行を足す）。
 * appendRow は行を自動で足すが、getRange().setValues() は足さないため、末尾へ書くときに必要になる。
 */
function ensureSheetRowCapacity_(sheet, requiredLastRow) {
  const maxRows = sheet.getMaxRows();
  if (requiredLastRow > maxRows) sheet.insertRowsAfter(maxRows, requiredLastRow - maxRows);
}

/**
 * 指定行の指定列だけをまとめて更新する共通処理。
 *
 * 【速度改善】
 * 以前は項目ごとに setValue（= Sheets APIの呼び出し）を行っていたため、項目数に比例して遅くなっていた。
 * 更新対象の列のうち「隣り合う列」を1回の setValues にまとめて書き込む。
 * 更新しない列には一切触れないため、他の列の値・数式・手動編集の内容は変わらない。
 *
 * @param {Sheet} sheet data シート
 * @param {Array<string>} headers ヘッダー行
 * @param {number} rowNumber 更新する行番号（1始まり）
 * @param {Object} fieldValues { 列名: 値 }（ヘッダーに無い列名は無視する）
 */
function updateFieldsByRow(sheet, headers, rowNumber, fieldValues) {
  // 更新対象を「列番号 + 値」にして、列の昇順に並べる
  const cells = [];
  const textFormatCells = []; // 数値に変換されかねない文字列を書き込む、セルのA1形式
  Object.keys(fieldValues).forEach(fieldName => {
    const colIdx = headers.indexOf(fieldName);
    if (colIdx === -1) return;
    const value = toSafeCellValue_(fieldValues[fieldName]); // 数式として解釈されないようにする
    cells.push({ col: colIdx + 1, value: value });
    if (TEXT_FORMAT_COLUMNS.indexOf(fieldName) !== -1 && isNumericLikeText_(value)) {
      textFormatCells.push(columnLetter_(colIdx + 1) + rowNumber);
    }
  });
  if (cells.length === 0) return;
  // 「08」のような数字だけの文字列が数値に変換されないよう、書き込む前に書式を文字列にする（1回の呼び出しにまとめる）
  if (textFormatCells.length > 0) sheet.getRangeList(textFormatCells).setNumberFormat("@");
  cells.sort((a, b) => a.col - b.col);

  // 隣り合う列ごとにグループ化し、グループ単位で1回ずつ書き込む
  let groupStart = 0;
  for (let i = 1; i <= cells.length; i++) {
    const isGroupEnd = i === cells.length || cells[i].col !== cells[i - 1].col + 1;
    if (!isGroupEnd) continue;

    const group = cells.slice(groupStart, i);
    sheet.getRange(rowNumber, group[0].col, 1, group.length).setValues([group.map(c => c.value)]);
    groupStart = i;
  }
}

/**
 * 画面から渡された行番号（rowNumber）の行を読み込み、ファイルIDが一致することを検証して返す。
 *
 * 【なぜ必要か】
 * 画面は「行番号」で更新対象を指定する。シートを手で並べ替えたり行を削除したりすると、
 * 画面が持っている行番号と実際の行がずれ、別のファイルを更新・削除してしまう恐れがある。
 * そのため、行番号の行のファイルIDが画面の想定と同じかを必ず確認する。
 * 一致しない場合は何も書き込まずにエラーにし、画面の再読み込みを促す。
 *
 * @param {Sheet} sheet data シート
 * @param {Array<string>} headers ヘッダー行
 * @param {Object} fData { fileId, rowNumber }
 * @return {Array} その行の値（1次元配列）
 */
function getVerifiedRecordRow_(sheet, headers, fData) {
  const staleMessage = "一覧の内容が古い可能性があります。画面を再読み込みしてから、もう一度お試しください。";
  const rowNumber = Number(fData && fData.rowNumber);
  const fileIdIdx = headers.indexOf("ファイルID");
  if (!Number.isInteger(rowNumber) || rowNumber < 2 || fileIdIdx === -1) {
    throw new Error(staleMessage);
  }

  const row = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  if (String(row[fileIdIdx]) !== String(fData.fileId)) {
    throw new Error(staleMessage);
  }
  return row;
}

/**
 * 【2段目】が失敗したとき、レコードを「処理中」のまま固まらせないよう「失敗」状態へ戻す。
 * この関数自身はロックを取得する（呼び出し元はロックを持っていない状態で呼ぶこと）。
 * 行番号がずれていて別のファイルを書き換えてしまわないよう、ファイルIDを照合してから書き込む。
 * ここで更に失敗しても、元のエラーを優先して呼び出し元へ伝えるため握りつぶす。
 */
function markBackgroundTaskFailedSafely_(fData, uploadedFile, error) {
  try {
    withScriptLock_(30000, () => {
      const sheet = Sheets.data.main();
      const headers = CommonLib.getHeaders(sheet);
      getVerifiedRecordRow_(sheet, headers, fData); // ずれていれば例外になり、何も書き込まない

      const fields = {
        "OCRステータス": "失敗",
        "OCRテキスト（全文）": `処理エラー: ${error.message}`, // 画面の詳細モーダルで原因を確認できるようにする
        "更新日時": new Date()
      };
      // Driveへの保存まで成功していた場合は、保存済みファイルとの紐付けを残す
      if (uploadedFile) {
        fields["DriveファイルURL"] = uploadedFile.driveFileUrl;
      }
      updateFieldsByRow(sheet, headers, fData.rowNumber, fields);
    });
  } catch (e) {
    console.error(`失敗状態への更新にも失敗しました（行${fData.rowNumber}）: ${e.message}`);
  }
}

// 「処理中」のまま、この分数を超えて更新されていないレコードは、
// 実行が途中で止まった（GASの6分制限・通信切断など）ものとみなし、再処理を許可する。
// GASの1回の実行は最大6分のため、それより長い10分とする。
const BACKGROUND_TASK_STALE_MINUTES = 10;

/** 「処理中」の開始から時間が経ちすぎていて、実行が止まったとみなせるか（日時が読めない場合も止まったとみなす） */
function isBackgroundTaskStale_(updatedAtValue) {
  const updatedAt = updatedAtValue instanceof Date ? updatedAtValue : new Date(updatedAtValue);
  if (isNaN(updatedAt.getTime())) return true;
  return (Date.now() - updatedAt.getTime()) > BACKGROUND_TASK_STALE_MINUTES * 60 * 1000;
}

/**
 * 実際に処理が進行中（OCRステータスが「処理中」で、かつ時間切れでない）かを判定する。
 * 編集・確定保存・ゴミ箱移動・ZIPの可否は、すべてこの関数で判定する（画面の表示と同じ基準にそろえるため）。
 */
function isOcrProcessingActive_(ocrStatus, updatedAtValue) {
  return ocrStatus === "処理中" && !isBackgroundTaskStale_(updatedAtValue);
}

/**
 * 【2段目・段階1】処理を開始してよいか検証し、レコードを「処理中」にして予約する（ロック内で呼ぶこと）。
 * 同じファイルに対してこの処理が重複して呼ばれた場合（通信エラーによる再送・二重クリックなど）に、
 * Driveへの二重保存・OCRの二重実行を防ぐのが目的。
 * @return {{skipResult: Object}|{useTypeId: string}}
 *   skipResult がある場合は、処理せずそれを呼び出し元へ返す（エラーではなく成功として扱う）。
 */
function reserveBackgroundTask_(fData) {
  const sheet = Sheets.data.main();
  const headers = CommonLib.getHeaders(sheet);
  // 行ずれによる別ファイルへの書き込みを防ぐため、ファイルIDを照合する
  const row = getVerifiedRecordRow_(sheet, headers, fData);

  const status = row[headers.indexOf("レコードステータス")];
  const ocrStatus = row[headers.indexOf("OCRステータス")];
  const driveFileUrl = row[headers.indexOf("DriveファイルURL")];
  const updatedAt = row[headers.indexOf("更新日時")];

  // すでにDriveへ保存済み＝以前の呼び出しで処理済み。再送された重複呼び出しなので、何もせず成功を返す
  if (driveFileUrl) {
    return { skipResult: { success: true, ocrStatus: ocrStatus, alreadyProcessed: true } };
  }
  if (status !== "仮登録") {
    throw new Error("仮登録中のファイルのみ保存処理を実行できます。（既に確定済み、またはゴミ箱へ移動済みの可能性があります）");
  }
  // 別の呼び出しが処理中（時間切れとみなせる場合を除く）。二重に実行せず、完了を待つよう伝える
  if (isOcrProcessingActive_(ocrStatus, updatedAt)) {
    return { skipResult: { success: true, ocrStatus: ocrStatus, inProgress: true } };
  }

  // OCRを使わない場合も「処理中」にする。Drive保存の最中に、確定保存・ゴミ箱移動・重複実行が
  // 割り込めないようにするため（最終的な状態は段階3で「スキップ」などに更新する）
  updateFieldsByRow(sheet, headers, fData.rowNumber, { "OCRステータス": "処理中", "更新日時": new Date() });
  return { useTypeId: String(row[headers.indexOf("用途種別ID")] || "") };
}

/**
 * OCRの構造化データを、シートへ書き込める形式に整える（ロックの外で呼ぶ）。
 * ・金額・日付・登録番号の形式を揃え、揃えられない値は反映しない（sanitizeStructuredData_）
 * ・Geminiが判定した用途種別IDが、用途種別マスタに存在しない場合は反映しない
 *   （削除された種別や、AIの誤出力が保存されるのを防ぐ）
 */
function finalizeOcrResult_(ocrResult) {
  if (!ocrResult.structuredData) return ocrResult;
  const cleaned = sanitizeStructuredData_(ocrResult.structuredData);

  if (cleaned.detectedUseTypeId) {
    let isKnown = false;
    try {
      isKnown = loadUseTypeMaster().some(u => u.useTypeId === cleaned.detectedUseTypeId);
    } catch (e) {
      console.error(`用途種別マスタの確認に失敗しました。判定結果は反映しません: ${e.message}`);
    }
    if (!isKnown) cleaned.detectedUseTypeId = "";
  }
  return Object.assign({}, ocrResult, { structuredData: cleaned });
}

/**
 * 【2段目・段階3】Drive保存とOCRの結果を、シートへ書き込む（ロック内で呼ぶこと）。
 */
function saveBackgroundTaskResult_(fData, uploadedFile, ocrResult) {
  const sheet = Sheets.data.main();
  const headers = CommonLib.getHeaders(sheet);
  // 段階2（ロックの外）の間に行がずれていないか、書き込む直前にもう一度ファイルIDを照合する
  const row = getVerifiedRecordRow_(sheet, headers, fData);

  const useTypeIdColIdx = headers.indexOf("用途種別ID");
  const currentUseTypeId = useTypeIdColIdx !== -1 ? String(row[useTypeIdColIdx] || "") : "";
  const displayNameColIdx = headers.indexOf("表示名");
  const fileNameColIdx = headers.indexOf("ファイル名");
  const currentDisplayName = displayNameColIdx !== -1 ? String(row[displayNameColIdx] || "") : "";
  const currentFileName = fileNameColIdx !== -1 ? String(row[fileNameColIdx] || "") : "";
  // 登録時に空欄だった表示名は、ファイル名が入る。ファイル名と違う名前が入っていれば、ユーザーが入力した表示名
  const hasUserDisplayName = currentDisplayName !== "" && currentDisplayName !== currentFileName;
  const taxRateColIdx = headers.indexOf("税率");
  const currentTaxRate = taxRateColIdx !== -1 ? row[taxRateColIdx] : ""; // 空なら10%として扱われる
  const currencyColIdx = headers.indexOf("通貨");
  const currentCurrency = currencyColIdx !== -1 ? row[currencyColIdx] : ""; // 空なら円として扱われる

  const fieldsToUpdate = {
    "DriveファイルURL": uploadedFile.driveFileUrl,
    "OCRテキスト（全文）": ocrResult.text,
    "OCRステータス": ocrResult.status,
    "更新日時": new Date()
  };

  // 構造化データが取得できた場合、入力項目へ反映する。
  // アップロード時はOCR有効なら該当入力欄をフロント側で閉じているため、
  // ユーザー入力との競合（どちらを優先するか）は発生しない前提。
  // ただし表示名だけは、OCRが有効でも画面で入力できる。ユーザーが入力した表示名があれば、OCRの表示名で上書きしない
  // （用途種別で、ユーザーの選択をOCRの判定より優先するのと同じ考え方）。
  if (ocrResult.structuredData) {
    const s = ocrResult.structuredData;

    // 用途種別が未設定だった場合のみ、Geminiが判定した種別をシートへ反映する。
    // ユーザーが既に種別を選択済みの場合は、判定結果があっても上書きしない（誤判定によるユーザー選択の巻き戻り防止）。
    if (!currentUseTypeId && s.detectedUseTypeId) {
      fieldsToUpdate["用途種別ID"] = s.detectedUseTypeId;
    }

    if (s.displayName && !hasUserDisplayName) fieldsToUpdate["表示名"] = s.displayName;
    if (s.client) fieldsToUpdate["取引先"] = s.client;
    if (s.invoiceRegistrationNumber) fieldsToUpdate["適格事業者登録番号"] = s.invoiceRegistrationNumber;
    if (s.amount !== "") {
      // OCRの金額は、登録時に選ばれた通貨（未設定なら円）の税込金額として扱い、税抜は登録時の税率（未設定なら10%）から計算する。
      // 0円も有効な値として反映する
      Object.assign(fieldsToUpdate, buildAmountFields_({ currency: currentCurrency, taxRate: currentTaxRate, amountIncl: s.amount }));
    }
    if (s.transactionDate) fieldsToUpdate["取引日"] = s.transactionDate;
  }

  updateFieldsByRow(sheet, headers, fData.rowNumber, fieldsToUpdate);
}

/**
 * 【2段目】Drive保存＋OCR全文抽出・構造化抽出（バックグラウンド処理）。
 * この間、OCRステータスを「処理中」にすることで一覧上での編集ロックを実現する（設計書9-2）。
 * @param {Object} fData { fileId, rowNumber, base64, mimeType, fileName, useOcr }
 *   useOcr: false の場合はOCRを実行せず「スキップ」として保存する（アップロード前にユーザーが選択）
 * @return {{success: boolean, ocrStatus: string, alreadyProcessed?: boolean, inProgress?: boolean}}
 *
 * 【処理を3段階に分けている理由（ロックについて）】
 * Drive保存とGemini呼び出しは数秒〜数十秒かかる。以前はこの全体を1つのロックで囲んでいたため、
 * その間は他のユーザーの確定保存・ゴミ箱移動・ログインまで待たされ、タイムアウトしていた。
 * GASのロックは行単位にできない（プロジェクト全体で1つ）ため、ロックは「短い書き込み」だけに使う。
 *   段階1（ロックあり・短時間）：検証して、レコードを「処理中」にする（＝他の呼び出しへの目印）
 *   段階2（ロックなし・長時間）：Driveへ保存し、OCRを実行する
 *   段階3（ロックあり・短時間）：結果をシートへ書き込む
 * 同じファイルに対する多重実行は、ロックではなく段階1の「処理中」の目印で防ぐ。
 * 段階2・3が失敗した場合は、必ず「失敗」状態へ戻してから、エラーを呼び出し元へ伝える
 * （「処理中」のまま固まると、編集もゴミ箱移動もできなくなるため）。
 */
function processBackgroundTasks(fData, loginUserName) {
  const useOcr = fData.useOcr !== false; // 未指定時は従来通り実行する

  // 【段階1】
  const reservation = withScriptLock_(15000, () => reserveBackgroundTask_(fData));
  if (reservation.skipResult) return reservation.skipResult;

  // 【段階2】ロックの外で、時間のかかる処理を行う
  let uploadedFile = null;
  let ocrResult;
  try {
    uploadedFile = uploadFileToFlatFolder(fData.base64, fData.fileName, fData.mimeType);

    // 全文テキスト・構造化データ（未設定の場合は書類種別の自動判定も含む）を1回のGemini呼び出しで取得する。
    // Driveから読み直さず、受け取ったBase64をそのまま使う
    ocrResult = useOcr
      ? extractDocumentData(fData.base64, fData.mimeType, reservation.useTypeId)
      : { text: "", status: "スキップ", structuredData: null };
    ocrResult = finalizeOcrResult_(ocrResult);
  } catch (e) {
    markBackgroundTaskFailedSafely_(fData, uploadedFile, e);
    throw e;
  }

  // 【段階3】
  try {
    withScriptLock_(30000, () => saveBackgroundTaskResult_(fData, uploadedFile, ocrResult));
  } catch (e) {
    markBackgroundTaskFailedSafely_(fData, uploadedFile, e);
    throw e;
  }

  logGasOperation("バックグラウンド処理完了", loginUserName,
    [fData.fileId, "OCRステータス", ocrResult.status]);

  return { success: true, ocrStatus: ocrResult.status };
}

/**
 * 【確定保存】仮登録 → 通常 へレコードステータスを変更し、ユーザーの確認・修正内容を反映する。
 * 案件Noが付いている場合は、ファイルを案件フォルダの種別フォルダへ移動してから、シートを書き換える。
 * @param {Object} fData { fileId, rowNumber, displayName, useTypeId, tagIds(配列), description,
 *                          client, issuedOrReceived, invoiceRegistrationNumber, currency, taxRate,
 *                          amountExcl, amountIncl, transactionDate, caseNos(配列) }
 *
 * 【処理を3段階に分けている理由（ロックについて）】
 * ファイルの移動（案件フォルダ・種別フォルダの作成を含む）は、Driveの操作で数秒かかることがある。
 * ロックを持ったまま行うと、他のユーザーの操作やログインまで待たされるため（processBackgroundTasks と同じ方針）、
 *   段階1（ロックあり・短時間）：状態の検証と、保存する内容の検査
 *   段階2（ロックなし）　　　　：ファイルの移動（失敗した場合はここで例外になり、シートは変更されない）
 *   段階3（ロックあり・短時間）：状態を再確認して、シートへ書き込む
 */
function confirmRecord(fData, loginUserName) {
  // 【段階1】
  const prepared = withScriptLock_(10000, () => {
    const sheet = Sheets.data.main();
    const headers = CommonLib.getHeaders(sheet);
    const row = getVerifiedRecordRow_(sheet, headers, fData);
    assertRecordConfirmable_(headers, row);

    const editableFields = buildEditableFields(fData);
    assertCurrencyColumnExists_(headers, editableFields);
    return { sheet: sheet, headers: headers, row: row, editableFields: editableFields };
  });

  // 【段階2】
  placeFileForSavedRecord_(prepared.headers, prepared.row, fData, prepared.editableFields, loginUserName);

  // 【段階3】
  return withScriptLock_(10000, () => {
    const row = getVerifiedRecordRow_(prepared.sheet, prepared.headers, fData);
    assertRecordConfirmable_(prepared.headers, row); // 段階2の間に、別の操作で状態が変わっていないか再確認する

    updateFieldsByRow(prepared.sheet, prepared.headers, fData.rowNumber, Object.assign(
      {}, prepared.editableFields,
      { "レコードステータス": "通常", "更新日時": new Date() }
    ));
    logGasOperation("確定保存", loginUserName, [fData.fileId, "仮登録→通常"]);
    return { success: true };
  });
}

/** 確定保存してよい状態か検査する（ロックの中で呼ぶこと）。問題があれば例外 */
function assertRecordConfirmable_(headers, row) {
  const statusIdx = headers.indexOf("レコードステータス");
  const ocrStatusIdx = headers.indexOf("OCRステータス");
  const driveUrlIdx = headers.indexOf("DriveファイルURL");
  const updatedIdx = headers.indexOf("更新日時");

  // 防御的チェック：フロント制御だけに依存せず、サーバー側でも編集ロックを検証する（設計書9-2）
  if (isOcrProcessingActive_(row[ocrStatusIdx], row[updatedIdx])) {
    throw new Error("OCR処理中のため確定保存できません。処理完了後に再度お試しください。");
  }
  if (row[statusIdx] !== "仮登録") {
    throw new Error("このファイルは既に確定済みです。");
  }
  // Driveへの保存が終わっていないレコード（登録直後に画面を閉じた・保存に失敗した場合など）を確定すると、
  // ファイルの実体が無い「通常」レコードができてしまうため確定させない
  if (!row[driveUrlIdx]) {
    throw new Error("ファイルの保存が完了していないため、確定保存できません。（保存に失敗している場合は、ゴミ箱へ移動して登録し直してください）");
  }
}

/**
 * 【編集】確定済み（レコードステータス=通常）ファイルの内容を更新する。
 * 案件Noまたは用途種別が変わった場合は、ファイルを新しい場所へ移動してから、シートを書き換える。
 * 処理の段階分けは confirmRecord と同じ。
 * @param {Object} fData 上記confirmRecordと同じ形式
 */
function updateRecord(fData, loginUserName) {
  // 【段階1】
  const prepared = withScriptLock_(10000, () => {
    const sheet = Sheets.data.main();
    const headers = CommonLib.getHeaders(sheet);
    const row = getVerifiedRecordRow_(sheet, headers, fData);
    assertRecordEditable_(headers, row);

    const editableFields = buildEditableFields(fData);
    assertCurrencyColumnExists_(headers, editableFields);
    return { sheet: sheet, headers: headers, row: row, editableFields: editableFields };
  });

  // 【段階2】
  placeFileForSavedRecord_(prepared.headers, prepared.row, fData, prepared.editableFields, loginUserName);

  // 【段階3】
  return withScriptLock_(10000, () => {
    const row = getVerifiedRecordRow_(prepared.sheet, prepared.headers, fData);
    assertRecordEditable_(prepared.headers, row); // 段階2の間に、別の操作で状態が変わっていないか再確認する

    updateFieldsByRow(prepared.sheet, prepared.headers, fData.rowNumber, Object.assign(
      {}, prepared.editableFields,
      { "更新日時": new Date() }
    ));
    logGasOperation("ファイル更新", loginUserName, [fData.fileId, "内容更新"]);
    return { success: true };
  });
}

/** 編集してよい状態か検査する（ロックの中で呼ぶこと）。問題があれば例外 */
function assertRecordEditable_(headers, row) {
  if (row[headers.indexOf("レコードステータス")] !== "通常") {
    throw new Error("確定済みのファイルのみ編集できます。");
  }
}

/**
 * 保存しようとしている内容に合わせて、ファイルを案件フォルダへ移動する（confirmRecord・updateRecord の段階2）。
 * ・案件Noが保存の前後とも無いファイルは、Driveに触らない（これまでどおり、ルートフォルダの直下のまま）
 * ・案件Noが画面から渡されない場合は、今の案件Noのままとして扱う
 * ・案件に紐付いているときは、置いた後のファイル名（命名規則の名前）を、editableFields の「表示名」に上書きする。
 *   画面では、紐付け中は表示名を手入力できない。画面を通さない呼び出しでも同じになるよう、サーバー側でも上書きする。
 *   案件Noを外したときは「表示名」に触らない（画面から渡された表示名がそのまま保存される）。
 * ロックを持たない状態で呼ぶこと。失敗した場合は例外になる（呼び出し元は、この後にシートを書き換える）。
 * @param {Array<string>} headers data シートのヘッダー行
 * @param {Array} row 保存前のレコード行
 * @param {Object} fData 画面から渡された値
 * @param {Object} editableFields buildEditableFields の結果（保存する内容）
 */
function placeFileForSavedRecord_(headers, row, fData, editableFields, loginUserName) {
  const cell = (name) => row[headers.indexOf(name)];
  const caseNosBefore = splitCaseNos_(cell("案件No"));
  const caseNosAfter = editableFields["案件No"] !== undefined ? splitCaseNos_(editableFields["案件No"]) : caseNosBefore;
  if (caseNosBefore.length === 0 && caseNosAfter.length === 0) return;

  const placed = placeFileForRecord_({
    fileId: fData.fileId,
    driveFileUrl: cell("DriveファイルURL"),
    caseNos: caseNosAfter,
    useTypeId: editableFields["用途種別ID"],
    uploader: cell("アップロード者"),
    originalName: cell("ファイル名"),
    loginUserName: loginUserName
  });

  if (caseNosAfter.length > 0 && placed.fileName) editableFields["表示名"] = placed.fileName;
}

/**
 * confirmRecord・updateRecordで共通して更新するフィールド一式を組み立てる。
 * 両者で保存対象の項目が完全に同じため、二重管理を避けるためここに集約する。
 */
function buildEditableFields(fData) {
  // 発行／受領は必須。画面の入力チェックに加えて、サーバー側でも未選択・不正な値を拒否する
  if (fData.issuedOrReceived !== "発行" && fData.issuedOrReceived !== "受領") {
    throw new Error("発行／受領を選択してください。");
  }

  const fields = Object.assign({
    "表示名": fData.displayName,
    "用途種別ID": fData.useTypeId || "",
    "タグID一覧": Array.isArray(fData.tagIds) ? fData.tagIds.join(",") : "",
    "取引先": fData.client || "",
    "発行受領区分": fData.issuedOrReceived || "",
    "適格事業者登録番号": fData.invoiceRegistrationNumber || "",
    "取引日": fData.transactionDate || "",
    "説明・備考": fData.description || ""
  }, buildAmountFields_(fData)); // 通貨・税率・金額（税抜）・金額（税込）

  // 案件Noは、画面から一覧（caseNos）が渡された場合のみ更新する（渡されない場合は、今の値を変えない）
  if (Array.isArray(fData.caseNos)) {
    fields["案件No"] = normalizeCaseNos_(fData.caseNos).join(",");
  }
  return fields;
}

// =====================================
// 通貨・税率・金額（税抜／税込）の検査と補完
// 画面（03_utils.js の bindTaxInputs）と同じ計算規則：通貨の最小単位（円なら1円、ドルなら1セント）未満は、
//   ・税抜から税込を計算するときは切り捨て　・税込から税抜を計算するときは切り上げ
// 不課税は税率0%扱い。計算は「最小単位の整数」で行う（小数のまま計算すると、誤差で1セントずれることがあるため）。
// =====================================
const TAX_RATE_NON_TAXABLE = "不課税"; // 税率の保存値（それ以外は 1〜10 の数値）
const DEFAULT_TAX_RATE = 10;           // 税率が未指定のときの値

// 通貨コード → 小数の桁数。画面側（03_utils.js の CURRENCIES）と必ずそろえること
const DEFAULT_CURRENCY = "JPY";        // 通貨が未指定のときの値（円）
const CURRENCY_DECIMALS_ = { JPY: 0, USD: 2, EUR: 2, GBP: 2, CNY: 2, AUD: 2, KRW: 0 };

/** 通貨の入力値を通貨コードに揃える。空は円、リストにない値は例外 */
function normalizeCurrency_(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (text === "") return DEFAULT_CURRENCY;
  if (!CURRENCY_DECIMALS_.hasOwnProperty(text)) {
    throw new Error("通貨は " + Object.keys(CURRENCY_DECIMALS_).join("・") + " のいずれかで指定してください。");
  }
  return text;
}

/**
 * 通貨が円以外なのに data シートに「通貨」列が無いと、通貨が保存されず、金額が円として扱われてしまう。
 * その場合は、誤ったデータを残さないよう、保存せずにエラーにする。
 * @param {Array<string>} headers data シートのヘッダー行
 * @param {Object} fields 保存しようとしている項目（"通貨" を含む）
 */
function assertCurrencyColumnExists_(headers, fields) {
  if (fields["通貨"] !== DEFAULT_CURRENCY && headers.indexOf("通貨") === -1) {
    throw new Error("data シートに「通貨」列がありません。ヘッダー行に「通貨」列を追加してください。");
  }
}

/** 税率の入力値を保存値（"不課税" または 1〜10 の数値）に揃える。空は10%、不正な値は例外 */
function normalizeTaxRate_(value) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (text === "") return DEFAULT_TAX_RATE;
  if (text === TAX_RATE_NON_TAXABLE) return text;
  const num = Number(text);
  if (Number.isInteger(num) && num >= 1 && num <= 10) return num;
  throw new Error("税率は「不課税」または1〜10で指定してください。");
}

/**
 * 金額の入力値を、最小単位（円・セント）の整数にする。空は null、数値でない・負の値は例外。
 * 最小単位未満は切り捨てる。小数は文字列のまま桁で扱う（1.15 × 100 のような計算は 114.99… と誤差が出るため）。
 * @param {string|number} value 金額（例："1234.56"）
 * @param {number} decimals 通貨の小数桁数
 */
function parseAmountMinor_(value, decimals) {
  const text = String(value === null || value === undefined ? "" : value).trim();
  if (text === "") return null;
  const factor = Math.pow(10, decimals);

  const match = text.match(/^(\d+)(?:\.(\d*))?$/);
  if (match) {
    const fraction = (match[2] || "").slice(0, decimals).padEnd(decimals, "0");
    return Number(match[1]) * factor + Number(fraction);
  }

  // 「1e+21」のような指数表記など、上の形式に当てはまらない値は、数値として読めるかだけ確認する
  const num = Number(text);
  if (!isFinite(num) || num < 0) throw new Error("金額は0以上の数値で入力してください。");
  return Math.floor(num * factor);
}

/** 最小単位の整数を、シートへ保存する金額（円なら整数、ドルなら 12.34 のような小数）にする */
function minorToAmount_(minor, decimals) {
  return minor / Math.pow(10, decimals);
}

/** 整数同士の割り算の商（切り捨て）。小数の誤差を避けるため、余りを引いてから割る */
function floorDiv_(dividend, divisor) {
  return (dividend - (dividend % divisor)) / divisor;
}

/** 整数同士の割り算の商（切り上げ）。税込から税抜を求めるときに使う */
function ceilDiv_(dividend, divisor) {
  return floorDiv_(dividend + divisor - 1, divisor);
}

/**
 * 画面から渡された通貨・税率・金額を検査し、data シートへ書き込む4項目にして返す。
 * ・片方の金額だけが渡された場合（OCR・Gmail取込など画面を通らない登録を含む）は、もう一方を計算して補う
 * ・両方渡された場合は、画面で確定した値をそのまま保存する
 * ・通貨が空の場合は円として扱う
 * @param {{currency: string, taxRate: (string|number), amountExcl: (string|number), amountIncl: (string|number)}} fData
 * @return {Object} {"通貨", "税率", "金額（税抜）", "金額（税込）"}
 */
function buildAmountFields_(fData) {
  const currency = normalizeCurrency_(fData.currency);
  const decimals = CURRENCY_DECIMALS_[currency];
  const rate = normalizeTaxRate_(fData.taxRate);
  const percent = rate === TAX_RATE_NON_TAXABLE ? 0 : rate;
  let excl = parseAmountMinor_(fData.amountExcl, decimals);
  let incl = parseAmountMinor_(fData.amountIncl, decimals);

  if (excl !== null && incl === null) incl = floorDiv_(excl * (100 + percent), 100);
  if (incl !== null && excl === null) excl = ceilDiv_(incl * 100, 100 + percent); // 税込から求める税抜は切り上げ

  return {
    "通貨": currency,
    "税率": rate,
    "金額（税抜）": excl === null ? "" : minorToAmount_(excl, decimals),
    "金額（税込）": incl === null ? "" : minorToAmount_(incl, decimals)
  };
}

// =====================================
// 案件No（data シートの「案件No」列：カンマ区切り。例："12,15"）の検査
// =====================================
// 誤入力・過大な入力でセルが膨らむのを防ぐ上限
const CASE_NO_MAX_COUNT = 50;  // 1ファイルに紐付けられる案件Noの数
const CASE_NO_MAX_LENGTH = 50; // 案件No1件の文字数

/** data シートの「案件No」列の値（カンマ区切り。例："12,15"）を、文字列の配列にする（空は空配列） */
function splitCaseNos_(value) {
  return String(value === null || value === undefined ? "" : value)
    .split(",").map(caseNo => caseNo.trim()).filter(Boolean);
}

/**
 * 画面から渡された案件No一覧を、保存できる形（空・重複を除いた文字列の配列）にする。
 * 配列でない場合（未指定など）は空として扱う。上限を超える場合や、区切りのカンマを含む場合は例外にする。
 * @param {Array<string|number>} caseNos 案件Noの一覧
 * @return {Array<string>}
 */
function normalizeCaseNos_(caseNos) {
  if (!Array.isArray(caseNos)) return [];
  const result = [];
  caseNos.forEach(raw => {
    const caseNo = String(raw === null || raw === undefined ? "" : raw).trim();
    if (!caseNo || result.includes(caseNo)) return;
    if (caseNo.includes(",")) throw new Error("案件Noにカンマ（,）は使用できません。");
    if (caseNo.length > CASE_NO_MAX_LENGTH) {
      throw new Error(`案件Noは${CASE_NO_MAX_LENGTH}文字以内で入力してください。`);
    }
    result.push(caseNo);
  });
  if (result.length > CASE_NO_MAX_COUNT) {
    throw new Error(`紐付けできる案件Noは1ファイルにつき${CASE_NO_MAX_COUNT}件までです。`);
  }
  return result;
}
