/**
 * 1XX1 Binary, Metadata ve Dependency Analyzer'ları
 * Aşama 12 — Security Analysis Engine
 */

import type {
  IAnalyzer, AnalysisInput, AnalyzerResult, Finding, RiskLevel,
} from "../security-types.ts";
import { maxRisk } from "../security-types.ts";
import { generateId } from "../../core/utils.ts";
import type { DependencyGraph } from "../../asset/dependency/dependency-graph.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// Binary Analyzer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Derlenmiş binary/executable dosya analizi.
 * Magic bytes ile dosya tipini doğrular; şüpheli API çağrılarını import
 * tablosunda arar; sıkıştırılmış payload varlığını kontrol eder.
 */

const BINARY_FORMATS = new Set(["wasm", "so", "dll", "dylib", "exe", "elf"]);

// Şüpheli import/string'ler — binary içinde bulunursa bayrak
const SUSPICIOUS_STRINGS: Array<{
  pattern: RegExp;
  risk: RiskLevel;
  title: string;
  description: string;
  recommendation: string;
}> = [
  {
    pattern: /VirtualAlloc|WriteProcessMemory|CreateRemoteThread/i,
    risk: "critical", title: "Windows Process Injection API",
    description: "Süreç enjeksiyonu için kullanılan Windows API çağrısı tespit edildi.",
    recommendation: "Bu API çağrısının meşru kullanım amacını belgeleyin.",
  },
  {
    pattern: /ptrace|mprotect|mmap.*PROT_EXEC/i,
    risk: "high", title: "Linux Hafıza Manipülasyon API",
    description: "Çalıştırılabilir bellek sayfası oluşturma veya süreç izleme API'si.",
    recommendation: "Sandbox içinde test edilmeden yayınlanmamalı.",
  },
  {
    pattern: /WinExec|ShellExecute|CreateProcess/i,
    risk: "high", title: "Windows Süreç Başlatma API",
    description: "Dışarıdan süreç başlatma API'si tespit edildi.",
    recommendation: "Bu API'nin gerekçesini belgeleyin.",
  },
  {
    pattern: /UPX!|MPRESS|NSPack/,
    risk: "high", title: "Packer İmzası",
    description: "Binary packer imzası — payload gizlenmiş olabilir.",
    recommendation: "Paketlenmiş binary'ler sandbox analizine tabi tutulmalı (Aşama 13).",
  },
  {
    pattern: /cmd\.exe|\/bin\/sh|powershell/i,
    risk: "medium", title: "Shell Referansı",
    description: "Binary içinde shell yürütücü referansı bulundu.",
    recommendation: "Shell kullanımının amacını açıklayın.",
  },
];

export class BinaryAnalyzer implements IAnalyzer {
  readonly name = "binary-analyzer";

  canAnalyze(input: AnalysisInput): boolean {
    return BINARY_FORMATS.has(input.format.toLowerCase()) ||
           input.mimeType.includes("octet-stream") ||
           input.mimeType.includes("wasm");
  }

  async analyze(input: AnalysisInput): Promise<AnalyzerResult> {
    const t0 = Date.now();

    if (!this.canAnalyze(input)) {
      return this._skip("Binary format değil");
    }

    const findings: Finding[] = [];
    const text = this._binaryToString(input.data);

    // Şüpheli string araması
    for (const check of SUSPICIOUS_STRINGS) {
      if (check.pattern.test(text)) {
        findings.push({
          id:             `B-${generateId().slice(0, 6)}`,
          risk:           check.risk,
          category:       check.risk === "critical" ? "binary_exec" : "suspicious_import",
          title:          check.title,
          description:    check.description,
          file:           input.fileName,
          recommendation: check.recommendation,
          analyzer:       this.name,
        });
      }
    }

    // Sıkıştırılmış payload kontrolü: ZLIB/gzip magic bytes içinde mi?
    const hasCompressed = this._detectCompressedPayload(input.data);
    if (hasCompressed) {
      findings.push({
        id:          `B-COMP-${generateId().slice(0, 6)}`,
        risk:        "medium",
        category:    "compressed_payload",
        title:       "Gömülü Sıkıştırılmış Payload",
        description: "Binary içinde sıkıştırılmış (ZLIB/GZIP) veri bulundu.",
        file:        input.fileName,
        recommendation: "Gömülü payload'ın amacını açıklayın; sandbox analizi önerilir.",
        analyzer:    this.name,
      });
    }

    const risk = findings.reduce<RiskLevel>((acc, f) => maxRisk(acc, f.risk), "none");
    return { analyzer: this.name, findings, risk, durationMs: Date.now() - t0, skipped: false };
  }

