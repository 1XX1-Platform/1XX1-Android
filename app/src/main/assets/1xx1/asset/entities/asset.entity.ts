/**
 * 1XX1 Asset Bank Domain Entity'leri
 * Aşama 11 — Asset Bank
 *
 * Asset Bank bir dosya deposu değildir.
 * Özgür üretimleri aranabilir, sürümlenebilir, yeniden kullanılabilir
 * açık bir bilgi ağına dönüştürür.
 *
 * Temel prensipler:
 *   - Platform hiçbir varlığın sahibi değildir; yalnızca indeksler
 *   - Dosya içeriği Storage Adapter'de, metadata veritabanında
 *   - SHA-256 ile duplicate detection (içerik → checksum → referans)
 *   - Her asset sürümlenir; eski sürümler silinmez
 *   - Bağımlılık grafiği döngüsel olamaz (DAG)
 */

// ─── Varlık Türleri ───────────────────────────────────────────────────────────

export type AssetType =
  | "3d_model"    // STL, OBJ, FBX, GLTF
  | "mesh"        // ham üçgen ağı
  | "texture"     // PNG, JPEG, EXR, HDR
  | "audio"       // WAV, FLAC, OGG, MP3
  | "video"       // MP4, WebM, MKV
  | "image"       // PNG, SVG, JPEG
  | "font"        // TTF, OTF, WOFF2
  | "cad"         // STEP, IGES, DWG
  | "document"    // PDF, Markdown, LaTeX
  | "dataset"     // CSV, JSON, Parquet
  | "script"      // Python, JavaScript, Shell
  | "plugin"      // uygulama eklentisi
  | "shader"      // GLSL, WGSL, HLSL
  | "unknown";

// ─── Desteklenen Formatlar ────────────────────────────────────────────────────

export const SUPPORTED_FORMATS: Record<AssetType, string[]> = {
  "3d_model": ["stl", "obj", "fbx", "gltf", "glb", "ply", "3ds"],
  mesh:       ["stl", "obj", "off", "ply"],
  texture:    ["png", "jpg", "jpeg", "exr", "hdr", "tga", "webp"],
  audio:      ["wav", "flac", "ogg", "mp3", "aac"],
  video:      ["mp4", "webm", "mkv", "mov"],
  image:      ["png", "svg", "jpg", "jpeg", "gif", "webp", "avif"],
  font:       ["ttf", "otf", "woff", "woff2"],
  cad:        ["step", "stp", "iges", "igs", "dwg", "dxf"],
  document:   ["pdf", "md", "tex", "rst", "txt", "html"],
  dataset:    ["csv", "json", "jsonl", "parquet", "tsv", "xlsx"],
  script:     ["py", "js", "ts", "sh", "bash", "rb", "lua"],
  plugin:     ["wasm", "so", "dll", "dylib", "zip"],
  shader:     ["glsl", "wgsl", "hlsl", "spv", "vert", "frag"],
  unknown:    [],
};

// ─── Asset Lisansları ─────────────────────────────────────────────────────────

export type AssetLicenseType =
  | "MIT"
  | "Apache-2.0"
  | "GPL-2.0"
  | "GPL-3.0"
  | "LGPL-2.1"
  | "LGPL-3.0"
  | "BSD-2-Clause"
  | "BSD-3-Clause"
  | "CC0-1.0"
  | "CC-BY-4.0"
  | "CC-BY-SA-4.0"
  | "CC-BY-NC-4.0"
  | "Proprietary"  // yalnızca metadata görünür, dosya indirilemez
  | "Unknown";

/** Lisans copyleft mi? (türevler aynı lisansı kullanmak zorunda) */
export const COPYLEFT_LICENSES = new Set<AssetLicenseType>([
  "GPL-2.0", "GPL-3.0", "LGPL-2.1", "LGPL-3.0",
  "CC-BY-SA-4.0",
]);

/** Lisans ticari kullanıma izin veriyor mu? */
export const NON_COMMERCIAL_LICENSES = new Set<AssetLicenseType>([
  "CC-BY-NC-4.0",
]);

// ─── Asset Durumu ─────────────────────────────────────────────────────────────

