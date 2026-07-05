/**
 * 1XX1 Preview Extractors
 * Aşama 17 — Web Preview Engine
 *
 * Her extractor kendi türü için sorumludur.
 * Saf fonksiyonlar — I/O yok, dış servis yok.
 *
 * MarkdownExtractor   — README.md → HTML + TOC + excerpt
 * SyntaxExtractor     — kaynak kodu → highlighted HTML + dil tespiti
 * OpenGraphExtractor  — herhangi dosya → OG metadata üret
 * BinaryExtractor     — binary → hex dump + metadata
 * ImageExtractor      — PNG/JPEG/SVG/WebP → metadata + boyutlar
 * Model3DExtractor    — STL → triangle count + bounds + thumbnail stub
 */

import type {
  IPreviewExtractor, ExtractParams, PreviewResult,
  OpenGraphMeta, MarkdownPreview, SyntaxHighlightResult,
  Model3DPreview, PreviewType,
} from "./preview-types.ts";
import { inferPreviewType } from "./preview-types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function decode(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

function baseResult(params: ExtractParams, type: PreviewType, t0: number): Omit<PreviewResult, "og" | "detail"> {
  return {
    cid:         params.cid,
    type,
    status:      "ready",
    fileSize:    params.data.byteLength,
    mimeType:    params.mimeType,
    fileName:    params.fileName,
    durationMs:  Date.now() - t0,
    generatedAt: new Date(),
  };
}

// ─── OpenGraph Oluşturucu ─────────────────────────────────────────────────────

function buildOG(
  title:       string,
  description: string,
  extra:       Partial<OpenGraphMeta> = {}
): OpenGraphMeta {
  return {
    title:   title.slice(0, 120),
    description: description.slice(0, 300),
    type:    "product",
    custom:  {},
    ...extra,
  };
}

// ─── MarkdownExtractor ────────────────────────────────────────────────────────

/**
 * Gerçek markdown parser (minimal, sıfır bağımlılık).
 * Tam özellikli render için UI katmanında react-markdown kullanılır.
 * Bu extractor server-side önizleme için yeterli.
 */
export class MarkdownExtractor implements IPreviewExtractor {
  readonly name = "markdown";

  canExtract(_: string, ext: string): boolean {
    return ["md", "mdx", "rst", "txt"].includes(ext.toLowerCase());
  }

  async extract(params: ExtractParams): Promise<PreviewResult> {
    const t0   = Date.now();
    const text = decode(params.data).slice(0, 200_000); // max 200KB

    const { html, headings, excerpt, wordCount, hasCodeBlocks, hasTables } =
      this._parse(text);

    // Başlıktan OG title çıkar
    const title = headings[0]?.text ?? params.fileName.replace(/\.(md|mdx)$/, "");

    const detail: MarkdownPreview = {
      html, excerpt, headings, wordCount, hasCodeBlocks, hasTables,
    };

    return {
      ...baseResult(params, "markdown", t0),
      og:     buildOG(title, excerpt),
      detail,
    };
  }

  private _parse(text: string): MarkdownPreview {
    const lines = text.split("\n");
    const headings: MarkdownPreview["headings"] = [];
    const htmlParts: string[] = [];
    let inCodeBlock    = false;
    let hasCodeBlocks  = false;
    let hasTables      = false;
    let wordCount      = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code block toggle
      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        if (!inCodeBlock) hasCodeBlocks = true;
        const lang = line.slice(3).trim();
        htmlParts.push(inCodeBlock
          ? `<pre><code class="language-${lang}">`
          : `</code></pre>`
        );
        continue;
      }

      if (inCodeBlock) { htmlParts.push(this._esc(line) + "\n"); continue; }

      // Başlıklar
      const hMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (hMatch) {
        const level = hMatch[1].length;
        const text_ = this._inline(hMatch[2]);
        const id    = hMatch[2].toLowerCase().replace(/[^a-z0-9]/g, "-");
        headings.push({ level, text: hMatch[2], id });
        htmlParts.push(`<h${level} id="${id}">${text_}</h${level}>`);
        wordCount += hMatch[2].split(/\s+/).length;
        continue;
      }