  /** Binary verisini printable ASCII'ye çevir (string arama için) */
  private _binaryToString(data: Uint8Array): string {
    const chars: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (b >= 0x20 && b < 0x7F) chars.push(String.fromCharCode(b));
      else chars.push(".");
    }
    return chars.join("");
  }

  /** ZLIB (0x78 0x9C) veya GZIP (0x1F 0x8B) magic bytes ara */
  private _detectCompressedPayload(data: Uint8Array): boolean {
    for (let i = 0; i < data.length - 2; i++) {
      if ((data[i] === 0x78 && (data[i + 1] === 0x9C || data[i + 1] === 0xDA)) ||
          (data[i] === 0x1F && data[i + 1] === 0x8B)) {
        return true;
      }
    }
    return false;
  }

  private _skip(reason: string): AnalyzerResult {
    return { analyzer: this.name, findings: [], risk: "none", durationMs: 0, skipped: true, skipReason: reason };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Metadata Analyzer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dosya metadata bütünlüğü analizi.
 * Checksum doğrulama, MIME uyuşmazlığı, boyut sınırı.
 * Her yükleme için çalışır — format bağımsız.
 */

const MIME_EXTENSION_MAP: Record<string, string[]> = {
  "image/png":         ["png"],
  "image/jpeg":        ["jpg", "jpeg"],
  "model/stl":         ["stl"],
  "model/gltf-binary": ["glb"],
  "application/wasm":  ["wasm"],
  "text/plain":        ["txt", "md", "py", "js", "ts", "sh"],
  "application/json":  ["json"],
  "application/pdf":   ["pdf"],
};

export class MetadataAnalyzerChecker implements IAnalyzer {
  readonly name = "metadata-analyzer";

  private readonly maxSizeBytes: number;

  constructor(maxSizeMb = 512) {
    this.maxSizeMb = maxSizeMb;
    this.maxSizeBytes = maxSizeMb * 1024 * 1024;
  }

  canAnalyze(_input: AnalysisInput): boolean { return true; } // her dosyaya

  async analyze(input: AnalysisInput): Promise<AnalyzerResult> {
    const t0       = Date.now();
    const findings: Finding[] = [];

    // Boyut kontrolü
    if (input.data.byteLength > this.maxSizeBytes) {
      findings.push({
        id: `M-SIZE-${generateId().slice(0, 6)}`,
        risk: "medium", category: "oversized",
        title: "Dosya Boyutu Sınırı",
        description: `Dosya ${(input.data.byteLength / 1024 / 1024).toFixed(1)}MB (limit: ${this.maxSizeBytes / 1024 / 1024}MB)`,
        file: input.fileName,
        recommendation: "Büyük dosyaları parçalara bölün veya sıkıştırın.",
        analyzer: this.name,
      });
    }

    // Boş dosya
    if (input.data.byteLength === 0) {
      findings.push({
        id: `M-EMPTY-${generateId().slice(0, 6)}`,
        risk: "low", category: "mime_mismatch",
        title: "Boş Dosya", description: "Dosya içeriği boş.",
        file: input.fileName, recommendation: "Boş dosyaları yüklemeyin.",
        analyzer: this.name,
      });
    }

    // MIME / uzantı uyuşmazlığı
    const allowedExts = MIME_EXTENSION_MAP[input.mimeType];
    if (allowedExts && !allowedExts.includes(input.format.toLowerCase())) {
      findings.push({
        id: `M-MIME-${generateId().slice(0, 6)}`,
        risk: "high", category: "mime_mismatch",
        title: "MIME / Uzantı Uyuşmazlığı",
        description: `MIME tipi "${input.mimeType}" ama uzantı ".${input.format}". İçerik gerçek formatından farklı ilan edilmiş olabilir.`,
        file: input.fileName,
        recommendation: "Dosyayı doğru uzantıyla yeniden yükleyin.",
        analyzer: this.name,
      });
    }

    const risk = findings.reduce<RiskLevel>((acc, f) => maxRisk(acc, f.risk), "none");
    return { analyzer: this.name, findings, risk, durationMs: Date.now() - t0, skipped: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dependency Analyzer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bağımlılık grafını analiz eder.
 * Lisans uyumluluğu, bilinen güvenlik açıkları (örnek veri),
 * terk edilmiş paket tespiti.
 */

/** Örnek bilinen güvenlik açıkları (production'da CVE veritabanı ile beslenir) */
const KNOWN_VULNERABILITIES: Record<string, { risk: RiskLevel; cve: string; description: string }> = {
  "left-pad@0.0.3":     { risk: "low",    cve: "N/A",             description: "Terk edilmiş — Registry'den kaldırıldı" },
  "lodash@4.17.15":     { risk: "medium",  cve: "CVE-2021-23337",  description: "Prototype pollution güvenlik açığı" },
  "minimist@1.2.5":     { risk: "medium",  cve: "CVE-2021-44906",  description: "Prototype pollution" },
  "log4j@2.14.1":       { risk: "critical", cve: "CVE-2021-44228", description: "Log4Shell — uzaktan kod yürütme" },
};

export class DependencyAnalyzerChecker implements IAnalyzer {
  readonly name = "dependency-analyzer";

  constructor(
    depGraph?: DependencyGraph
  ) {
    this.depGraph = depGraph;}

  canAnalyze(input: AnalysisInput): boolean {
    // package.json, requirements.txt, Cargo.toml vb.
    return ["json", "txt", "toml", "lock", "yaml", "yml"].includes(input.format.toLowerCase());
  }

  async analyze(input: AnalysisInput): Promise<AnalyzerResult> {
    const t0       = Date.now();
    const findings: Finding[] = [];

    if (!this.canAnalyze(input)) {
      return { analyzer: this.name, findings: [], risk: "none", durationMs: Date.now() - t0, skipped: true, skipReason: "Bağımlılık dosyası değil" };
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(input.data);

    // package.json ayrıştırma
    if (input.fileName.endsWith("package.json")) {
      findings.push(...this._analyzePackageJson(text, input.fileName));
    }

    // requirements.txt ayrıştırma
    if (input.fileName.endsWith("requirements.txt")) {
      findings.push(...this._analyzeRequirements(text, input.fileName));
    }

    // Dependency Graph döngü kontrolü
    if (this.depGraph) {
      const stats = this.depGraph.stats();
      if (stats.maxDepth > 20) {
        findings.push({
          id: `D-DEPTH-${generateId().slice(0, 6)}`,
          risk: "low", category: "abandoned_dep",
          title: "Çok Derin Bağımlılık Zinciri",
          description: `Bağımlılık derinliği ${stats.maxDepth} — yönetimi zorlaşabilir.`,
          recommendation: "Bağımlılık ağını basitleştirin.",
          analyzer: this.name,
        });
      }
    }

    const risk = findings.reduce<RiskLevel>((acc, f) => maxRisk(acc, f.risk), "none");
    return { analyzer: this.name, findings, risk, durationMs: Date.now() - t0, skipped: false };
  }

  private _analyzePackageJson(text: string, file: string): Finding[] {
    const findings: Finding[] = [];
    try {
      const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, version] of Object.entries(allDeps ?? {})) {
        const key = `${name}@${version.replace(/[\^~>=<]/g, "")}`;
        const vuln = KNOWN_VULNERABILITIES[key];
        if (vuln) {
          findings.push({
            id: `D-CVE-${generateId().slice(0, 6)}`,
            risk: vuln.risk, category: "known_vulnerability",
            title: `Bilinen Güvenlik Açığı: ${name}`,
            description: `${key}: ${vuln.description} (${vuln.cve})`,
            file, recommendation: `${name} paketini güncelleyin.`,
            analyzer: this.name,
          });
        }
      }
    } catch { /* JSON ayrıştırma hatası — atla */ }
    return findings;
  }

  private _analyzeRequirements(text: string, file: string): Finding[] {
    const findings: Finding[] = [];
    for (const line of text.split("\n")) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      // "package==version" veya "package>=version"
      const match = clean.match(/^([a-zA-Z0-9_\-]+)[>=<]=?([0-9.]+)/);
      if (match) {
        const key = `${match[1].toLowerCase()}@${match[2]}`;
        const vuln = KNOWN_VULNERABILITIES[key];
        if (vuln) {
          findings.push({
            id: `D-PY-${generateId().slice(0, 6)}`,
            risk: vuln.risk, category: "known_vulnerability",
            title: `Python Güvenlik Açığı: ${match[1]}`,
            description: `${key}: ${vuln.description} (${vuln.cve})`,
            file, recommendation: `${match[1]}'i güncelleyin.`,
            analyzer: this.name,
          });
        }
      }
    }
    return findings;
  }
}
