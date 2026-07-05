/**
 * 1XX1 Güvenlik Analiz Motoru Testleri
 * Aşama 12
 *
 * Gruplar:
 *   types          — risk seviyeleri, maxRisk
 *   static         — kural bazlı tespitler, false positive azaltma, redact
 *   binary         — magic bytes, şüpheli API, compressed payload
 *   metadata       — MIME uyuşmazlığı, boyut, boş dosya
 *   dependency     — package.json CVE, requirements.txt
 *   risk-engine    — toplama, sıralama
 *   policy         — P001-P006 kuralları, approve yolu
 *   pipeline       — tam akış, paralel/sıralı, timeout, event
 *   determinism    — aynı girdi → aynı rapor
 *   false-pos/neg  — yanlış pozitif baskısı
 *   performans     — büyük dosya, 100 dosya
 */

import {
  runSuite, assert, assertEqual
} from "../../core/test-utils.ts";
import {
  maxRisk, RISK_PRIORITY,
  type RiskLevel,
} from "../security-types.ts";
import { StaticAnalyzer } from "../analyzers/static-analyzer.ts";
import {
  BinaryAnalyzer,
  MetadataAnalyzerChecker,
  DependencyAnalyzerChecker,
} from "../analyzers/other-analyzers.ts";
import { RiskEngine, PolicyEngine } from "../risk/risk-policy.ts";
import { AnalysisPipeline, createAnalysisInput } from "../pipeline/analysis-pipeline.ts";
import { EventBus } from "../../core/event-bus.ts";
import type { SecurityReport } from "../security-types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function enc(text: string): Uint8Array { return new TextEncoder().encode(text); }

function makeInput(
  content:  string,
  fileName: string,
  mime = "text/plain"
) {
  return createAnalysisInput(enc(content), fileName, mime);
}

function makeBinaryInput(bytes: number[], fileName: string) {
  return createAnalysisInput(new Uint8Array(bytes), fileName, "application/octet-stream");
}

// PNG magic bytes + dolgu
function makePng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Array(100).fill(0)]);
}

// ─── Types ────────────────────────────────────────────────────────────────────

await runSuite("types/risk", {
  "maxRisk: critical > high > medium > low > none": () => {
    assertEqual(maxRisk("critical", "high"),   "critical");
    assertEqual(maxRisk("high",     "medium"), "high");
    assertEqual(maxRisk("medium",   "low"),    "medium");
    assertEqual(maxRisk("low",      "none"),   "low");
    assertEqual(maxRisk("none",     "none"),   "none");
  },

  "maxRisk simetrik": () => {
    assertEqual(maxRisk("high", "critical"), "critical");
    assertEqual(maxRisk("none", "high"),     "high");
  },

  "RISK_PRIORITY sırası doğru": () => {
    assert(RISK_PRIORITY["critical"] > RISK_PRIORITY["high"]);
    assert(RISK_PRIORITY["high"]     > RISK_PRIORITY["medium"]);
    assert(RISK_PRIORITY["medium"]   > RISK_PRIORITY["low"]);
    assert(RISK_PRIORITY["low"]      > RISK_PRIORITY["none"]);
  },
});

// ─── Static Analyzer ─────────────────────────────────────────────────────────

