// 瀏覽器版本的整頁截圖（ARCHITECTURE §13）：父頁面無法讀取跨 origin 的 iframe 內容，所以用
// `getDisplayMedia` 擷取目前的分頁（使用者每次都要允許），再裁成 Preview 的範圍。
// 不支援或使用者拒絕時，改成貼上或上傳圖片。

/** 裁切範圍（影像的像素）。 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把元素在 viewport 中的位置（CSS 像素）換算成擷取影像中的範圍。擷取的影像大小不一定等於
 * viewport × devicePixelRatio（瀏覽器可能縮放），所以依兩者的比例換算，並限制在影像之內。
 */
export function cropToElement(
  element: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
  frame: { width: number; height: number },
): CropRect | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const sx = frame.width / viewport.width;
  const sy = frame.height / viewport.height;
  const x = Math.max(0, Math.round(element.left * sx));
  const y = Math.max(0, Math.round(element.top * sy));
  const right = Math.min(frame.width, Math.round((element.left + element.width) * sx));
  const bottom = Math.min(frame.height, Math.round((element.top + element.height) * sy));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function canCaptureTab(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

/** 擷取目前分頁中 `element` 的範圍，回傳 PNG。使用者拒絕或不支援時丟出錯誤。 */
export async function captureElement(element: Element): Promise<Blob> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    // Chromium：預設選目前的分頁，而且不讓使用者改選其他視窗
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // 等一個畫格，避免截到選擇視窗關閉前的畫面
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    const crop = cropToElement(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: video.videoWidth, height: video.videoHeight },
    );
    if (!crop) throw new Error("Preview 不在畫面中");
    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    canvas
      .getContext("2d")
      ?.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("無法產生截圖"))),
        "image/png",
      ),
    );
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

/** 從貼上的資料中取出第一張圖片。 */
export function imageFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
}
