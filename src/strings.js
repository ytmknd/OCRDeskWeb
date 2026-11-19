// 画面に出す文言。ブラウザーの言語が日本語なら日本語、それ以外は英語。
// URL に ?lang=ja / ?lang=en を付けると、その言語に固定する（動作確認用）。
// 英語と日本語を必ず対で書くため、1 か所にまとめている。

function detectJapanese() {
  try {
    const forced = new URLSearchParams(globalThis.location?.search ?? '').get('lang');
    if (forced === 'ja' || forced === 'en') return forced === 'ja';
  } catch { /* ワーカーなど location がない環境 */ }
  const langs = globalThis.navigator?.languages?.length ? navigator.languages : [globalThis.navigator?.language ?? 'en'];
  return String(langs[0] ?? '').toLowerCase().startsWith('ja');
}

export const isJapanese = detectJapanese();
const T = (en, ja) => (isJapanese ? ja : en);

export const S = {
  lang: T('en', 'ja'),
  tagline: T('OCR for images and PDFs that runs entirely in your browser', '画像と PDF の文字をブラウザーの中だけで読み取ります'),
  privacy: T('Your files are never uploaded. Everything is processed on this device.', 'ファイルはどこにも送信されません。すべてこの端末の中で処理します。'),
  dropHere: T('Drop PNG, JPEG, or PDF files here', 'PNG・JPEG・PDF をここにドロップ'),
  orChoose: T('or', 'または'),
  chooseFiles: T('Choose files…', 'ファイルを選ぶ…'),
  run: T('Run OCR', 'OCR 実行'),
  rerun: T('Run again', '再実行'),
  cancel: T('Cancel', '中止'),
  remove: T('Remove', '削除'),
  clearAll: T('Clear all', 'すべてクリア'),
  copy: T('Copy', 'コピー'),
  save: T('Save .txt', '.txt で保存'),
  pdfResolution: T('PDF resolution', 'PDF 解像度'),
  engine: T('Engine', 'エンジン'),
  engineCpu: T('CPU (WebAssembly)', 'CPU（WebAssembly）'),
  engineGpu: T('GPU (WebGPU, experimental)', 'GPU（WebGPU・試験的）'),
  files: T('Files', 'ファイル'),
  preview: T('Preview', 'プレビュー'),
  result: T('OCR result (editable)', 'OCR 結果（編集できます）'),
  noFiles: T('No files yet.', 'ファイルはまだありません。'),
  pageOf: (page, pages) => T(`${page} / ${pages}`, `${page} / ${pages}`),
  prevPage: T('Previous page', '前のページ'),
  nextPage: T('Next page', '次のページ'),
  pagesSuffix: (n) => T(` (${n} pages)`, `（${n} ページ）`),

  statePending: T('Pending', '未処理'),
  stateProcessing: T('Processing', '処理中'),
  stateDone: T('Done', '完了'),
  statePartialError: T('Errors', '一部エラー'),
  stateNoText: T('No text', '文字なし'),
  stateCancelled: T('Cancelled', '中止'),

  statusReady: T('Add files to begin.', 'ファイルを追加してください。'),
  statusLoadingEngine: T('Preparing the OCR engine…', 'OCR エンジンを準備しています…'),
  statusLoadingModel: T('Loading the OCR model…', 'OCR モデルを読み込んでいます…'),
  statusDownloading: (mb, totalMb) => T(`Downloading the OCR model (first time only): ${mb} / ${totalMb} MB`, `OCR モデルをダウンロードしています（初回のみ）: ${mb} / ${totalMb} MB`),
  threads: (n) => T(`${n} thread${n === 1 ? '' : 's'}`, `${n} スレッド`),
  statusEngineReady: (backend) => T(`OCR engine ready (${backend}).`, `OCR エンジンの準備ができました（${backend}）。`),
  statusEngineFailed: (error) => T(`Could not start the OCR engine: ${error}`, `OCR エンジンを起動できませんでした: ${error}`),
  statusReading: (file, page, pages, part, parts) => T(
    `${file}: reading page ${page} of ${pages}${parts > 1 ? ` (part ${part} of ${parts})` : ''}…`,
    `${file}: ${page} / ${pages} ページを読み取り中${parts > 1 ? `（${part} / ${parts} 区画）` : ''}…`),
  statusCancelled: (done, total, elapsed) => T(`Cancelled (${done} of ${total} pages processed, ${elapsed}).`, `中止しました（${done} / ${total} ページ処理済み、${elapsed}）。`),
  statusDone: (total, elapsed) => T(`Done. Read ${total} page${total === 1 ? '' : 's'} (${elapsed}).`, `完了しました。${total} ページを読み取りました（${elapsed}）。`),
  statusDoneWithErrors: (total, failed, elapsed) => T(`Done. ${failed} of ${total} pages had errors (${elapsed}).`, `完了しました。${total} ページ中 ${failed} ページでエラーがありました（${elapsed}）。`),
  statusCopied: T('Copied to the clipboard.', 'クリップボードにコピーしました。'),
  statusCopyFailed: T('Could not copy. Select the text and copy it manually.', 'コピーできませんでした。文字を選択して手動でコピーしてください。'),
  seconds: (s) => T(`${s.toFixed(1)} s`, `${s.toFixed(1)} 秒`),

  unsupportedFormat: (name) => T(`${name}: unsupported format (PNG, JPEG, and PDF are supported)`, `${name}: 対応していない形式です（PNG・JPEG・PDF に対応）`),
  imageLoadFailed: T('Could not read the image (it is damaged or in an unsupported format).', '画像を読み込めませんでした（壊れているか未対応の形式です）。'),
  pdfPasswordProtected: T('Password-protected PDFs cannot be opened.', 'パスワードで保護された PDF は開けません。'),
  pdfLoadFailed: (error) => T(`Could not read the PDF: ${error}`, `PDF を読み込めませんでした: ${error}`),
  addFailedTitle: T('Some files could not be added:', '追加できなかったファイルがあります:'),
  discardEdits: T('Your edits to the OCR result will be lost. Continue?', 'OCR 結果に加えた編集は失われます。続けますか？'),

  pageHeader: (page, pages) => T(`----- Page ${page} of ${pages} -----`, `----- ${page} / ${pages} ページ -----`),
  errorPrefix: T('Error: ', 'エラー: '),
  noTextFound: T('No text found', '文字が見つかりませんでした'),

  engineNote: T(
    'Uses PP-OCRv6 Small (Japanese, Chinese, and English). The model (about 31 MB) is downloaded once and kept in the browser.',
    'PP-OCRv6 Small（日本語・中国語・英語）を使います。モデル（約 31 MB）は初回だけダウンロードし、ブラウザーに保存します。'),
  licenses: T('Licenses', 'ライセンス'),
  source: T('Source code', 'ソースコード'),
};