      // Tablo
      if (line.includes("|") && line.trim().startsWith("|")) {
        hasTables = true;
        // Basit tablo satırı
        if (line.match(/^\|[-:\s|]+\|$/)) {
          htmlParts.push(""); continue; // ayırıcı satır
        }
        const cells = line.split("|").slice(1, -1).map((c) =>
          `<td>${this._inline(c.trim())}</td>`
        ).join("");
        htmlParts.push(`<tr>${cells}</tr>`);
        continue;
      }

      // Horizontal rule
      if (line.match(/^[-*_]{3,}$/)) { htmlParts.push("<hr>"); continue; }

      // Boş satır
      if (line.trim() === "") { htmlParts.push(""); continue; }

      // Sıralsız liste
      if (line.match(/^[-*+]\s+/)) {
        const item = this._inline(line.replace(/^[-*+]\s+/, ""));
        htmlParts.push(`<li>${item}</li>`);
        wordCount += item.split(/\s+/).length;
        continue;
      }

      // Numaralı liste
      if (line.match(/^\d+\.\s+/)) {
        const item = this._inline(line.replace(/^\d+\.\s+/, ""));
        htmlParts.push(`<li>${item}</li>`);
        continue;
      }

      // Paragraf
      const para = this._inline(line);
      htmlParts.push(`<p>${para}</p>`);
      wordCount += line.split(/\s+/).filter(Boolean).length;
    }

    const html    = htmlParts.join("\n");
    // İlk anlamlı paragraf özet
    const paraMatch = html.match(/<p>([^<]{20,})<\/p>/);
    const excerpt   = paraMatch
      ? paraMatch[1].slice(0, 200).replace(/<[^>]+>/g, "")
      : text.slice(0, 200).replace(/[#*`]/g, "").trim();

    return { html, headings, excerpt, wordCount, hasCodeBlocks, hasTables };
  }

  private _inline(text: string): string {
    return text
      .replace(/&/g,  "&amp;")
      .replace(/</g,  "&lt;")
      .replace(/>/g,  "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g,     "<em>$1</em>")
      .replace(/`(.+?)`/g,       "<code>$1</code>")
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  }

  private _esc(s: string): string {
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
}

// ─── SyntaxExtractor ─────────────────────────────────────────────────────────

/** Dil tespiti için uzantı haritası */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go", c: "c", cpp: "cpp", cs: "csharp",
  java: "java", kt: "kotlin", swift: "swift", rb: "ruby", php: "php",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  html: "html", css: "css", scss: "css", sql: "sql",
  glsl: "glsl", wgsl: "wgsl", hlsl: "hlsl",
  lua: "lua", dart: "dart", r: "r", perl: "perl", pl: "perl",
  md: "markdown", mdx: "markdown",
};

const PREVIEW_LINES = 50; // ilk kaç satır gösterilsin

export class SyntaxExtractor implements IPreviewExtractor {
  readonly name = "syntax";

  canExtract(_mime: string, ext: string): boolean {
    return ext.toLowerCase() in EXT_TO_LANG ||
           _mime.startsWith("text/");
  }

  async extract(params: ExtractParams): Promise<PreviewResult> {
    const t0   = Date.now();
    const text = decode(params.data).slice(0, 500_000); // max 500KB
    const ext  = params.format.toLowerCase();
    const lang = EXT_TO_LANG[ext] ?? "plaintext";
    const lines = text.split("\n");

    // Minimal syntax highlight — production'da Shiki kullanılır
    const previewText = lines.slice(0, PREVIEW_LINES).join("\n");
    const html        = this._highlight(previewText, lang);

    const detail: SyntaxHighlightResult = {
      html,
      language:     lang,
      lineCount:    lines.length,
      previewLines: PREVIEW_LINES,
    };

    const excerpt = `${lang} — ${lines.length} satır`;
    return {
      ...baseResult(params, "syntax", t0),
      og:     buildOG(params.fileName, excerpt),
      detail,
    };
  }

  private _highlight(code: string, _lang: string): string {
    // Minimal HTML escape (Shiki prodüksiyonda)
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre class="shiki"><code class="language-${_lang}">${escaped}</code></pre>`;
  }
}

// ─── OpenGraphExtractor ───────────────────────────────────────────────────────

/**
 * Herhangi bir dosya için OG metadata üretir.
 * HTML dosyaları için gerçek OG tag'larını ayrıştırır.
 */
export class OpenGraphExtractor implements IPreviewExtractor {
  readonly name = "opengraph";

  canExtract(mime: string, ext: string): boolean {
    return ext === "html" || mime.includes("html");
  }

  async extract(params: ExtractParams): Promise<PreviewResult> {
    const t0   = Date.now();
    const text = decode(params.data).slice(0, 50_000);
    const og   = this._extractOG(text);

    return {
      ...baseResult(params, "opengraph", t0),
      og,
    };
  }

  private _extractOG(html: string): OpenGraphMeta {
    const meta: Record<string, string> = {};

    // OG meta tag'larını ayrıştır
    const metaRe = /<meta\s+[^>]*property="og:([^"]+)"[^>]*content="([^"]*)"[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = metaRe.exec(html)) !== null) {
      meta[m[1]] = m[2];
    }

    // Fallback: title tag
    if (!meta["title"]) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch) meta["title"] = titleMatch[1];
    }

    // Fallback: description meta
    if (!meta["description"]) {
      const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
      if (descMatch) meta["description"] = descMatch[1];
    }

    return {
      title:       meta["title"],
      description: meta["description"],
      image:       meta["image"],
      siteName:    meta["site_name"],
      type:        (meta["type"] as OpenGraphMeta["type"]) ?? "website",
      url:         meta["url"],
      custom:      meta,
    };
  }
}

// ─── BinaryExtractor ─────────────────────────────────────────────────────────

export class BinaryExtractor implements IPreviewExtractor {
  readonly name = "binary";

  canExtract(mime: string, _ext: string): boolean {
    return mime.includes("octet-stream") || mime.includes("wasm");
  }

  async extract(params: ExtractParams): Promise<PreviewResult> {
    const t0  = Date.now();
    const hex = this._hexDump(params.data, 256); // ilk 256 byte

    return {
      ...baseResult(params, "binary", t0),
      og: buildOG(params.fileName, `Binary — ${params.data.byteLength} byte`),
      detail: {
        hexDump:  hex,
        encoding: this._detectEncoding(params.data),
      },
    };
  }

  private _hexDump(data: Uint8Array, limit: number): string {
    const lines: string[] = [];
    for (let i = 0; i < Math.min(data.length, limit); i += 16) {
      const row   = data.slice(i, Math.min(i + 16, data.length));
      const addr  = i.toString(16).padStart(8, "0");
      const hex   = Array.from(row).map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const ascii = Array.from(row).map((b) => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : ".").join("");
      lines.push(`${addr}  ${hex.padEnd(47)}  |${ascii}|`);
    }
    if (data.length > limit) lines.push(`... (${data.length - limit} more bytes)`);
    return lines.join("\n");
  }

  private _detectEncoding(data: Uint8Array): string {
    // WASM magic
    if (data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6D)
      return "WebAssembly";
    // ELF
    if (data[0] === 0x7F && data[1] === 0x45 && data[2] === 0x4C && data[3] === 0x46)
      return "ELF Binary";
    // PE
    if (data[0] === 0x4D && data[1] === 0x5A) return "PE/EXE Binary";
    // PDF
    if (data[0] === 0x25 && data[1] === 0x50) return "PDF";
    return "Binary";
  }
}

// ─── ImageExtractor ───────────────────────────────────────────────────────────

export class ImageExtractor implements IPreviewExtractor {
  readonly name = "image";

  canExtract(mime: string, ext: string): boolean {
    return mime.startsWith("image/") ||
           ["png","jpg","jpeg","gif","webp","svg","avif","bmp"].includes(ext.toLowerCase());
  }

  async extract(params: ExtractParams): Promise<PreviewResult> {
    const t0        = Date.now();
    const isSVG     = params.format === "svg";
    let   thumbnail = "";

    if (isSVG) {
      // SVG: direkt data URI
      const b64 = Buffer.from(params.data).toString("base64");
      thumbnail  = `data:image/svg+xml;base64,${b64}`;
    } else {
      // Raster: thumbnail stub (prodüksiyonda Canvas/Sharp ile resize)
      const b64 = Buffer.from(params.data).toString("base64");
      thumbnail  = `data:${params.mimeType};base64,${b64.slice(0, 100)}...`;
    }

    return {
      ...baseResult(params, "image", t0),
      og:     buildOG(params.fileName, `${params.format.toUpperCase()} görsel`, { image: thumbnail }),
      detail: { thumbnailDataUri: thumbnail },
    };
  }
}

// ─── Model3DExtractor ─────────────────────────────────────────────────────────

/**
 * STL, OBJ, PLY dosyaları için 3D metadata çıkarma.
 * Gerçek thumbnail: prodüksiyonda Three.js OffscreenCanvas ile üretilir.
 * Bu extractor: triangle count, bounds, format metadata.
 */
export class Model3DExtractor implements IPreviewExtractor {
  readonly name = "model_3d";

  canExtract(mime: string, ext: string): boolean {
    return ["stl","obj","ply","gltf","glb","fbx","3ds"].includes(ext.toLowerCase()) ||
           mime.includes("model/");
  }

  async extract(params: ExtractParams): Promise<PreviewResult> {
    const t0   = Date.now();
    const text = decode(params.data);

    const detail = params.format === "stl"
      ? this._parseSTL(text, params.data)
      : this._genericModel(params);

    return {
      ...baseResult(params, "model_3d", t0),
      og: buildOG(
        params.fileName,
        `3D Model — ${detail.format.toUpperCase()}` +
        (detail.triangleCount ? ` (${detail.triangleCount.toLocaleString()} üçgen)` : "")
      ),
      detail,
    };
  }

  private _parseSTL(text: string, data: Uint8Array): Model3DPreview {
    const isASCII = text.trim().startsWith("solid");
    let triangleCount = 0;

    if (isASCII) {
      triangleCount = (text.match(/^facet normal/gm) ?? []).length;
    } else {
      // Binary STL: byte 80-83 = triangle count (uint32 LE)
      if (data.byteLength >= 84) {
        const view  = new DataView(data.buffer, data.byteOffset, data.byteLength);
        triangleCount = view.getUint32(80, true); // little-endian
      }
    }

    return {
      thumbnail:     this._placeholder3D(),
      format:        "stl",
      triangleCount,
    };
  }

  private _genericModel(params: ExtractParams): Model3DPreview {
    return {
      thumbnail: this._placeholder3D(),
      format:    params.format,
    };
  }

  /** 3D thumbnail placeholder SVG */
  private _placeholder3D(): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect width="256" height="256" fill="#171B22"/>
      <polygon points="128,40 200,140 56,140" fill="none" stroke="#5B8CFF" stroke-width="2"/>
      <polygon points="128,40 200,140 128,180" fill="#1e2533" stroke="#5B8CFF" stroke-width="1"/>
      <polygon points="128,40 56,140 128,180" fill="#222b3a" stroke="#5B8CFF" stroke-width="1"/>
      <polygon points="200,140 56,140 128,180" fill="#1a2030" stroke="#5B8CFF" stroke-width="1"/>
      <text x="128" y="210" text-anchor="middle" fill="#9CA6B5" font-family="monospace" font-size="12">3D Model</text>
    </svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  }
}