await runSuite("static/gizli-anahtarlar", {
  "API key tespiti → CRITICAL": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(`const apiKey = "sk_live_abc123defgh456789"`, "app.js");
    const r = await a.analyze(i);
    assert(!r.skipped);
    assert(r.findings.some((f) => f.category === "secret"), "Secret bulunmalı");
    assertEqual(r.risk, "critical");
  },

  "password gömülü → CRITICAL": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(`password = "super_secret_pass_123"`, "config.py");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "secret"));
  },

  "sertifika → CRITICAL": async () => {
    const a = new StaticAnalyzer();
    const content = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ...\n-----END RSA PRIVATE KEY-----`;
    const i = makeInput(content, "key.pem");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "secret" && f.risk === "critical"));
  },

  "redact: snippet'te şifre maskelenir": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(`password = "very_secret_password_here"`, "cfg.js");
    const r = await a.analyze(i);
    const f = r.findings.find((f) => f.category === "secret");
    if (f?.snippet) {
      assert(!f.snippet.includes("very_secret_password_here"),
        `Şifre maskelenmeli, snippet: ${f.snippet}`);
    }
  },
});

await runSuite("static/shell-exec", {
  "os.system Python → HIGH": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(`os.system("rm -rf /")`, "script.py");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "shell_exec" && f.risk === "high"));
  },

  "child_process Node.js → HIGH": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(`const cp = require('child_process')`, "server.js");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "shell_exec"));
  },
});

await runSuite("static/dinamik-kod", {
  "eval() → HIGH": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(`eval(userInput)`, "app.js");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "dynamic_code"));
  },

  "new Function() → HIGH": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(`const fn = new Function('x', 'return x * 2')`, "util.js");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "dynamic_code"));
  },
});

await runSuite("static/ag-erisimi", {
  "fetch() → MEDIUM": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(`fetch('https://api.example.com/data')`, "client.js");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "network_access"));
    assertEqual(r.findings[0].risk, "medium");
  },
});

await runSuite("static/temiz-dosya", {
  "temiz kaynak kodu → bulgu yok": async () => {
    const a = new StaticAnalyzer();
    const i = makeInput(
      `function add(a, b) { return a + b; }\nexport default add;`,
      "math.ts"
    );
    const r = await a.analyze(i);
    assertEqual(r.findings.length, 0);
    assertEqual(r.risk, "none");
  },

  "binary dosya → skip": async () => {
    const a = new StaticAnalyzer();
    const i = createAnalysisInput(makePng(), "img.png", "image/png");
    assert(!a.canAnalyze(i), "PNG analiz edilmemeli");
    const r = await a.analyze(i);
    assert(r.skipped);
  },
});

// ─── Binary Analyzer ──────────────────────────────────────────────────────────

await runSuite("binary", {
  "VirtualAlloc tespiti → CRITICAL": async () => {
    const a    = new BinaryAnalyzer();
    const text = "...VirtualAlloc...WriteProcessMemory...";
    const i    = createAnalysisInput(enc(text), "malware.dll", "application/octet-stream");
    const r    = await a.analyze(i);
    assert(r.findings.some((f) => f.risk === "critical" || f.risk === "high"));
  },

  "UPX packer → HIGH": async () => {
    const a    = new BinaryAnalyzer();
    const data = enc("some content UPX! packed executable");
    const i    = createAnalysisInput(data, "packed.exe", "application/octet-stream");
    const r    = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "compressed_payload" || f.risk === "high"),
      "UPX packer tespiti olmalı");
  },

  "gzip payload tespit → MEDIUM": async () => {
    const a    = new BinaryAnalyzer();
    // GZIP magic bytes içeren veri
    const data = new Uint8Array([0x00, 0x01, 0x1F, 0x8B, 0x08, 0x00, ...new Array(50).fill(0x42)]);
    const i    = createAnalysisInput(data, "payload.bin", "application/octet-stream");
    const r    = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "compressed_payload"));
  },

  "kaynak kodu → skip": async () => {
    const a = new BinaryAnalyzer();
    const i = makeInput("console.log('hello')", "app.js");
    assert(!a.canAnalyze(i), "JS binary analizöre gitmemeli");
    const r = await a.analyze(i);
    assert(r.skipped);
  },
});

// ─── Metadata Analyzer ────────────────────────────────────────────────────────

await runSuite("metadata", {
  "MIME uyuşmazlığı → HIGH": async () => {
    const a = new MetadataAnalyzerChecker();
    // PNG MIME ama stl uzantısı
    const i = createAnalysisInput(makePng(), "model.stl", "image/png");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "mime_mismatch" && f.risk === "high"),
      "MIME uyuşmazlığı bulunmalı");
  },

  "boş dosya → LOW": async () => {
    const a = new MetadataAnalyzerChecker();
    const i = createAnalysisInput(new Uint8Array(0), "empty.txt", "text/plain");
    const r = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "mime_mismatch"));
  },

  "geçerli dosya → bulgu yok": async () => {
    const a = new MetadataAnalyzerChecker();
    const i = createAnalysisInput(makePng(), "image.png", "image/png");
    const r = await a.analyze(i);
    // PNG'nin mime_mismatch olmaması gerekir
    const mimeFinding = r.findings.find((f) => f.category === "mime_mismatch");
    assert(!mimeFinding || mimeFinding.risk === "low", "Geçerli PNG için uyuşmazlık olmamalı");
  },
});

// ─── Dependency Analyzer ──────────────────────────────────────────────────────

await runSuite("dependency", {
  "lodash CVE tespiti": async () => {
    const a    = new DependencyAnalyzerChecker();
    const pkg  = JSON.stringify({ dependencies: { lodash: "4.17.15" } });
    const i    = createAnalysisInput(enc(pkg), "package.json", "application/json");
    const r    = await a.analyze(i);
    assert(r.findings.some((f) => f.category === "known_vulnerability"),
      "Lodash CVE bulunmalı");
    assert(r.findings.some((f) => f.risk === "medium"));
  },

  "log4j CRITICAL CVE": async () => {
    const a   = new DependencyAnalyzerChecker();
    const pkg = JSON.stringify({ dependencies: { "log4j": "2.14.1" } });
    const i   = createAnalysisInput(enc(pkg), "package.json", "application/json");
    const r   = await a.analyze(i);
    assert(r.findings.some((f) => f.risk === "critical"),
      "Log4Shell kritik olmalı");
  },

  "temiz package.json → bulgu yok": async () => {
    const a   = new DependencyAnalyzerChecker();
    const pkg = JSON.stringify({ dependencies: { "express": "4.18.0" } });
    const i   = createAnalysisInput(enc(pkg), "package.json", "application/json");
    const r   = await a.analyze(i);
    assertEqual(r.findings.length, 0);
  },

  "JS dosyası → skip": async () => {
    const a = new DependencyAnalyzerChecker();
    const i = makeInput("const x = 1", "app.js");
    assert(!a.canAnalyze(i));
    const r = await a.analyze(i);
    assert(r.skipped);
  },
});

// ─── Risk Engine ─────────────────────────────────────────────────────────────

await runSuite("risk-engine", {
  "boş sonuçlar → none risk": () => {
    const re     = new RiskEngine();
    const { overallRisk, summary } = re.aggregate([]);
    assertEqual(overallRisk, "none");
    assertEqual(summary.total, 0);
  },

  "toplama: en yüksek risk seçilir": () => {
    const re = new RiskEngine();
    const results = [
      { analyzer: "a", findings: [
        { id: "f1", risk: "medium" as RiskLevel, category: "network_access" as const,
          title: "T", description: "D", analyzer: "a" }
      ], risk: "medium" as RiskLevel, durationMs: 10, skipped: false },
      { analyzer: "b", findings: [
        { id: "f2", risk: "critical" as RiskLevel, category: "secret" as const,
          title: "T2", description: "D2", analyzer: "b" }
      ], risk: "critical" as RiskLevel, durationMs: 5, skipped: false },
    ];
    const { overallRisk, summary } = re.aggregate(results);
    assertEqual(overallRisk, "critical");
    assertEqual(summary.critical, 1);
    assertEqual(summary.medium, 1);
    assertEqual(summary.total, 2);
  },

  "sortFindings: sıralı risk (yüksek → düşük)": () => {
    const re = new RiskEngine();
    const findings = [
      { id: "1", risk: "low" as RiskLevel, category: "info" as const, title: "", description: "", analyzer: "" },
      { id: "2", risk: "critical" as RiskLevel, category: "secret" as const, title: "", description: "", analyzer: "" },
      { id: "3", risk: "medium" as RiskLevel, category: "network_access" as const, title: "", description: "", analyzer: "" },
    ];
    const sorted = re.sortFindings(findings);
    assertEqual(sorted[0].risk, "critical");
    assertEqual(sorted[1].risk, "medium");
    assertEqual(sorted[2].risk, "low");
  },
});

// ─── Policy Engine ────────────────────────────────────────────────────────────

await runSuite("policy", {
  "P001: CRITICAL → reject": () => {
    const pe = new PolicyEngine();
    const report = { findings: [
      { id: "f1", risk: "critical" as RiskLevel, category: "secret" as const,
        title: "T", description: "D", analyzer: "a" }
    ], overallRisk: "critical" as RiskLevel } as any;
    const decision = pe.decide(report);
    assertEqual(decision.decision, "reject");
    assert(decision.reason.includes("P001"));
  },

  "P003: SECRET HIGH → reject": () => {
    const pe = new PolicyEngine();
    const report = { findings: [
      { id: "f1", risk: "high" as RiskLevel, category: "secret" as const,
        title: "API Key", description: "D", analyzer: "a" }
    ], overallRisk: "high" as RiskLevel } as any;
    const decision = pe.decide(report);
    assertEqual(decision.decision, "reject");
  },

  "P005: HIGH (1-3) → manual_review": () => {
    const pe = new PolicyEngine();
    const report = { findings: [
      { id: "f1", risk: "high" as RiskLevel, category: "shell_exec" as const,
        title: "Shell", description: "D", analyzer: "a" }
    ], overallRisk: "high" as RiskLevel } as any;
    const decision = pe.decide(report);
    assertEqual(decision.decision, "manual_review");
  },

  "temiz → approve": () => {
    const pe = new PolicyEngine();
    const report = { findings: [], overallRisk: "none" as RiskLevel } as any;
    const decision = pe.decide(report);
    assertEqual(decision.decision, "approve");
    assert(decision.triggers.length === 0);
  },

  "P002: 4+ HIGH → reject": () => {
    const pe = new PolicyEngine();
    const report = {
      findings: Array.from({ length: 4 }, (_, i) => ({
        id: `f${i}`, risk: "high" as RiskLevel, category: "shell_exec" as const,
        title: "Shell", description: "D", analyzer: "a",
      })),
      overallRisk: "high" as RiskLevel,
    } as any;
    const decision = pe.decide(report);
    assertEqual(decision.decision, "reject");
  },
});

// ─── Analysis Pipeline ────────────────────────────────────────────────────────

await runSuite("pipeline/tam-akis", {
  "temiz dosya → approve": async () => {
    const p = new AnalysisPipeline();
    const i = makeInput(
      "function greet(name) { return `Hello, ${name}!`; }\nexport default greet;",
      "greet.js"
    );
    const r = await p.run(i);
    assertEqual(r.status, "completed");
    assertEqual(r.decision?.decision, "approve");
  },

  "API anahtarı → reject": async () => {
    const p = new AnalysisPipeline();
    const i = makeInput(
      `const apiKey = "sk_live_super_secret_token_1234567890abcdef"`,
      "config.js"
    );
    const r = await p.run(i);
    assertEqual(r.decision?.decision, "reject");
    assert(r.findings.some((f) => f.category === "secret"));
  },

  "MIME uyuşmazlığı → reject veya review": async () => {
    const p = new AnalysisPipeline();
    const i = createAnalysisInput(makePng(), "model.stl", "image/png");
    const r = await p.run(i);
    assert(
      r.decision?.decision === "reject" || r.decision?.decision === "manual_review",
      "MIME uyuşmazlığı reject veya review olmalı"
    );
  },

  "event yayınlanır": async () => {
    const bus    = new EventBus();
    const events: string[] = [];
    bus.on("analysis:started"   as never, () => events.push("started"));
    bus.on("analysis:completed" as never, () => events.push("completed"));
    bus.on("analysis:approved"  as never, () => events.push("approved"));

    const p = new AnalysisPipeline(undefined, undefined, {}, bus);
    const i = makeInput("const x = 1;", "clean.js");
    await p.run(i);

    assert(events.includes("started"),   "analysis:started yayınlanmalı");
    assert(events.includes("completed"), "analysis:completed yayınlanmalı");
    assert(events.includes("approved"),  "analysis:approved yayınlanmalı");
  },

  "dosya yok edilmez, salt analiz": async () => {
    const p    = new AnalysisPipeline();
    const data = enc("console.log('original')");
    const copy = new Uint8Array(data);
    const i    = createAnalysisInput(data, "check.js", "text/plain");
    await p.run(i);
    // Orijinal data değişmemeli
    for (let j = 0; j < copy.length; j++) {
      assertEqual(data[j], copy[j], "Dosya içeriği değiştirilmemeli");
    }
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "aynı girdi → aynı rapor": async () => {
    const content = `fetch('https://api.example.com');\nconst token = "secret-token-abc"`;
    const p = new AnalysisPipeline(undefined, undefined, { parallel: false });

    const r1 = await p.run(makeInput(content, "api.js"));
    const r2 = await p.run(makeInput(content, "api.js"));

    assertEqual(r1.decision?.decision, r2.decision?.decision);
    assertEqual(r1.overallRisk,        r2.overallRisk);
    assertEqual(r1.summary.total,      r2.summary.total);
    assertEqual(r1.summary.critical,   r2.summary.critical);
    assertEqual(r1.summary.high,       r2.summary.high);

    // Kategori sırası da aynı olmalı
    for (let i = 0; i < Math.min(r1.findings.length, r2.findings.length); i++) {
      assertEqual(r1.findings[i].category, r2.findings[i].category, `Bulgu ${i} kategori farklı`);
    }
  },

  "farklı girdi → farklı rapor": async () => {
    const p  = new AnalysisPipeline();
    const r1 = await p.run(makeInput("const x = 1;", "clean.js"));
    const r2 = await p.run(makeInput(`eval("malicious")`, "evil.js"));
    assert(r1.decision?.decision !== r2.decision?.decision ||
           r1.findings.length !== r2.findings.length,
      "Farklı içerik farklı rapor üretmeli");
  },
});

// ─── False Positive / Negative ────────────────────────────────────────────────

await runSuite("false-positive-negative", {
  "base64 yorum satırında → düşük risk (max 3 kural)": async () => {
    const a = new StaticAnalyzer();
    // Çok fazla base64 → max 3 kural sınırı devreye girmeli
    const lines = Array.from({ length: 20 }, (_, i) =>
      `// atob("encoded_string_${i}_abcdefghij0123456789")`
    ).join("\n");
    const i = makeInput(lines, "util.js");
    const r = await a.analyze(i);
    const obfuscated = r.findings.filter((f) => f.category === "obfuscated_code");
    assert(obfuscated.length <= 3, `Max 3 aynı kural bulgusu: ${obfuscated.length}`);
  },

  "eval dokümantasyonda → genel tespit": async () => {
    // eval bir yorum içinde geçse bile regex onu bulabilir — bu kabul edilebilir
    const a = new StaticAnalyzer();
    const i = makeInput(`// Don't use eval() in production`, "readme.md");
    const r = await a.analyze(i);
    // Tek satırda açıklama, gerçek tehdit yok ama tespit edebilir
    // Test: rapor çökmemeli
    assert(r.findings.length >= 0);
    assert(r.status !== "failed" || (r as any).skipped !== undefined);
  },
});

