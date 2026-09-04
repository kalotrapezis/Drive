import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, ArrowsOut, FolderOpen, MapPin, Pause, PencilSimple, Play, X } from "@phosphor-icons/react";

export type GalleryPhoto = { path: string; name: string; size: number; modified: string; captured: string; dateSource: string; type: "Photo" | "Video"; collection: string; demoCrop?: string; source?: "Photos" | "Screenshots" };
export const mediaKey = (item: GalleryPhoto) => `${item.source || "Photos"}/${item.path}`;
export const mediaUrl = (item: GalleryPhoto, preview = false) => `/api/v1/photo-thumbnail?root=${item.source || "Photos"}&path=${encodeURIComponent(item.path)}${preview ? "&preview=1" : ""}`;

export function PhotoViewer({ items, selected, onSelect, onClose, fixture, imageStyle }: { items: GalleryPhoto[]; selected: GalleryPhoto; onSelect: (item: GalleryPhoto) => void; onClose: () => void; fixture: boolean; imageStyle: (item: GalleryPhoto) => CSSProperties | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mapRequest = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false), [status, setStatus] = useState(""), [mapStatus, setMapStatus] = useState("");
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const move = (offset: number) => { const index = items.findIndex((item) => mediaKey(item) === mediaKey(selected)); onSelect(items[(index + offset + items.length) % items.length]); };
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => { setStatus(""); setLocation(null); setMapLoaded(false); void showMap(); return () => mapRequest.current?.abort(); }, [selected]);
  useEffect(() => { if (!playing || items.length < 2) return; const timer = window.setTimeout(() => move(1), 4000); return () => window.clearTimeout(timer); }, [playing, selected, items]);
  const showMap = async () => {
    mapRequest.current?.abort(); const request = new AbortController(); mapRequest.current = request;
    setMapLoaded(false); setMapStatus("Reading location…");
    if (fixture) { setMapStatus("This demo image has no location metadata."); return; }
    try {
      const response = await fetch(`/api/v1/photo-info?root=${selected.source || "Photos"}&path=${encodeURIComponent(selected.path)}`, { signal: request.signal });
      const result = await response.json() as { latitude?: number; longitude?: number; error?: string };
      if (!response.ok || result.error) throw new Error(result.error || "Location unavailable");
      if (typeof result.latitude !== "number" || typeof result.longitude !== "number") { setLocation(null); setMapStatus("No GPS location recorded in this image."); return; }
      setLocation({ latitude: result.latitude, longitude: result.longitude }); setMapStatus("");
    } catch (error) { if (!request.signal.aborted) setMapStatus(error instanceof Error ? error.message : "Location unavailable"); }
  };
  const desktopAction = async (action: "reveal-photo" | "edit-photo") => {
    setPlaying(false);
    if (fixture) { setStatus("Demo image — no file is opened or edited."); return; }
    try {
      const session = await fetch("/api/v1/session"); if (!session.ok) throw new Error("Local service unavailable");
      const { token } = await session.json() as { token: string };
      const response = await fetch("/api/v1/file-action", { method: "POST", headers: {"Content-Type":"application/json", "X-Local-Drive-Token":token}, body:JSON.stringify({action,root:selected.source || "Photos",path:selected.path}) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "Could not open desktop application");
      setStatus(action === "edit-photo" ? "Opened in the image editor. Use Save As to keep the original, then refresh Photos." : "Opened the containing folder.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Desktop action unavailable"); }
  };
  const fullScreen = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await dialog.current?.requestFullscreen(); } catch { setStatus("Fullscreen is unavailable in this window. The large viewer is still available."); } };
  return <dialog ref={dialog} className="media-viewer" aria-label="Photo viewer" onClose={onClose} onCancel={() => setPlaying(false)} onKeyDown={(event) => { if ((event.target as HTMLElement).tagName === "INPUT") return; if (event.key === "ArrowRight") { event.preventDefault(); move(1); } if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); } }}>
    <header><strong>{selected.name}</strong><button title="Close" aria-label="Close viewer" onClick={() => dialog.current?.close()}><X /></button></header>
    <div className="media-focus-layout"><div className="media-focus-main"><div className="media-viewer-body">
      {selected.type === "Video" ? <div className="viewer-message"><Play size={48} /><p>Video playback uses your desktop player.</p><button onClick={async () => { if (fixture) { setStatus("Demo video — no local file to open."); return; } try { const session = await fetch("/api/v1/session"); const { token } = await session.json(); const response = await fetch("/api/v1/open-file", {method:"POST",headers:{"Content-Type":"application/json","X-Local-Drive-Token":token},body:JSON.stringify({root:selected.source || "Photos",path:selected.path})}); if (!response.ok) throw new Error("Could not open video"); } catch (error) { setStatus(error instanceof Error ? error.message : "Could not open video"); } }}>Open video</button></div> : fixture ? <div role="img" aria-label={selected.name} className="viewer-demo" style={imageStyle(selected)} /> : <img src={mediaUrl(selected, true)} alt={selected.name} onError={() => { setPlaying(false); setStatus("Image unavailable or unsupported. Refresh the library."); }} />}
    </div><div className="focus-controls" role="toolbar" aria-label="Image viewing options">
      <button onClick={() => dialog.current?.close()} title="Back to gallery" aria-label="Back to gallery"><ArrowLeft /><span>Back</span></button>
      <button onClick={() => void fullScreen()} title="Fullscreen" aria-label="Fullscreen"><ArrowsOut /><span>Fullscreen</span></button>
      <button disabled={items.length < 2} aria-label="Previous image" title="Previous image" onClick={() => { setPlaying(false); move(-1); }}><ArrowLeft /></button>
      <button disabled={items.length < 2} onClick={() => setPlaying(!playing)} title={playing ? "Pause slideshow" : "Slideshow"} aria-label={playing ? "Pause slideshow" : "Start slideshow"}>{playing ? <Pause /> : <Play />}<span>{playing ? "Pause" : "Slideshow"}</span></button>
      <button disabled={items.length < 2} aria-label="Next image" title="Next image" onClick={() => { setPlaying(false); move(1); }}><ArrowRight /></button>
      <button disabled={selected.type === "Video"} onClick={() => void desktopAction("reveal-photo")} title="Open containing folder"><FolderOpen /><span>Open in folder</span></button>
      <button disabled={selected.type === "Video"} onClick={() => void desktopAction("edit-photo")} title="Edit in desktop image editor"><PencilSimple /><span>Edit</span></button>
    </div></div><aside className="viewer-info" aria-label="Image information"><section className="focus-map"><h2><MapPin />Map</h2>{location ? <><p>{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</p>{mapLoaded ? <iframe title="Photo location on OpenStreetMap" referrerPolicy="no-referrer" src={`https://www.openstreetmap.org/export/embed.html?bbox=${location.longitude-.01}%2C${location.latitude-.01}%2C${location.longitude+.01}%2C${location.latitude+.01}&layer=mapnik&marker=${location.latitude}%2C${location.longitude}`} /> : <><p>Loading the map shares these coordinates with OpenStreetMap.</p><button onClick={() => setMapLoaded(true)}>Load map</button></>}</> : <p role="status">{mapStatus}</p>}</section>
      <section><h2>Information</h2><dl><dt>Date</dt><dd>{new Date(selected.captured).toLocaleDateString()}</dd><dt>Time</dt><dd>{new Date(selected.captured).toLocaleTimeString()}</dd><dt>Date source</dt><dd>{selected.dateSource}</dd><dt>Location</dt><dd>{location ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}` : "Not recorded"}</dd><dt>Size</dt><dd>{new Intl.NumberFormat().format(selected.size)} bytes</dd><dt>Source</dt><dd>{selected.source === "Screenshots" ? "System Screenshots · shown in place" : "Photos library"}</dd><dt>Path</dt><dd>{selected.path}</dd></dl></section>
    </aside></div><footer><span>{items.findIndex((item) => mediaKey(item) === mediaKey(selected)) + 1} / {items.length}</span>{playing && <span>Slideshow · 4 seconds</span>}{status && <span role="status">{status}</span>}</footer>
  </dialog>;
}
