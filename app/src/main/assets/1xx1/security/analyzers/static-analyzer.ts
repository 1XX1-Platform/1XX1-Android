/**
 * 1XX1 Static Analyzer — Kaynak Kodu Analizi
 * Aşama 12 — Security Analysis Engine
 *
 * Kural tabanlı statik analiz.
 * Dosyayı çalıştırmaz; yalnızca metin/binary içeriği inceler.
 *
 * Kategoriler:
 *   SECRET         — API anahtarı, şifre, token, sertifika
 *   SHELL_EXEC     — sistem komutu çağrısı
 *   DYNAMIC_CODE   — eval, exec, Function()
 *   NETWORK_ACCESS — HTTP, WebSocket, DNS
 *   FS_ACCESS      — dosya okuma/yazma
 *   PROCESS_SPAWN  — alt süreç başlatma
 *   OBFUSCATED     — base64 gizleme, uzun hex string
 *
 * Her kural: regex + risk seviyesi + açıklama + öneri
 * Kural tabanlı olduğu için false positive olabilir;
 * Policy Engine bu oranı yönetir.
 */

import type {
  IAnalyzer, AnalysisInput, AnalyzerResult, Finding, RiskLevel, FindingCategory,
} from "../security-types.ts";
import { maxRisk } from "../security-types.ts";
import { generateId } from "../../core/utils.ts";

// ─── Kural Tanımı ────────────────────────────────────────────────────────────

interface StaticRule {
  id:             string;
  pattern:        RegExp;
  category:       FindingCategory;
  risk:           RiskLevel;
  title:          string;
  description:    string;
  recommendation: string;
}

// ─── Kural Kataloğu ───────────────────────────────────────────────────────────

