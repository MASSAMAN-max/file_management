/**
 * =====================================================================
 * lib/osdCore.js
 * =====================================================================
 * Tesseract OSD（向き・文字種の判定）で、画像・PDFの向きを調べる（ファイルの中身だけを扱う。通信は行わない）
 * =====================================================================
 * 【角度の意味】rotateCore.js と同じ。「画像を時計回りに何度回すと、文字が正しい向き（上が天）になるか」（0 / 90 / 180 / 270）。
 *   Tesseract の orientation_degrees が、そのままこの意味（日本語の見積書で、4方向とも確認済み）。
 *
 * 【扱う形式】
 *   ・画像：JPEG / PNG / WebP … EXIFの向きを反映した「見た目の向き」で判定する（EXIFの有無は exifOrientation に返す）
 *   ・PDF　：先頭 MAX_PDF_PAGES ページを、pdfjs で画像にしてから判定する。
 *            ページの /Rotate や、描画の向きの指定も反映した「見た目の向き」で判定する（Geminiが見る向きと同じ）
 *
 * 【前処理を変えて、複数回判定する】実際の注文書（手書き・印鑑・かすれあり）で、画像をそのまま渡すと、判定できない・
 *   間違えることが分かった（信頼度0.3〜0.7で、間違った角度を返すこともある）。同じ書類を、二値化（白黒にする）してから渡すと、
 *   4方向とも正解した（信頼度1.9〜6.0）。書類によって効く前処理が違うため、次の3通りで判定して、結果をすべて返す（attempts）。
 *     raw       … そのまま
 *     sharpen   … コントラストを広げて、輪郭を強める
 *     binarize  … コントラストを広げて、白黒にする
 *   代表の角度は、信頼度が一番高いものにする。
 *
 * 【この関数は「判定するだけ」】角度の採用・不採用（信頼度の基準など）は決めない。
 *   信頼度（confidence）・文字種（script）を、そのまま返す。採用の基準は、呼び出し側（GAS の 18_画像向き補正.js）が決める。
 *   判定できなかったページは、rotation を null にして、reason に理由を入れる。
 *
 * 【速度】Tesseractのワーカーは、関数が温まっている間は使い回す（起動に約0.3秒かかるため）。
 *   学習データ（tessdata/osd.traineddata）は、デプロイに含める（vercel.json の includeFiles）。
 */
const path = require("path");
const sharp = require("sharp");
const { createWorker, OEM, PSM } = require("tesseract.js");

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_PDF_PAGES = 3;          // 判定するPDFのページ数（先頭から）。処理時間を抑えるための上限
const MAX_SIDE_PX = 1600;         // 判定に使う画像の長辺。大きくしても判定は変わらず、遅くなるだけ
const TESSDATA_DIR = path.join(__dirname, "..", "tessdata"); // osd.traineddata を置くフォルダ
const TESSERACT_CACHE_DIR = "/tmp/tesseract-cache";          // Vercelで書き込める場所は /tmp だけ

// ---------------------------------------------------------------------
// Tesseractのワーカー（使い回す）
// ---------------------------------------------------------------------
let workerPromise = null;

/** OSD専用のワーカーを返す。失敗したときは、次回あらためて作り直す */
function getOsdWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // OSD は、旧式のエンジン（legacy）でしか動かないため、legacyCore / legacyLang が必要
      const worker = await createWorker("osd", OEM.TESSERACT_ONLY, {
        langPath: TESSDATA_DIR, gzip: false, legacyCore: true, legacyLang: true, cachePath: TESSERACT_CACHE_DIR
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.OSD_ONLY });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

// 前処理の種類。sharp のパイプラインを受け取って、処理を足して返す（binarize のしきい値170は、1種類の書類で確認した値）
const PREPROCESS_VARIANTS = [
  { name: "raw", apply: (s) => s },
  { name: "sharpen", apply: (s) => s.grayscale().normalise().sharpen() },
  { name: "binarize", apply: (s) => s.grayscale().normalise().threshold(170) }
];

/** 判定用の画像（PNG）1枚を、Tesseractに1回かける。判定できなければ rotation は null */
async function detectOnce(png) {
  const worker = await getOsdWorker();
  try {
    const { data } = await worker.detect(png);
    // 文字がほとんど無いページ（白紙など）は、例外にならず、角度が空で返ってくる
    if (data.orientation_degrees === null || data.orientation_degrees === undefined) {
      return { rotation: null, reason: "no-osd-result" };
    }
    return {
      rotation: data.orientation_degrees,
      confidence: data.orientation_confidence,
      script: data.script,
      scriptConfidence: data.script_confidence
    };
  } catch (e) {
    // 文字が少ない・罫線だけのページなどは、Tesseractが判定できずに例外になることがある
    return { rotation: null, reason: "osd-failed", message: e && e.message ? e.message : String(e) };
  }
}

/**
 * 判定用の画像（PNG）1枚について、前処理を変えて判定する。
 * 戻り値：代表の結果（信頼度が一番高い前処理）に、すべての結果（attempts）を付ける。どれも判定できなければ rotation は null
 */
