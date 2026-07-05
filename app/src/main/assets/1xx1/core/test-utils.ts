/**
 * 1XX1 Test Altyapısı — Standartlar ve Yardımcılar
 * Aşama 01 — Çekirdek Mimari (Ek: Test)
 *
 * Test felsefesi:
 * - Her modülün kendi __tests__/ klasörü vardır
 * - Dış bağımlılık yok (test framework'ü sıfırdan)
 * - In-memory implementasyonlar gerçek veritabanı yerine kullanılır
 * - Her test izole çalışır (side-effect bırakmaz)
 *
 * Çalıştırma:
 *   Deno:  deno test
 *   Node:  node --experimental-vm-modules tests/run.js
 *   Bun:   bun test
 */

import type { CubeCoordinate } from "./types.ts";
import type { Project, Developer } from "./types.ts";
import { newProjectID, newDeveloperID, cubeIDFromCoord } from "./identity.ts";

// ─── Basit Test Koşucusu ─────────────────────────────────────────────────────

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface TestSuite {
  name: string;
  results: TestResult[];
  passed: number;
  failed: number;
  totalMs: number;
}

export async function runSuite(
  suiteName: string,
  tests: Record<string, () => void | Promise<void>>
): Promise<TestSuite> {
  const results: TestResult[] = [];

  for (const [name, fn] of Object.entries(tests)) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, durationMs: Date.now() - start });
    } catch (err) {
      results.push({
        name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  // Konsol raporu
  console.log(`\n── ${suiteName} ──`);
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    const time = `${r.durationMs}ms`;
    if (r.passed) {
      console.log(`  ${icon} ${r.name} (${time})`);
    } else {
      console.log(`  ${icon} ${r.name} (${time})\n    → ${r.error}`);
    }
  }
  console.log(`  ${passed}/${results.length} geçti — ${totalMs}ms toplam\n`);

  return { name: suiteName, results, passed, failed, totalMs };
}

// ─── Assertion Yardımcıları ───────────────────────────────────────────────────

export function assert(condition: boolean, message?: string): void {
  if (!condition) throw new Error(message ?? "Assertion başarısız");
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(message ?? `Beklenen: ${e}\nAlınan:   ${a}`);
  }
}

export function assertThrows(fn: () => unknown, expectedCode?: string): void {
  try {
    fn();
    throw new Error("Hata fırlatılması bekleniyordu ama fırlatılmadı");
  } catch (err) {
    if (expectedCode && err instanceof Error) {
      const hasCode = "code" in err && (err as { code: string }).code === expectedCode;
      if (!hasCode) {
        throw new Error(`Hata kodu "${expectedCode}" beklendi, alınan: ${JSON.stringify((err as { code?: string }).code)}`);
      }
    }
  }
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  expectedCode?: string
): Promise<void> {
  try {
    await fn();
    throw new Error("Hata fırlatılması bekleniyordu ama fırlatılmadı");
  } catch (err) {
    if (expectedCode && err instanceof Error) {
      const hasCode = "code" in err && (err as { code: string }).code === expectedCode;
      if (!hasCode) {
        throw new Error(`Hata kodu "${expectedCode}" beklendi, alınan: ${JSON.stringify((err as { code?: string }).code)}`);
      }
    }
  }
}

// ─── Test Fabrikaları (Fixture Builders) ─────────────────────────────────────

export function makeProject(overrides: Partial<Project> = {}): Project {
  const coord: CubeCoordinate = overrides.cube ?? { x: 4, y: 7, z: 2 };
  return {
    id:          newProjectID(),
    name:        "Test Projesi",
    description: "Otomatik test için oluşturuldu",
    cube:        coord,
    developer:   newDeveloperID(),
    repo:        "https://github.com/test/repo",
    tags:        ["test"],
    license:     "MIT",
    status:      "active",
    createdAt:   new Date(),
    updatedAt:   new Date(),
    ...overrides,
  };
}

export function makeDeveloper(overrides: Partial<Developer> = {}): Developer {
  return {
    id:          newDeveloperID(),
    username:    "test_dev",
    displayName: "Test Geliştirici",
    joinedAt:    new Date(),
    ...overrides,
  };
}

export function makeCoord(x: number, y: number, z: number): CubeCoordinate {
  return { x, y, z };
}