export type AssetStatus =
  | "pending"      // yüklendi, doğrulama bekliyor
  | "active"       // kullanılabilir
  | "flagged"      // içerik sorunu rapor edildi
  | "removed";     // kaldırıldı (metadata kaldı, dosya yok)

// ─── Checksum ────────────────────────────────────────────────────────────────

export interface Checksum {
  sha256:  string;
  sha512?: string;
  blake3?: string;
}

// ─── Asset Dosyası ───────────────────────────────────────────────────────────

/**
 * Gerçek dosya verisi Storage Adapter'de.
 * Veritabanında yalnızca referans bilgileri.
 */
export interface AssetFile {
  /** Storage Adapter'deki nesne anahtarı */
  storageKey:  string;
  /** Dosya adı (orijinal) */
  fileName:    string;
  /** MIME tipi */
  mimeType:    string;
  /** Byte cinsinden boyut */
  size:        number;
  /** İçerik özeti */
  checksum:    Checksum;
  /** Küçük resim (base64 veya storage key) */
  thumbnail?:  string;
  /** Yükleme zamanı */
  uploadedAt:  Date;
}

// ─── Asset Sürümü ────────────────────────────────────────────────────────────

export interface AssetVersion {
  versionId:   string;
  assetId:     string;
  versionStr:  string;          // "1.0.0" formatı
  files:       AssetFile[];
  changeLog:   string;          // bu sürümde ne değişti
  uploadedBy:  string;          // developer ID
  uploadedAt:  Date;
  /** Bu sürüm aktif/kullanılabilir mi? */
  deprecated:  boolean;
}

// ─── Asset (Ana Entity) ───────────────────────────────────────────────────────

export interface Asset {
  assetId:      string;
  ownerId:      string;          // developer ID
  channelId?:   string;
  projectId?:   string;
  releaseId?:   string;

  type:         AssetType;
  format:       string;          // "stl", "png", vb.
  title:        string;
  description:  string;
  tags:         string[];
  license:      AssetLicenseType;
  status:       AssetStatus;

  /** Tüm sürümler (eski silinmez) */
  versions:     AssetVersion[];
  /** Güncel sürüm ID'si */
  latestVersion: string;

  /** İndirme sayacı (Pulse Engine istatistiği) */
  downloadCount: number;
  /** Referans sayacı (kaç proje bu asset'i kullanıyor) */
  referenceCount: number;

  createdAt:    Date;
  updatedAt:    Date;
}

// ─── Bağımlılık Kenarı ───────────────────────────────────────────────────────

/**
 * Bir asset başka asset'lere bağımlı olabilir.
 * Bu bir yönlü kenar: source → target
 * Döngüsel bağımlılık kabul edilmez (DAG zorunluluğu).
 */
export interface AssetDependency {
  sourceId:    string;   // bu asset
  targetId:    string;   // bu asset'e bağımlı
  type:        "uses" | "extends" | "bundles";
  addedAt:     Date;
}

// ─── Arama Özeti ─────────────────────────────────────────────────────────────

export interface AssetSummary {
  assetId:      string;
  type:         AssetType;
  format:       string;
  title:        string;
  ownerId:      string;
  license:      AssetLicenseType;
  downloadCount: number;
  latestVersion: string;
  tags:         string[];
  createdAt:    string;  // ISO
}

export function toAssetSummary(a: Asset): AssetSummary {
  return {
    assetId:      a.assetId,
    type:         a.type,
    format:       a.format,
    title:        a.title,
    ownerId:      a.ownerId,
    license:      a.license,
    downloadCount: a.downloadCount,
    latestVersion: a.latestVersion,
    tags:         a.tags,
    createdAt:    a.createdAt.toISOString(),
  };
}

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

/** Dosya uzantısından asset türünü tahmin et */
export function guessAssetType(ext: string): AssetType {
  const lower = ext.toLowerCase().replace(/^\./, "");
  for (const [type, formats] of Object.entries(SUPPORTED_FORMATS)) {
    if ((formats as string[]).includes(lower)) return type as AssetType;
  }
  return "unknown";
}

/** Format destekleniyor mu? */
export function isSupportedFormat(assetType: AssetType, format: string): boolean {
  return SUPPORTED_FORMATS[assetType]?.includes(format.toLowerCase()) ?? false;
}