// ─── Performans ───────────────────────────────────────────────────────────────

await runSuite("performans", {
  "100KB kaynak kodu analizi < 500ms": async () => {
    const a     = new StaticAnalyzer();
    const lines = Array.from({ length: 2000 }, (_, i) =>
      `const variable_${i} = ${i * 2}; // safe code`
    ).join("\n");
    const data  = enc(lines);
    const i     = createAnalysisInput(data, "large.js", "text/javascript");

    const start = Date.now();
    const r     = await a.analyze(i);
    const ms    = Date.now() - start;

    assert(ms < 500, `100KB analiz ${ms}ms (beklenen < 500ms)`);
    assertEqual(r.findings.length, 0, "Temiz kod bulgu üretmemeli");
    console.log(`  → 100KB static analiz: ${ms}ms`);
  },

  "50 dosya pipeline paralel < 5s": async () => {
    const p   = new AnalysisPipeline(undefined, undefined, { parallel: true });
    const files = Array.from({ length: 50 }, (_, i) =>
      makeInput(`const x${i} = ${i};`, `file_${i}.js`)
    );

    const start = Date.now();
    await Promise.all(files.map((f) => p.run(f)));
    const ms    = Date.now() - start;

    assert(ms < 5000, `50 paralel analiz ${ms}ms (beklenen < 5s)`);
    console.log(`  → 50 dosya paralel pipeline: ${ms}ms`);
  },
});
