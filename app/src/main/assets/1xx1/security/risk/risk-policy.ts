/**
 * 1XX1 Risk Engine + Policy Engine
 * Aşama 12 — Security Analysis Engine
 *
 * Risk Engine: tüm analizör çıktılarını toplar, ağırlıklandırır
 * Policy Engine: risk raporunu değerlendirir, karar verir
 *
 * Karar hiyerarşisi:
 *   CRITICAL bulgu → reject (istisna yok)
 *   HIGH bulgu × N → reject veya manual_review
 *   MEDIUM/LOW → approve veya manual_review
 *
 * Policy Engine karar verir; analizörler vermez.
 */

import type {
  AnalyzerResult, SecurityReport, Finding,
  RiskLevel, PolicyDecision, PolicyDecisionType,
} from "../security-types.ts";
import { maxRisk, RISK_PRIORITY } from "../security-types.ts";

// ─── Risk Engine ──────────────────────────────────────────────────────────────

export class RiskEngine {

  /**
   * Tüm analizör sonuçlarını topla ve rapor istatistiklerini hesapla.
   */
  aggregate(results: AnalyzerResult[]): {
    findings:    Finding[];
    overallRisk: RiskLevel;
    summary:     SecurityReport["summary"];
  } {
    const allFindings = results.flatMap((r) => r.findings);

    const summary: SecurityReport["summary"] = {
      total:    allFindings.length,
      critical: 0, high: 0, medium: 0, low: 0, info: 0,
    };

    let overallRisk: RiskLevel = "none";

    for (const f of allFindings) {
      overallRisk = maxRisk(overallRisk, f.risk);
      if      (f.risk === "critical") summary.critical++;
      else if (f.risk === "high")     summary.high++;
      else if (f.risk === "medium")   summary.medium++;
      else if (f.risk === "low")      summary.low++;
      else                             summary.info++;
    }

    return { findings: allFindings, overallRisk, summary };
  }

  /**
   * Bulguları risk seviyesine göre sırala (yüksek → düşük).
   */
  sortFindings(findings: Finding[]): Finding[] {
    return [...findings].sort(
      (a, b) => RISK_PRIORITY[b.risk] - RISK_PRIORITY[a.risk]
    );
  }
}

// ─── Policy Kuralları ────────────────────────────────────────────────────────

export interface PolicyRule {
  id:       string;
  /** Bu kural tetiklenirse hangi karar? */
  decision: PolicyDecisionType;
  /** Kural açıklaması */
  reason:   string;
  /** Kuralı değerlendir */
  evaluate: (report: Omit<SecurityReport, "decision">) => Finding[] | null;
}

/** Varsayılan policy kuralları */
const DEFAULT_POLICY_RULES: PolicyRule[] = [
  // P001: Herhangi bir CRITICAL bulgu → kesin reddetme
  {
    id: "P001", decision: "reject",
    reason: "Kritik güvenlik bulgusu tespit edildi",
    evaluate: (r) => {
      const hits = r.findings.filter((f) => f.risk === "critical");
      return hits.length > 0 ? hits : null;
    },
  },

  // P002: 3'ten fazla HIGH bulgu → reddetme
  {
    id: "P002", decision: "reject",
    reason: "Birden fazla yüksek risk bulgusu",
    evaluate: (r) => {
      const hits = r.findings.filter((f) => f.risk === "high");
      return hits.length > 3 ? hits : null;
    },
  },

  // P003: SECRET kategorisinde herhangi bir HIGH veya CRITICAL → reddetme
  {
    id: "P003", decision: "reject",
    reason: "Kaynak kodunda gizli bilgi (API anahtarı / şifre) bulundu",
    evaluate: (r) => {
      const hits = r.findings.filter(
        (f) => f.category === "secret" && (f.risk === "high" || f.risk === "critical")
      );
      return hits.length > 0 ? hits : null;
    },
  },

  // P004: MIME uyuşmazlığı HIGH → reddetme (içerik hilesi)
  {
    id: "P004", decision: "reject",
    reason: "Dosya içeriği ilan edilen formatla uyuşmuyor",
    evaluate: (r) => {
      const hits = r.findings.filter(
        (f) => f.category === "mime_mismatch" && f.risk === "high"
      );
      return hits.length > 0 ? hits : null;
    },
  },

  // P005: 1–3 HIGH bulgu → incelemeye al
  {
    id: "P005", decision: "manual_review",
    reason: "Yüksek risk bulguları manuel inceleme gerektiriyor",
    evaluate: (r) => {
      const hits = r.findings.filter((f) => f.risk === "high");
      return hits.length > 0 && hits.length <= 3 ? hits : null;
    },
  },

  // P006: Shell exec MEDIUM → incelemeye al
  {
    id: "P006", decision: "manual_review",
    reason: "Kod sistem komutları çalıştırıyor",
    evaluate: (r) => {
      const hits = r.findings.filter(
        (f) => f.category === "shell_exec" && f.risk === "medium"
      );
      return hits.length > 0 ? hits : null;
    },
  },
];

// ─── Policy Engine ────────────────────────────────────────────────────────────

export class PolicyEngine {

  constructor(rules: PolicyRule[] = DEFAULT_POLICY_RULES) {
    this.rules = rules;}

  /**
   * Raporu değerlendir ve karar üret.
   * Kurallar öncelik sırasıyla değerlendirilir (reject > manual_review > approve).
   * İlk tetiklenen reject kuralı son kararı belirler.
   */
  decide(report: Omit<SecurityReport, "decision">): PolicyDecision {
    const now = new Date();

    // Önce tüm reject kurallarını değerlendir
    for (const rule of this.rules.filter((r) => r.decision === "reject")) {
      const triggered = rule.evaluate(report);
      if (triggered) {
        return {
          decision:  "reject",
          reason:    `[${rule.id}] ${rule.reason}`,
          triggers:  triggered.map((f) => f.id),
          decidedAt: now,
          decidedBy: "policy_engine",
        };
      }
    }

    // Sonra manual_review kurallarını değerlendir
    for (const rule of this.rules.filter((r) => r.decision === "manual_review")) {
      const triggered = rule.evaluate(report);
      if (triggered) {
        return {
          decision:  "manual_review",
          reason:    `[${rule.id}] ${rule.reason}`,
          triggers:  triggered.map((f) => f.id),
          decidedAt: now,
          decidedBy: "policy_engine",
        };
      }
    }

    // Hiçbir kural tetiklenmediyse → onayla
    return {
      decision:  "approve",
      reason:    "Tüm güvenlik kontrolleri geçildi",
      triggers:  [],
      decidedAt: now,
      decidedBy: "policy_engine",
    };
  }

  /**
   * Özel kural ekle (test veya genişletme için).
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }
}