const STATIC_RULES: StaticRule[] = [
  // ── Gizli Anahtarlar ──
  {
    id: "S001", pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']([A-Za-z0-9_\-]{16,})/i,
    category: "secret", risk: "critical",
    title: "API Anahtarı Tespiti",
    description: "Kaynak kodunda gömülü API anahtarı bulundu.",
    recommendation: "API anahtarlarını ortam değişkenlerinde saklayın, kaynak koduna gömmeyin.",
  },
  {
    id: "S002", pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']([^"']{8,})/i,
    category: "secret", risk: "critical",
    title: "Gömülü Şifre",
    description: "Kaynak kodunda düz metin şifre bulundu.",
    recommendation: "Şifreleri gizli yönetim sistemi veya ortam değişkeni ile yönetin.",
  },
  {
    id: "S003", pattern: /(?:secret|token|auth)[_-]?(?:key)?\s*[:=]\s*["']([A-Za-z0-9+/=_\-]{20,})/i,
    category: "secret", risk: "high",
    title: "Gizli Token",
    description: "Olası gizli token veya authentication bilgisi.",
    recommendation: "Token'ları kaynak koda gömmeyin; güvenli anahtar yönetimi kullanın.",
  },
  {
    id: "S004",
    pattern: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH|CERTIFICATE)[\s\S]+?-----END/,
    category: "secret", risk: "critical",
    title: "Sertifika/Özel Anahtar",
    description: "Kaynak kodunda kriptografik anahtar veya sertifika bulundu.",
    recommendation: "Özel anahtarları asla kaynak koda eklemeyin.",
  },

  // ── Shell Komutu ──
  {
    id: "S010",
    pattern: /(?:subprocess|os\.system|os\.popen|shell=True|exec\(|execvp?\(|popen)/,
    category: "shell_exec", risk: "high",
    title: "Shell Komutu Çalıştırma",
    description: "Kaynak kod shell komutu çalıştırabilir.",
    recommendation: "Shell komutları yerine platform API'lerini kullanın.",
  },
  {
    id: "S011",
    pattern: /\bchild_process\b|\brequire\(['"]child_process['"]\)/,
    category: "shell_exec", risk: "high",
    title: "Node.js child_process Kullanımı",
    description: "Node.js child_process modülü import ediliyor.",
    recommendation: "Alt süreç gerekiyorsa sandbox içinde yürütün.",
  },
  {
    id: "S012",
    pattern: /Runtime\.getRuntime\(\)\.exec|ProcessBuilder/,
    category: "shell_exec", risk: "high",
    title: "Java Runtime.exec",
    description: "Java Runtime.exec ile süreç başlatılıyor.",
    recommendation: "ProcessBuilder kullanın ve girdileri doğrulayın.",
  },

  // ── Dinamik Kod ──
  {
    id: "S020",
    pattern: /\beval\s*\(/,
    category: "dynamic_code", risk: "high",
    title: "eval() Kullanımı",
    description: "eval() dinamik kod çalıştırır, ciddi güvenlik riski taşır.",
    recommendation: "eval() yerine JSON.parse() veya güvenli alternatifler kullanın.",
  },
  {
    id: "S021",
    pattern: /new\s+Function\s*\(/,
    category: "dynamic_code", risk: "high",
    title: "new Function() Kullanımı",
    description: "Dinamik fonksiyon oluşturma tespit edildi.",
    recommendation: "Dinamik kod üretiminden kaçının.",
  },
  {
    id: "S022",
    pattern: /\b__import__\s*\(|importlib\.import_module/,
    category: "dynamic_code", risk: "medium",
    title: "Dinamik Modül Yükleme (Python)",
    description: "Çalışma zamanında dinamik modül yükleniyor.",
    recommendation: "Yüklenecek modülleri sabit liste ile kısıtlayın.",
  },

  // ── Ağ Erişimi ──
  {
    id: "S030",
    pattern: /(?:fetch|XMLHttpRequest|axios|urllib|requests\.get|socket\.connect)\s*\(/,
    category: "network_access", risk: "medium",
    title: "Ağ İsteği",
    description: "Kod ağ bağlantısı kuruyor.",
    recommendation: "Ağ erişimi gerekiyorsa izin verilenler listesiyle kısıtlayın.",
  },
  {
    id: "S031",
    pattern: /new\s+WebSocket\s*\(|io\.connect\s*\(/,
    category: "network_access", risk: "medium",
    title: "WebSocket Bağlantısı",
    description: "Gerçek zamanlı ağ bağlantısı tespit edildi.",
    recommendation: "WebSocket kullanımını dokümante edin.",
  },

  // ── Dosya Sistemi Erişimi ──
  {
    id: "S040",
    pattern: /(?:fs\.(?:readFile|writeFile|unlink|rm|rmdir)|open\s*\([^)]+,\s*['"]w)/,
    category: "fs_access", risk: "medium",
    title: "Dosya Sistemi Yazma",
    description: "Kod dosya sistemi yazma işlemi yapıyor.",
    recommendation: "Dosya yazma izinlerini minimumda tutun.",
  },
  {
    id: "S041",
    pattern: /path\.join\s*\(\s*['"]\/|__dirname|process\.cwd\(\)/,
    category: "fs_access", risk: "low",
    title: "Mutlak Yol Kullanımı",
    description: "Mutlak dosya sistemi yolu tespit edildi.",
    recommendation: "Göreli yolları tercih edin.",
  },

  // ── Gizleme ──
  {
    id: "S050",
    pattern: /atob\s*\(|btoa\s*\(|Buffer\.from\([^,]+,\s*['"]base64['"]\)/,
    category: "obfuscated_code", risk: "medium",
    title: "Base64 Decode",
    description: "Base64 kodlanmış veri çözümleniyor — gizlenmiş kod olabilir.",
    recommendation: "Base64 kullanımının amacını dokümante edin.",
  },
  {
    id: "S051",
    pattern: /(?:[0-9a-fA-F]{2}){20,}/,
    category: "obfuscated_code", risk: "low",
    title: "Uzun Hex Dizisi",
    description: "Uzun hex string tespit edildi — gizlenmiş binary içerik olabilir.",
    recommendation: "Hex dizisinin kaynağını ve amacını belirtin.",
  },
];

// ─── StaticAnalyzer ───────────────────────────────────────────────────────────

/** Analiz edilecek kaynak kodu uzantıları */
const SOURCE_EXTENSIONS = new Set([
  "js", "ts", "jsx", "tsx", "mjs", "cjs",
  "py", "rb", "php", "java", "go", "rs", "c", "cpp", "cs",
  "sh", "bash", "zsh", "fish", "ps1",
  "lua", "r", "pl", "swift", "kt", "dart",
  "wasm", // WASM text format
]);

/** Maksimum satır başına snippet uzunluğu */
const MAX_SNIPPET_LEN = 120;

export class StaticAnalyzer implements IAnalyzer {
  readonly name = "static-analyzer";

  canAnalyze(input: AnalysisInput): boolean {
    return SOURCE_EXTENSIONS.has(input.format.toLowerCase());
  }

  async analyze(input: AnalysisInput): Promise<AnalyzerResult> {
    const t0 = Date.now();

    if (!this.canAnalyze(input)) {
      return this._skip("Kaynak kodu formatı değil");
    }

    const text     = this._decode(input.data);
    const lines    = text.split("\n");
    const findings: Finding[] = [];

    for (const rule of STATIC_RULES) {
      const hits = this._scan(text, lines, rule, input.fileName);
      findings.push(...hits);
    }

    const risk = findings.reduce<RiskLevel>(
      (acc, f) => maxRisk(acc, f.risk),
      "none"
    );

    return {
      analyzer:   this.name,
      findings,
      risk,
      durationMs: Date.now() - t0,
      skipped:    false,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _decode(data: Uint8Array): string {
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(data);
    } catch {
      return "";
    }
  }

  private _scan(
    text:     string,
    lines:    string[],
    rule:     StaticRule,
    fileName: string
  ): Finding[] {
    const findings: Finding[] = [];
    rule.pattern.lastIndex = 0; // reset stateful regex

    // Satır bazlı tarama
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = rule.pattern.exec(line);
      if (match) {
        const snippet = line.slice(0, MAX_SNIPPET_LEN).trim();
        findings.push({
          id:             `${rule.id}-${generateId().slice(0, 6)}`,
          risk:           rule.risk,
          category:       rule.category,
          title:          rule.title,
          description:    rule.description,
          file:           fileName,
          line:           i + 1,
          snippet:        this._redact(snippet),
          recommendation: rule.recommendation,
          analyzer:       this.name,
        });
        // Aynı kuraldan tek dosyada max 3 bulgu (false positive baskısı)
        if (findings.filter((f) => f.title === rule.title).length >= 3) break;
      }
    }

    return findings;
  }

  /** Hassas veriyi maskele */
  private _redact(snippet: string): string {
    return snippet
      .replace(/(password|passwd|secret|token|key)\s*[:=]\s*["'][^"']{4}/gi,
               "$1: \"[REDACTED]")
      .replace(/-----BEGIN[\s\S]{10,50}/, "-----BEGIN [REDACTED]");
  }

  private _skip(reason: string): AnalyzerResult {
    return {
      analyzer:   this.name,
      findings:   [],
      risk:       "none",
      durationMs: 0,
      skipped:    true,
      skipReason: reason,
    };
  }
}
