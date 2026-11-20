/**
 * =====================================================================
 * lib/rotateCore.js
 * =====================================================================
 * 画像・PDFの回転（ファイルの中身だけを扱う。通信は行わない）
 * =====================================================================
 * 【角度の意味】OCRが返した「画像を時計回りに何度回すと、文字が正しい向きになるか」（90 / 180 / 270）。
 *
 * 【扱う形式】
 *   ・画像：JPEG / PNG / WebP … 画素を回転して、同じ形式で書き出す（JPEG・WebPは、高い画質で再圧縮する）
 *   ・PDF　：ページごとの回転（/Rotate）を加える。ページの中身（画像・文字）は変えない
 *
 * 【回転しない（skipped として理由を返す）場合】誤った向きに直してしまう・壊してしまうことを避けるため
 *   ・unsupported-type　… 上の形式以外
 *   ・exif-orientation　… 画像に EXIF の向き情報がある（見た目の向きと画素の向きがずれており、OCRが見た向きが分からない）
 *   ・animated-image　　… 複数フレームの画像
 *   ・encrypted / unreadable-pdf … 暗号化されている・読み込めないPDF
 *   ・page-count-mismatch … PDFのページ数と、OCRが返したページ別の角度の数が違う
 *   ・no-rotation　　　… 回転が必要なページが無い
 *
 * 【メタデータ】画像は、EXIF（撮影日時・位置情報など）を引き継がない。PDFは、文書情報（作成者・日付など）を変えない。
 */
const sharp = require("sharp");
const { PDFDocument, degrees } = require("pdf-lib");

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VALID_ANGLES = [0, 90, 180, 270];

/**
 * @param {Buffer} bytes ファイルの中身
 * @param {string} mimeType Drive が持つ、ファイルの種類
 * @param {{rotation?: number, pageRotations?: number[]}} request 画像は rotation、PDFは pageRotations（ページ順）
 * @return {Promise<{bytes: Buffer}|{skipped: string}>}
 */
async function rotateFileBytes(bytes, mimeType, request) {
  if (mimeType === "application/pdf") return rotatePdf(bytes, request.pageRotations);
  if (IMAGE_TYPES.includes(mimeType)) return rotateImage(bytes, mimeType, request.rotation);
  return { skipped: "unsupported-type" };
}

async function rotateImage(bytes, mimeType, angle) {
  if (![90, 180, 270].includes(angle)) return { skipped: "no-rotation" };

  const meta = await sharp(bytes).metadata();
  if (meta.orientation && meta.orientation !== 1) return { skipped: "exif-orientation" };
  if (meta.pages && meta.pages > 1) return { skipped: "animated-image" };

  // sharp の rotate(角度) は、時計回り
  let pipeline = sharp(bytes).rotate(angle);
  if (mimeType === "image/jpeg") pipeline = pipeline.jpeg({ quality: 92, chromaSubsampling: "4:4:4" }); // 文字がにじまないよう、色の間引きをしない
  else if (mimeType === "image/png") pipeline = pipeline.png();
  else pipeline = pipeline.webp({ quality: 92 });

  return { bytes: await pipeline.toBuffer() };
}

async function rotatePdf(bytes, pageRotations) {
  if (!Array.isArray(pageRotations) || pageRotations.length === 0 || pageRotations.every(a => a === 0)) {
    return { skipped: "no-rotation" };
  }
  if (!pageRotations.every(a => VALID_ANGLES.includes(a))) return { skipped: "no-rotation" };

  let pdf;
  try {
    // updateMetadata: false … 作成者・更新日などの文書情報を、書き換えない
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (e) {
    return { skipped: /encrypt/i.test(e.message) ? "encrypted" : "unreadable-pdf" };
  }

  const pages = pdf.getPages();
  if (pages.length !== pageRotations.length) return { skipped: "page-count-mismatch" };

  pages.forEach((page, i) => {
    if (pageRotations[i] === 0) return;
    // すでにページに回転が設定されている場合は、その上に加える
    const next = (((page.getRotation().angle + pageRotations[i]) % 360) + 360) % 360;
    page.setRotation(degrees(next));
  });
  return { bytes: Buffer.from(await pdf.save()) };
}

module.exports = { rotateFileBytes, IMAGE_TYPES };
