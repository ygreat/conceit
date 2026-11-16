/** URL classification for paste / "add from link". */

export type Embed =
  | { kind: "youtube"; src: string; thumb: string }
  | { kind: "vimeo"; src: string }
  | { kind: "file"; src: string };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?.*)?$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)(\?.*)?$/i;

export function isUrl(text: string): boolean {
  try {
    const u = new URL(text.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function youtube(id: string): Embed {
  return {
    kind: "youtube",
    src: `https://www.youtube-nocookie.com/embed/${id}`,
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}

/**
 * Ask for the frame at 0.1 s so engines that only preload metadata (WebKit)
 * decode and show a real first frame instead of a black box.
 */
export function withFirstFrame(src: string): string {
  return src.includes("#") ? src : `${src}#t=0.1`;
}

export function videoEmbed(raw: string): Embed | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");

  if (host === "youtu.be") {
    const id = u.pathname.slice(1);
    if (id) return youtube(id);
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id =
      u.searchParams.get("v") ??
      u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1];
    if (id) return youtube(id);
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = u.pathname.match(/(\d{6,})/)?.[1];
    if (id) return { kind: "vimeo", src: `https://player.vimeo.com/video/${id}` };
  }
  if (VIDEO_EXT.test(u.pathname)) return { kind: "file", src: u.toString() };
  return null;
}

export type UrlKind = "image" | "video" | "link";

export function classifyUrl(raw: string): UrlKind {
  if (videoEmbed(raw)) return "video";
  try {
    if (IMAGE_EXT.test(new URL(raw.trim()).pathname)) return "image";
  } catch {
    /* not a URL */
  }
  return "link";
}

/** Codec support of the current OS webview (WebKit on macOS/Linux, WebView2 on Windows). */
export function codecReport(): { label: string; result: string }[] {
  const v = document.createElement("video");
  const probe = (label: string, type: string) => ({
    label,
    result: v.canPlayType(type) || "no",
  });
  return [
    probe("MP4 · H.264", 'video/mp4; codecs="avc1.42E01E"'),
    probe("MP4 · HEVC", 'video/mp4; codecs="hvc1.1.6.L93.B0"'),
    probe("MP4 · AV1", 'video/mp4; codecs="av01.0.05M.08"'),
    probe("WebM · VP9", 'video/webm; codecs="vp9"'),
    probe("WebM · VP8", 'video/webm; codecs="vp8"'),
    probe("QuickTime MOV", "video/quicktime"),
    probe("Ogg · Theora", 'video/ogg; codecs="theora"'),
  ];
}

/** Default on-canvas size for an image: natural size, scaled down to fit a 480×400 box. */
export function fitImage(iw: number, ih: number, maxW = 480, maxH = 400) {
  const s = Math.min(1, maxW / iw, maxH / ih);
  return { width: Math.max(80, Math.round(iw * s)), height: Math.max(40, Math.round(ih * s)) };
}
