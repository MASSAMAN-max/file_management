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
 *   4方向とも正解した（信頼度1.9〜6.0）。ただし、試した書類は1種類だけ。そのため、次の3通りで判定して、結果をすべて返す（attempts）。
 *     raw       … そのまま
 *     sharpen   … コントラストを広げて、輪郭を強める
 *     binarize  … コントラストを広げて、白黒にする
 *   代表の角度は、信頼度が一番高いものにする（暫定。どの前処理が当たるか、実際のデータで見てから決める）。
 *
 * 【この関数は「判定するだけ」】角度の採用・不採用（信頼度の基準など）は決めない。
 *   信頼度（confidence）・文字種（script）・Tesseractの生の出力を、そのまま返す。基準は、実際のデータを見てから決める。
 *   判定できなかったページは、rotation を null にして、reason に理由を入れる。
 *
 * 【速度】Tesseractのワーカーは、関数が温まっている間は使い回す（起動に約0.3秒かかるため）。
 *   学習データ（tessdata/osd.traineddata）は、デプロイに含める（vercel.json の includeFiles）。
 */
const path = require("path");
const sharp = require("sharp");
const { createWorker, OEM, PSM } = require("tesseract.js");
const { PDFDocument, PDFName, PDFDict } = require("pdf-lib");

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
async function detectImage(bytes, options) {
  const meta = await sharp(bytes).metadata();
  const png = await sharp(bytes)
    .rotate() // EXIFの向きを反映する（見た目の向きで判定するため）
    .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: "inside" }) // 小さい画像は拡大する（拡大しないと、文字が少ないと判定されることがあった）
    .flatten({ background: "#ffffff" }) // 透過PNGの背景は白にする
    .grayscale()
    .png()
    .toBuffer();
  const result = await detectFromPng(png);
  const entry = Object.assign({ kind: "image", exifOrientation: meta.orientation || 1, diagnostics: await measureRender_(png) }, result);
  if (options.includeImage) entry.previewJpegBase64 = await toPreviewJpegBase64_(png);
  return entry;
}

// ---------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------
/** 文字の向きの角度を、0/90/180/270 にまるめる（pdfjs の文字の変換行列 [a, b, ...] から求める） */
function textAngleOf_(transform) {
  const degrees = Math.round((Math.atan2(transform[1], transform[0]) * 180) / Math.PI / 90) * 90;
  return ((degrees % 360) + 360) % 360;
}

/**
 * ページの作りを調べる（判定できない原因を探すための診断。判定そのものには使わない）。
 *   ・pageRotate … ページ自体の回転の指定（/Rotate）
 *   ・textChars / textAngles … ページに文字データがあるか。ある場合、角度ごとの文字数（0＝横書きで正しい向き。90などは、回転している）
 *   ・imageCount … ページに貼られている画像の数（スキャンしたPDFは、画像が1つ以上ある）
 */
async function inspectPdfPage_(pdfjs, page) {
  const text = await page.getTextContent();
  const textAngles = {};
  let textChars = 0;
  text.items.forEach(item => {
    const length = String(item.str || "").replace(/\s/g, "").length;
    if (length === 0) return;
    textChars += length;
    const angle = textAngleOf_(item.transform);
    textAngles[angle] = (textAngles[angle] || 0) + length;
  });

  const imageOps = [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat];
  const operatorList = await page.getOperatorList();
  const imageCount = operatorList.fnArray.filter(op => imageOps.indexOf(op) !== -1).length;
  return { pageRotate: page.rotate, viewBox: page.view, textChars: textChars, textAngles: textAngles, imageCount: imageCount };
}

/**
 * PDFの指定ページに貼られている画像の、圧縮形式・大きさ・色空間を読む（判定できない原因を探すための診断）。
 * 例）filter="/JPXDecode"（JPEG2000）、"/JBIG2Decode"、"/DCTDecode"（JPEG）、"/CCITTFaxDecode"（FAX形式）、"/FlateDecode"
 * フォームの中に入れ子になった画像は読まない。読めなければ空配列（診断だけのため、失敗しても判定は続ける）。
 */
async function describePdfImages_(bytes, pageIndex) {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const resources = doc.getPages()[pageIndex].node.Resources();
    const xobjects = resources && resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xobjects) return [];

    const images = [];
    for (const [, ref] of xobjects.entries()) {
      const dict = (doc.context.lookup(ref) || {}).dict;
      if (!dict || String(dict.get(PDFName.of("Subtype"))) !== "/Image") continue;
      const read = (key) => { const v = dict.get(PDFName.of(key)); return v === undefined ? null : String(v); };
      images.push({ filter: read("Filter"), width: read("Width"), height: read("Height"), bitsPerComponent: read("BitsPerComponent"), colorSpace: read("ColorSpace"), hasMask: read("SMask") !== null || read("Mask") !== null });
      if (images.length >= 5) break;
    }
    return images;
  } catch (e) {
    return [];
  }
}

/** 描画した画像の明るさ（真っ白・真っ黒・文字がほぼ無い、などを見分けるため）。darkRatio＝黒っぽい画素の割合 */
async function measureRender_(png) {
  const stats = await sharp(png).grayscale().threshold(128).stats();
  return { darkRatio: Math.round((1 - stats.channels[0].mean / 255) * 10000) / 10000 };
}

/** 確認用に、描画した画像を縮小したJPEG（base64）にする（includeImage のときだけ返す） */
async function toPreviewJpegBase64_(png) {
  return (await sharp(png).resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()).toString("base64");
}

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

/** PDFの先頭ページ群を画像（PNG）にする。戻り値：{ pageCount, pages: [{ png, width, height, diagnostics }] } */
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
      const diagnostics = await inspectPdfPage_(pdfjs, page);
      diagnostics.images = await describePdfImages_(bytes, i - 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, MAX_SIDE_PX / Math.max(base.width, base.height)) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff"; // 背景が透明なPDFは、白で塗ってから描く
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvas }).promise;
      const png = canvas.toBuffer("image/png");
      Object.assign(diagnostics, await measureRender_(png));
      pages.push({ png: png, width: canvas.width, height: canvas.height, diagnostics: diagnostics });
      page.cleanup();
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await task.destroy();
  }
}

async function detectPdf(bytes, options) {
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
    const entry = Object.assign({ page: i + 1, width: page.width, height: page.height, diagnostics: page.diagnostics }, result);
    if (options.includeImage && i === 0) entry.previewJpegBase64 = await toPreviewJpegBase64_(page.png); // 先頭ページだけ
    pages.push(entry);
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
 * @param {{includeImage?: boolean}} [options] includeImage：判定に使った画像（縮小したJPEG・先頭ページだけ）も返す（調査用）
 * @return {Promise<Object>} 画像：{kind, rotation, confidence, script, ...}　PDF：{kind, pageCount, pages, pageRotations, ...}
 *   対象外の形式は { skipped: "unsupported-type" }
 */
async function detectOrientation(bytes, mimeType, options) {
  const opts = options || {};
  if (mimeType === "application/pdf") return detectPdf(bytes, opts);
  if (IMAGE_TYPES.includes(mimeType)) return detectImage(bytes, opts);
  return { skipped: "unsupported-type" };
}

module.exports = { detectOrientation, IMAGE_TYPES, MAX_PDF_PAGES };