async function detectFromPng(png) {
  const attempts = [];
  for (const variant of PREPROCESS_VARIANTS) {
    const input = variant.name === "raw" ? png : await variant.apply(sharp(png)).png().toBuffer();
    attempts.push(Object.assign({ variant: variant.name }, await detectOnce(input)));
  }
  const usable = attempts.filter(a => a.rotation !== null);
  if (usable.length === 0) return { rotation: null, reason: attempts[0].reason, attempts: attempts };
  const best = usable.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  return { rotation: best.rotation, confidence: best.confidence, script: best.script, scriptConfidence: best.scriptConfidence, bestVariant: best.variant, attempts: attempts };
}

// ---------------------------------------------------------------------
// 画像
// ---------------------------------------------------------------------
async function detectImage(bytes) {
  const meta = await sharp(bytes).metadata();
  const png = await sharp(bytes)
    .rotate() // EXIFの向きを反映する（見た目の向きで判定するため）
    .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: "inside" }) // 小さい画像は拡大する（拡大しないと、文字が少ないと判定されることがあった）
    .flatten({ background: "#ffffff" }) // 透過PNGの背景は白にする
    .grayscale()
    .png()
    .toBuffer();
  const result = await detectFromPng(png);
  return Object.assign({ kind: "image", exifOrientation: meta.orientation || 1 }, result);
}

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------
/**
 * pdfjs が使う、追加データの置き場所。どれも、指定しないと、該当するPDFが真っ白に描画される（実際に確認済み）。
 *   ・cMapUrl / standardFontDataUrl … 日本語フォントを埋め込んでいないPDFの、文字
 *   ・wasmUrl … JPEG2000（JPX）・JBIG2 形式の画像（スキャナが作るPDFで使われることがある）の復号と、色の変換
 * Vercelに含める設定は、vercel.json の includeFiles（node_modules/pdfjs-dist の cmaps・standard_fonts・wasm）。
 */
function getPdfjsAssetOptions_() {
  const root = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), path.sep);
  return {
    cMapUrl: path.join(root, "cmaps", path.sep),
    cMapPacked: true,
    standardFontDataUrl: path.join(root, "standard_fonts", path.sep),
    wasmUrl: path.join(root, "wasm", path.sep)
  };
}

/** PDFの先頭ページ群を画像（PNG）にする。戻り値：{ pageCount, pages: [{ png, width, height }] } */
async function renderPdfPages(bytes) {
  // pdfjs と canvas は、PDFのときだけ読み込む（画像だけの依頼では、読み込みの時間をかけないため）
  const { createCanvas } = require("@napi-rs/canvas");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); // ESMのため、dynamic import で読み込む
  const task = pdfjs.getDocument(Object.assign(
    { data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false, disableFontFace: true },
    getPdfjsAssetOptions_()
  ));
  try {
    const pdf = await task.promise;
    const pages = [];
    const count = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= count; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, MAX_SIDE_PX / Math.max(base.width, base.height)) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff"; // 背景が透明なPDFは、白で塗ってから描く
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      pages.push({ png: canvas.toBuffer("image/png"), width: canvas.width, height: canvas.height });
      page.cleanup();
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await task.destroy();
  }
}

async function detectPdf(bytes) {
  let rendered;
  try {
    rendered = await renderPdfPages(bytes);
  } catch (e) {
    const reason = /password|encrypt/i.test(e && e.message) ? "encrypted" : "unreadable-pdf";
    return { kind: "pdf", pageCount: 0, pages: [], pageRotations: [], skipped: reason, message: e && e.message ? e.message : String(e) };
  }
  // ページは1枚ずつ順番に判定する（Tesseractのワーカーは、同時に1件しか扱えないため）
  const pages = [];
  for (let i = 0; i < rendered.pages.length; i++) {
    const page = rendered.pages[i];
    const result = await detectFromPng(page.png);
    pages.push(Object.assign({ page: i + 1, width: page.width, height: page.height }, result));
  }
  return {
    kind: "pdf",
    pageCount: rendered.pageCount,
    checkedPages: pages.length, // pageCount より小さいときは、先頭だけを判定している
    pages: pages,
    pageRotations: pages.map(p => p.rotation) // 判定できなかったページは null
  };
}

/**
 * @param {Buffer} bytes ファイルの中身
 * @param {string} mimeType Drive が持つ、ファイルの種類
 * @return {Promise<Object>} 画像：{kind, rotation, confidence, script, ...}　PDF：{kind, pageCount, pages, pageRotations, ...}
 *   対象外の形式は { skipped: "unsupported-type" }
 */
async function detectOrientation(bytes, mimeType) {
  if (mimeType === "application/pdf") return detectPdf(bytes);
  if (IMAGE_TYPES.includes(mimeType)) return detectImage(bytes);
  return { skipped: "unsupported-type" };
}

module.exports = { detectOrientation, IMAGE_TYPES, MAX_PDF_PAGES };
