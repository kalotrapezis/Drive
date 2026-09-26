import { useEffect, useRef, useState } from "react";
import { QrCode } from "@phosphor-icons/react";
import jsQR from "jsqr";

export function QrScanner() {
  const dialog = useRef<HTMLDialogElement>(null), video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null), timer = useRef<number | undefined>(undefined), generation = useRef(0);
  const [result, setResult] = useState(""), [status, setStatus] = useState(""), [running, setRunning] = useState(false);
  const stop = () => { generation.current++; window.clearTimeout(timer.current); stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; if (video.current) video.current.srcObject = null; setRunning(false); };
  useEffect(() => () => { generation.current++; window.clearTimeout(timer.current); stream.current?.getTracks().forEach((track) => track.stop()); }, []);
  const decode = (source: CanvasImageSource, width: number, height: number) => {
    const scale = Math.min(1, 1200 / Math.max(width, height));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("Image processing unavailable");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(pixels.data, pixels.width, pixels.height)?.data;
  };
  const start = async () => {
    stop(); const run = generation.current; setResult(""); setStatus("Waiting for camera permission…");
    try {
      const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      if (generation.current !== run || !dialog.current?.open) { camera.getTracks().forEach((track) => track.stop()); return; }
      stream.current = camera; video.current!.srcObject = camera; await video.current!.play();
      if (generation.current !== run || !dialog.current?.open) { camera.getTracks().forEach((track) => track.stop()); return; }
      setRunning(true); setStatus("Point the camera at a QR code.");
      const scan = () => {
        if (generation.current !== run || !video.current) return;
        try {
          if (video.current.videoWidth) { const text = decode(video.current, video.current.videoWidth, video.current.videoHeight); if (text !== undefined) { setResult(text); setStatus("QR decoded locally. Nothing was opened or executed."); stop(); return; } }
          timer.current = window.setTimeout(scan, 250);
        } catch (error) { stop(); setStatus(error instanceof Error ? error.message : "Scan failed"); }
      };
      scan();
    } catch (error) { if (generation.current === run) { stop(); setStatus(error instanceof Error ? error.message : "Camera unavailable; choose an image instead"); } }
  };
  const image = async (file?: File) => {
    stop(); setResult(""); if (!file) return;
    if (file.size > 20 * 1024 * 1024) { setStatus("Choose an image smaller than 20 MB."); return; }
    let bitmap: ImageBitmap | undefined;
    try { bitmap = await createImageBitmap(file); const text = decode(bitmap, bitmap.width, bitmap.height); setResult(text || ""); setStatus(text === undefined ? "No QR code found. Try a sharper image." : "QR decoded locally. Nothing was opened or executed."); }
    catch { setStatus("Could not read this image."); } finally { bitmap?.close(); }
  };
  return <><button onClick={() => { setStatus(""); setResult(""); dialog.current?.showModal(); }}><QrCode />Scan QR code</button><dialog ref={dialog} className="item-action-dialog" aria-label="QR scanner" onClose={stop} onCancel={stop}><h2>Scan QR code</h2><p>Camera and images are processed on this laptop. QR content never opens automatically.</p><video ref={video} muted playsInline style={{ width: "100%", display: running ? "block" : "none" }} /><button onClick={() => void start()} disabled={running}>Start camera</button>{running && <button onClick={stop}>Stop camera</button>}<label>Or choose an image<input type="file" accept="image/*" onChange={(event) => { void image(event.target.files?.[0]); event.target.value = ""; }} /></label>{result && <label>Decoded text<textarea readOnly value={result} rows={5} style={{ width: "100%" }} /></label>}{status && <p role="status">{status}</p>}<button onClick={() => { stop(); dialog.current?.close(); }}>Close</button></dialog></>;
}
