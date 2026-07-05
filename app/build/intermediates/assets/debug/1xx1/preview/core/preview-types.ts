/**
 * 1XX1 Web Önizleme Motoru — Tipler
 * Aşama 17 — Web Preview Engine
 *
 * Preview Engine salt okunurdur — hiçbir zaman veri yazmaz.
 * Her önizleme türü kendi extractor'ına sahiptir.
 * Cache: CID → PreviewResult (immutable, TTL tabanlı)
 *
 * Desteklenen önizleme türleri:
 *   OpenGraph    — metadata, OG tags
 *   Markdown     — README.md render
 *   Syntax       — kod dosyaları (highlight)
 *   STL/3D       — 3D model thumbnail (Three.js)
 *   Image        — PNG, JPEG, WebP, SVG
 *   PDF          — ilk sayfa thumbnail
 *   Audio        — dalga formu görselleştirme
 *   Binary       — hex dump + metadata
 */

import type { AssetType } from "../../asset/entities/asset.entity.ts";

// ─── Önizleme Türü ────────────────────────────────────────────────────────────

export type PreviewType =
  | "opengraph"   // metadata + OG tags
  | "markdown"    // README render
  | "syntax"      // kaynak kodu highlight
  | "model_3d"    // STL/OBJ/GLB thumbnail
  | "image"       // PNG/JPEG/SVG/WebP
  | "pdf"         // PDF ilk sayfa
  | "audio"       // waveform görselleştirme
  | "binary"      // hex dump
  | "font"        // font preview
  | "video"       // video thumbnail (ilk kare)
  | "fallback";   // desteklenmiyor — sadece metadata

// ─── Preview Durumu ──────────────────────────────────────────────────────────

export type PreviewStatus =
  | "pending"     // önizleme henüz işlenmedi
  | "processing"  // hesaplanıyor
  | "ready"       // hazır
  | "error"       // hata
  | "unsupported"; // bu format için önizleme yok

// ─── OpenGraph Metadata ───────────────────────────────────────────────────────

export interface OpenGraphMeta {
  title?:       string;
  description?: string;
  image?:       string;       // URL veya data URI
  siteName?:    string;
  type?:        "website" | "article" | "profile" | "product";
  url?:         string;
  /** Platform'a özgü ek metadata */
  custom:       Record<string, string>;
}

// ─── Sözdizimi Vurgulama ──────────────────────────────────────────────────────

export interface SyntaxHighlightResult {
  html:         string;     // highlight edilmiş HTML
  language:     string;     // tespit edilen dil
  lineCount:    number;
  /** İlk N satır (preview için) */
  previewLines: number;
}

// ─── 3D Model Thumbnail ───────────────────────────────────────────────────────

export interface Model3DPreview {
  /** base64 PNG thumbnail (256×256) */
  thumbnail:     string;
  /** Dosya formatı */
  format:        string;
  /** Üçgen sayısı (STL) */
  triangleCount?: number;
  /** Bounding box */
  bounds?: {
    x: [number, number]; y: [number, number]; z: [number, number];
  };
}

// ─── Markdown Render ──────────────────────────────────────────────────────────

export interface MarkdownPreview {
  /** Render edilmiş HTML */
  html:           string;
  /** Açıklama metni (ilk paragraf, düz metin) */
  excerpt:        string;
  /** Başlıklar (TOC için) */
  headings:       Array<{ level: number; text: string; id: string }>;
  wordCount:      number;
  hasCodeBlocks:  boolean;
  hasTables:      boolean;
}

// ─── Preview Sonucu ──────────────────────────────────────────────────────────

export interface PreviewResult {
  /** Asset veya proje CID'si */
  cid:          string;
  /** Önizleme türü */
  type:         PreviewType;
  /** Durum */
  status:       PreviewStatus;
  /** Dosya boyutu (byte) */
  fileSize:     number;
  /** MIME tipi */
  mimeType:     string;
  /** Dosya adı */
  fileName:     string;
  /** OpenGraph metadata — her önizlemede */
  og:           OpenGraphMeta;
  /** Tür'e özgü detay */
  detail?:
    | SyntaxHighlightResult
    | Model3DPreview
    | MarkdownPreview
    | { thumbnailDataUri: string }  // image/pdf/audio/video
    | { hexDump: string; encoding: string };  // binary
  /** Hesaplama süresi (ms) */
  durationMs:   number;
  /** Oluşturulma zamanı */
  generatedAt:  Date;
  /** Hata mesajı (status=error ise) */
  error?:       string;
}

// ─── Extractor Arayüzü ───────────────────────────────────────────────────────

export interface IPreviewExtractor {
  readonly name:     string;
  /** Bu extractor bu MIME/uzantı için uygun mu? */
  canExtract(mimeType: string, ext: string): boolean;
  /** Önizleme üret */
  extract(params: ExtractParams): Promise<PreviewResult>;
}

export interface ExtractParams {
  cid:      string;
  data:     Uint8Array;
  fileName: string;
  mimeType: string;
  format:   string;    // uzantı
}

// ─── Preview Cache Girdisi ───────────────────────────────────────────────────

export interface PreviewCacheEntry {
  result:     PreviewResult;
  cachedAt:   number;
  expiresAt:  number;
  hitCount:   number;
}

// ─── Dosya Uzantısından Önizleme Türü ────────────────────────────────────────

export function inferPreviewType(mimeType: string, ext: string): PreviewType {
  const mime = mimeType.toLowerCase();
  const e    = ext.toLowerCase();

  if (e === "md" || e === "mdx" || e === "rst")              return "markdown";
  if (["png","jpg","jpeg","gif","webp","svg","avif"].includes(e)) return "image";
  if (["stl","obj","gltf","glb","fbx","ply"].includes(e))    return "model_3d";
  if (e === "pdf")                                            return "pdf";
  if (["wav","mp3","ogg","flac","aac"].includes(e))           return "audio";
  if (["mp4","webm","mkv","mov"].includes(e))                 return "video";
  if (["ttf","otf","woff","woff2"].includes(e))               return "font";
  if (mime.startsWith("text/") || [
    "js","ts","jsx","tsx","py","rs","go","c","cpp","java",
    "json","yaml","toml","sh","bash","css","html","xml","sql",
    "glsl","wgsl","lua","rb","php","kt","swift","dart"
  ].includes(e))                                              return "syntax";
  if (mime.includes("octet-stream") || mime.includes("wasm")) return "binary";

  return "fallback";
}
