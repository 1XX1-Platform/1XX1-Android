/**
 * 1XX1 Execution Budget Manager (EBM) — FAZ 9 Block 1
 *
 * Her plugin icin risk-weighted execution budget.
 * Risk yukselince budget duser — guvenlik garantisi.
 *
 * HIBRIT STRATEJI:
 *   Guvenlik  → hard ceiling (asla asilmaz)
 *   Performans → soft target (bütçe icerisinde maksimize edilir)
 *
 * "No new decision source rule" (FAZ 9):
 *   Bu modul PolicyEngine'e yeni signal saglar, bagımsız karar vermez.
 */

const BUDGET_WINDOW_MS  = 60_000;  // 1 dakika pencere
const BASE_QUOTA        = 100;     // base invokasyon/dakika
const MIN_QUOTA         = 5;       // guvenlik alt sinir (asla 0 olmaz)
const MAX_QUOTA         = 500;     // performans ust sinir

export type BudgetState = {
  pluginId:       string;
  quota:          number;     // izin verilen invokasyon/dakika
  used:           number;     // bu pencerede kullanilan
  windowStart:    number;
  riskScore:      number;     // 0-1 (PolicyEngine'den gelir)
  throttled:      boolean;
  budgetRemaining: number;
};

export class ExecutionBudgetManager {
  private budgets = new Map<string, BudgetState>();

  /** Budget olustur veya guncelle */
  setBudget(pluginId: string, riskScore: number): BudgetState {
    this._resetWindowIfNeeded(pluginId);
    const b = this.budgets.get(pluginId) ?? this._defaultBudget(pluginId);

    // Risk-weighted quota:
    //   riskScore=0   → MAX_QUOTA (tam performans)
    //   riskScore=0.5 → BASE_QUOTA
    //   riskScore=1   → MIN_QUOTA (guvenlik tabani)
    const rawQuota = BASE_QUOTA * (1 - riskScore) + MIN_QUOTA;
    b.quota     = Math.max(MIN_QUOTA, Math.min(MAX_QUOTA, Math.round(rawQuota)));
    b.riskScore = riskScore;
    b.budgetRemaining = Math.max(0, b.quota - b.used);
    b.throttled = b.budgetRemaining <= 0;

    this.budgets.set(pluginId, b);
    return b;
  }

  /** Invokasyon oncesi kontrol — izin var mi? */
  canInvoke(pluginId: string): boolean {
    this._resetWindowIfNeeded(pluginId);
    const b = this.budgets.get(pluginId);
    if (!b) return true; // Budget tanimlanmamissa izin ver
    return b.used < b.quota;
  }

  /** Invokasyon gerceklesti — sayaci artir */
  consume(pluginId: string): void {
    this._resetWindowIfNeeded(pluginId);
    const b = this.budgets.get(pluginId) ?? this._defaultBudget(pluginId);
    b.used++;
    b.budgetRemaining = Math.max(0, b.quota - b.used);
    b.throttled = b.budgetRemaining <= 0;
    this.budgets.set(pluginId, b);
  }

  get(pluginId: string): BudgetState | null {
    return this.budgets.get(pluginId) ?? null;
  }

  utilizationRate(pluginId: string): number {
    const b = this.budgets.get(pluginId);
    if (!b || b.quota === 0) return 0;
    return b.used / b.quota;
  }

  allBudgets(): BudgetState[] { return [...this.budgets.values()]; }

  private _defaultBudget(pluginId: string): BudgetState {
    const b: BudgetState = {
      pluginId, quota: BASE_QUOTA, used: 0,
      windowStart: Date.now(), riskScore: 0,
      throttled: false, budgetRemaining: BASE_QUOTA,
    };
    this.budgets.set(pluginId, b);
    return b;
  }

  private _resetWindowIfNeeded(pluginId: string): void {
    const b = this.budgets.get(pluginId);
    if (!b) return;
    if (Date.now() - b.windowStart >= BUDGET_WINDOW_MS) {
      b.used        = 0;
      b.windowStart = Date.now();
      b.budgetRemaining = b.quota;
      b.throttled   = false;
    }
  }
}
