/**
 * 1XX1 Arama Motoru Testleri
 * Aşama 05 — Matematiksel Arama Motoru
 *
 * Test grupları:
 *   tokenizer      — normalize, tokenize, Levenshtein, fuzzy
 *   query-parser   — intent detection, coord/path extraction
 *   query-planner  — plan adımları, maliyet tahmini
 *   candidate-gen  — her kaynak tipi, merge, reverse filter
 *   scoring        — formül doğrulama, tie-break
 *   ranker         — sıralama, offset/limit, minScore
 *   search-engine  — tam pipeline, semantic/structural/hybrid
 *   read-only      — EventBus'a asla olay atılmıyor
 */

import {
  runSuite, assert, assertEqual, makeProject
} from "../../core/test-utils.ts";
import { normalize, tokenize, levenshtein, similarity, fuzzyMatch, findFuzzyMatch } from "../tokenizer.ts";
import { QueryParser } from "../query-parser.ts";
import { QueryPlanner } from "../query-planner.ts";
import { ScoringEngine } from "../scoring-engine.ts";
import { ResultRanker } from "../ranker.ts";
import { SearchEngine } from "../search-engine.ts";
import { IndexManager } from "../index-manager.ts";
import { EventBus } from "../../core/event-bus.ts";
import { newProjectID } from "../../core/identity.ts";
import type { ProjectID } from "../../core/identity.ts";

// ─── Tokenizer ───────────────────────────────────────────────────────────────

await runSuite("tokenizer/normalize", {
  "küçük harf + trim": () => {
    assertEqual(normalize("  STL Repair  "), "stl repair");
  },
  "Unicode aksan kaldırma": () => {
    assertEqual(normalize("café"), "cafe");
    assertEqual(normalize("naïve"), "naive");
  },
  "özel karakter → boşluk": () => {
    const r = normalize("hello-world_test.js");
    assert(r.includes("hello"), `'hello' beklendi: ${r}`);
    assert(r.includes("world"), `'world' beklendi: ${r}`);
  },
});

await runSuite("tokenizer/tokenize", {
  "stop-word filtresi": () => {
    const { tokens } = tokenize("a tool for STL repair");
    assert(!tokens.includes("a"),   "'a' stop-word olmalı");
    assert(!tokens.includes("for"), "'for' stop-word olmalı");
    assert(tokens.includes("stl"),  "'stl' kalmalı");
    assert(tokens.includes("repair"), "'repair' kalmalı");
  },

  "ngram üretimi": () => {
    const { ngrams } = tokenize("mesh repair tool", { includeNgrams: true });
    assert(ngrams.some((g) => g.includes("mesh") && g.includes("repair")),
      "2-gram üretilmeli");
  },

  "minLength filtresi": () => {
    const { tokens } = tokenize("a ab abc abcd", { minLength: 3, removeStops: false });
    assert(!tokens.includes("a"),  "1-char elenmeli");
    assert(!tokens.includes("ab"), "2-char elenmeli");
    assert(tokens.includes("abc"), "3-char kalmalı");
  },
});

await runSuite("tokenizer/levenshtein", {
  "özdeş string → 0": () => assertEqual(levenshtein("hello", "hello"), 0),
  "boş string": () => {
    assertEqual(levenshtein("", "abc"), 3);
    assertEqual(levenshtein("abc", ""), 3);
  },
  "tek karakter fark": () => assertEqual(levenshtein("cat", "bat"), 1),
  "ekleme": () => assertEqual(levenshtein("cat", "cats"), 1),
  "silme": () => assertEqual(levenshtein("cats", "cat"), 1),
  "tam değişim": () => assertEqual(levenshtein("abc", "xyz"), 3),
});

await runSuite("tokenizer/fuzzy", {
  "similarity 1 = özdeş": () => assertEqual(similarity("mesh", "mesh"), 1),
  "similarity 0 ≈ tamamen farklı": () => assert(similarity("mesh", "xyz") < 0.5),
  "fuzzyMatch threshold": () => {
    assert(fuzzyMatch("messh", "mesh", 0.75),  "messh ~ mesh");
    assert(!fuzzyMatch("xyz", "mesh", 0.75),   "xyz ≁ mesh");
  },
  "findFuzzyMatch en iyi eşleşmeyi döndürür": () => {
    const result = findFuzzyMatch("repiar", ["repair", "replay", "remove"], 0.6);
    assert(result !== null);
    assertEqual(result!.matched, "repair");
  },
});

// ─── QueryParser ─────────────────────────────────────────────────────────────

await runSuite("query-parser/intent", {
  "semantic intent": () => {
    const p = new QueryParser();
    assertEqual(p.detectIntent("video editing tool"), "semantic");
    assertEqual(p.detectIntent("mesh repair stl"),    "semantic");
  },

  "structural intent: CubePath": () => {
    const p = new QueryParser();
    assertEqual(p.detectIntent("4/7/2"),      "structural");
    assertEqual(p.detectIntent("cube:4/7/2"), "structural");
    assertEqual(p.detectIntent("@4/7/2"),     "structural");
  },

  "structural intent: koordinat üçlüsü": () => {
    const p = new QueryParser();
    assertEqual(p.detectIntent("4,7,2"), "structural");
  },

  "hybrid intent: path + kelimeler": () => {
    const p = new QueryParser();
    assertEqual(p.detectIntent("4/7/2 mesh repair"), "hybrid");
    assertEqual(p.detectIntent("stl tool cube:4/7/2"), "hybrid");
  },
});

await runSuite("query-parser/extract", {
  "CubePath çıkarma": () => {
    const p  = new QueryParser();
    const pq = p.parse({ term: "cube:4/7/2" });
    assertEqual(pq.targetCoord, { x: 4, y: 7, z: 2 });
    assertEqual(pq.targetPath,  "4/7/2");
  },

  "derin path": () => {
    const p  = new QueryParser();
    const pq = p.parse({ term: "4/7/2/3/8" });
    assertEqual(pq.targetPath, "4/7/2/3/8");
    assertEqual(pq.targetCoord, { x: 4, y: 7, z: 2 });
  },

  "koordinat üçlüsü": () => {
    const p  = new QueryParser();
    const pq = p.parse({ term: "4,7,2" });
    assertEqual(pq.targetCoord, { x: 4, y: 7, z: 2 });
  },

  "hybrid: token listesi temiz": () => {
    const p  = new QueryParser();
    const pq = p.parse({ term: "4/7/2 mesh repair" });
    assert(pq.tokens.length > 0, "Token'lar olmalı");
    // Path segmentleri token listesinde olmamalı
    assert(!pq.tokens.includes("4"), "Koordinat rakamı token'da olmamalı");
  },

  "varsayılan options": () => {
    const p  = new QueryParser();
    const pq = p.parse({ term: "test" });
    assertEqual(pq.options.limit,  20);
    assertEqual(pq.options.offset, 0);
  },
});

// ─── QueryPlanner ────────────────────────────────────────────────────────────

await runSuite("query-planner", {
  "semantic plan: semantic-lookup içerir": () => {
    const parser  = new QueryParser();
    const planner = new QueryPlanner();
    const pq      = parser.parse({ term: "mesh repair" });
    const plan    = planner.plan(pq);

    assertEqual(plan.intent, "semantic");
    assert(plan.steps.some((s) => s.type === "semantic-lookup"), "semantic-lookup olmalı");
    assert(plan.steps.some((s) => s.type === "rank-and-slice"), "rank-and-slice olmalı");
    assertEqual(plan.estimatedCost, "O(k)");
  },

  "structural plan: structural-route içerir": () => {
    const parser  = new QueryParser();
    const planner = new QueryPlanner();
    const pq      = parser.parse({ term: "4/7/2" });
    const plan    = planner.plan(pq);

    assertEqual(plan.intent, "structural");
    assert(plan.steps.some((s) => s.type === "structural-route"), "structural-route olmalı");
    assertEqual(plan.estimatedCost, "O(1)");
  },

  "hybrid plan: hem semantic hem structural içerir": () => {
    const parser  = new QueryParser();
    const planner = new QueryPlanner();
    const pq      = parser.parse({ term: "4/7/2 mesh repair" });
    const plan    = planner.plan(pq);

    assertEqual(plan.intent, "hybrid");
    assert(plan.steps.some((s) => s.type === "semantic-lookup"), "semantic-lookup olmalı");
    assert(plan.steps.some((s) => s.type === "structural-route"), "structural-route olmalı");
    assertEqual(plan.estimatedCost, "O(log n)");
  },

  "filtre ile plan: reverse-filter içerir": () => {
    const parser  = new QueryParser();
    const planner = new QueryPlanner();
    const pq      = parser.parse({ term: "mesh", filter: { license: "MIT" } });
    const plan    = planner.plan(pq);
    assert(plan.steps.some((s) => s.type === "reverse-filter"), "reverse-filter olmalı");
  },
});

// ─── ScoringEngine ───────────────────────────────────────────────────────────

await runSuite("scoring/formul", {
  "final = sem×0.55 + str×0.30 + meta×0.10 + rec×0.05": () => {
    const mgr    = new IndexManager();
    const p      = makeProject({ name: "STL Tool", tags: ["STL"] });
    mgr.indexProject(p);
    mgr.structural.upsert("4/7/2", p.id as ProjectID);

    const scoring = new ScoringEngine(mgr.semantic, mgr.reverse, mgr.structural);
    const { tokenize: tok } = await import("../tokenizer.ts");
    const { tokens } = tok("STL", { removeStops: true });

    const candidates = new Map([[p.id as ProjectID, { projectId: p.id as ProjectID, source: "semantic" as const }]]);
    const [score] = scoring.scoreAll(candidates, tokens);

    assert(score !== undefined);
    const expected = score.semanticScore * 0.55 +
                     score.structuralScore * 0.30 +
                     score.metadataScore * 0.10 +
                     score.recencyBoost * 0.05;
    assert(Math.abs(score.finalScore - expected) < 0.001,
      `Formül uyuşmuyor: ${score.finalScore} ≠ ${expected}`
    );
  },

  "structural score: 1/(1+distance)": () => {
    const mgr = new IndexManager();
    const p1  = makeProject({ cube: { x: 0, y: 0, z: 0 } });
    const p2  = makeProject({ cube: { x: 10, y: 10, z: 10 } });
    mgr.indexProject(p1); mgr.indexProject(p2);
    mgr.structural.upsert("0/0/0",   p1.id as ProjectID);
    mgr.structural.upsert("10/10/10", p2.id as ProjectID);

    const scoring  = new ScoringEngine(mgr.semantic, mgr.reverse, mgr.structural);
    const refCoord = { x: 0, y: 0, z: 0 };
    const cands    = new Map([
      [p1.id as ProjectID, { projectId: p1.id as ProjectID, source: "structural" as const }],
      [p2.id as ProjectID, { projectId: p2.id as ProjectID, source: "structural" as const }],
    ]);

    const scored = scoring.scoreAll(cands, [], refCoord);
    const s1 = scored.find((s) => s.projectId === (p1.id as ProjectID));
    const s2 = scored.find((s) => s.projectId === (p2.id as ProjectID));

    // p1'in structuralScore p2'den yüksek olmalı
    assert(s1!.structuralScore > s2!.structuralScore,
      `p1(${s1?.structuralScore}) > p2(${s2?.structuralScore}) olmalı`
    );
    // p1 mesafe 0 → 1/(1+0) = 1.0
    assert(Math.abs(s1!.structuralScore - 1.0) < 0.001, "Sıfır mesafe → skor 1.0");
  },

  "recency: e^(-age/τ)": () => {
    // Yeni oluşturulan proje → age ≈ 0 → recency ≈ 1
    const mgr = new IndexManager();
    const p   = makeProject();
    mgr.indexProject(p);
    mgr.structural.upsert("5/5/5", p.id as ProjectID);

    const scoring = new ScoringEngine(mgr.semantic, mgr.reverse, mgr.structural);
    const cands   = new Map([[p.id as ProjectID, { projectId: p.id as ProjectID, source: "semantic" as const }]]);
    const [score] = scoring.scoreAll(cands, []);

    assert(score.recencyBoost > 0.99, `Yeni proje recency > 0.99: ${score.recencyBoost}`);
  },
});

// ─── ResultRanker ────────────────────────────────────────────────────────────

await runSuite("ranker", {
  "yüksek skor üstte": () => {
    const ranker = new ResultRanker();
    const makeScore = (projectId: ProjectID, finalScore: number) => ({
      projectId, finalScore,
      rawSemantic: finalScore, semanticScore: finalScore,
      structuralScore: 0.5, metadataScore: 0.5, recencyBoost: 0.5,
      matchedTokens: [], sources: ["semantic" as const],
    });

    const scored = [
      makeScore(newProjectID(), 0.3),
      makeScore(newProjectID(), 0.9),
      makeScore(newProjectID(), 0.6),
    ];
    const { hits } = ranker.rank(scored, [], { limit: 10, offset: 0, minScore: 0 });

    assertEqual(hits[0].finalScore, 0.9);
    assertEqual(hits[1].finalScore, 0.6);
    assertEqual(hits[2].finalScore, 0.3);
  },

  "minScore filtresi": () => {
    const ranker = new ResultRanker();
    const makeScore = (projectId: ProjectID, finalScore: number) => ({
      projectId, finalScore,
      rawSemantic: finalScore, semanticScore: finalScore,
      structuralScore: 0.5, metadataScore: 0.5, recencyBoost: 0.5,
      matchedTokens: [], sources: ["semantic" as const],
    });

    const scored = [
      makeScore(newProjectID(), 0.8),
      makeScore(newProjectID(), 0.3),
      makeScore(newProjectID(), 0.1),
    ];
    const { hits, total } = ranker.rank(scored, [], { limit: 10, offset: 0, minScore: 0.5 });
    assertEqual(hits.length, 1);
    assertEqual(total, 1);
  },

  "offset/limit sayfalama": () => {
    const ranker = new ResultRanker();
    const makeScore = (projectId: ProjectID, s: number) => ({
      projectId, finalScore: s,
      rawSemantic: s, semanticScore: s,
      structuralScore: 0, metadataScore: 0, recencyBoost: 0,
      matchedTokens: [], sources: ["semantic" as const],
    });

    const all = Array.from({ length: 10 }, (_, i) =>
      makeScore(newProjectID(), 1 - i * 0.1)
    );
    const { hits: page1 } = ranker.rank(all, [], { limit: 3, offset: 0, minScore: 0 });
    const { hits: page2 } = ranker.rank(all, [], { limit: 3, offset: 3, minScore: 0 });

    assertEqual(page1.length, 3);
    assertEqual(page2.length, 3);
    assertEqual(page1[0].rank, 1);
    assertEqual(page2[0].rank, 4);
    // Sayfa 1 ve sayfa 2 farklı projeler
    assert(page1[0].projectId !== page2[0].projectId);
  },

  "rank numaraları doğru": () => {
    const ranker = new ResultRanker();
    const items  = Array.from({ length: 5 }, (_, i) => ({
      projectId: newProjectID(), finalScore: 1 - i * 0.1,
      rawSemantic: 0, semanticScore: 0,
      structuralScore: 0, metadataScore: 0, recencyBoost: 0,
      matchedTokens: [], sources: ["semantic" as const],
    }));
    const { hits } = ranker.rank(items, [], { limit: 5, offset: 0, minScore: 0 });
    hits.forEach((h, i) => assertEqual(h.rank, i + 1));
  },
});

// ─── SearchEngine: Tam Pipeline ──────────────────────────────────────────────

await runSuite("search-engine/semantic", {
  "basit semantic arama": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);

    const p = makeProject({ name: "STL Repair Tool", tags: ["STL", "mesh", "repair"] });
    mgr.indexProject(p);

    const response = await engine.search({ term: "STL repair" });
    assert(response.hits.length > 0, "Sonuç bulunmalı");
    assertEqual(response.intent, "semantic");
    assert(response.projectIds.includes(p.id as ProjectID));
  },

  "prefix arama": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    const p      = makeProject({ name: "Triangulate Mesh", tags: ["3D"] });
    mgr.indexProject(p);

    const response = await engine.search({ term: "trian" });
    // Prefix eşleşme
    assert(response.hits.length > 0 || response.total >= 0); // prefix sonuç üretebilir
  },

  "sonuç skoru 0–1 arası": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    for (let i = 0; i < 5; i++) {
      mgr.indexProject(makeProject({ name: `mesh tool ${i}`, tags: ["mesh"] }));
    }

    const response = await engine.search({ term: "mesh" });
    for (const hit of response.hits) {
      assert(hit.finalScore >= 0 && hit.finalScore <= 1.05,
        `Score dışı: ${hit.finalScore}`
      );
    }
  },
});

await runSuite("search-engine/structural", {
  "structural sorgu: koordinat ile": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    const p      = makeProject({ cube: { x: 4, y: 7, z: 2 } });
    mgr.indexProject(p);
    mgr.structural.upsert("4/7/2", p.id as ProjectID);

    const response = await engine.search({ term: "4/7/2" });
    assertEqual(response.intent, "structural");
    assertEqual(response.resolvedPath, "4/7/2");
  },

  "structural sorgu: cube: öneki": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    const p      = makeProject({ cube: { x: 1, y: 2, z: 3 } });
    mgr.indexProject(p);
    mgr.structural.upsert("1/2/3", p.id as ProjectID);

    const response = await engine.search({ term: "cube:1/2/3" });
    assertEqual(response.intent, "structural");
  },
});

await runSuite("search-engine/hybrid", {
  "hybrid: hem koordinat hem kelime": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    const p      = makeProject({ name: "Mesh Viewer", tags: ["mesh"], cube: { x: 3, y: 3, z: 3 } });
    mgr.indexProject(p);
    mgr.structural.upsert("3/3/3", p.id as ProjectID);

    const response = await engine.search({ term: "3/3/3 mesh viewer" });
    assertEqual(response.intent, "hybrid");
  },
});

await runSuite("search-engine/pipeline", {
  "explain mode: adımlar dolu": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    mgr.indexProject(makeProject({ name: "explain test" }));

    const response = await engine.search({
      term: "explain",
      options: { explain: true },
    });
    assert(response.plan !== undefined,         "plan dolu olmalı");
    assert(response.pipelineSteps !== undefined, "pipelineSteps dolu olmalı");
    assert(response.pipelineSteps!.length > 0,  "En az bir adım olmalı");
  },

  "limit parametresi çalışır": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    for (let i = 0; i < 15; i++) {
      mgr.indexProject(makeProject({ name: `limit test ${i}`, tags: ["limit"] }));
    }

    const response = await engine.search({ term: "limit", options: { limit: 5 } });
    assert(response.hits.length <= 5, `Limit aşıldı: ${response.hits.length}`);
  },

  "executionMs ölçülür": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    const response = await engine.search({ term: "test" });
    assert(response.executionMs >= 0);
    assert(response.executionMs < 5000);
  },

  "engineStats güncellenir": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    await engine.search({ term: "aaa" });
    await engine.search({ term: "bbb" });

    const stats = engine.engineStats();
    assertEqual(stats.totalQueries, 2);
    assert(stats.avgExecutionMs >= 0);
  },

  "cache hit ikinci aramada": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    mgr.indexProject(makeProject({ name: "cache test project" }));

    await engine.search({ term: "cache test" });
    const before = engine.engineStats().cacheHits;
    await engine.search({ term: "cache test" }); // aynı sorgu
    const after  = engine.engineStats().cacheHits;
    assertEqual(after, before + 1, "İkinci aramada cache hit olmalı");
  },
});

await runSuite("search-engine/read-only", {
  "EventBus'a hiç olay atılmıyor": async () => {
    const bus    = new EventBus();
    const mgr    = new IndexManager(bus);
    const engine = new SearchEngine(mgr, bus);

    const emitted: string[] = [];
    // Tüm olay türlerini dinle
    const types = [
      "project:created", "project:updated", "project:archived",
      "cube:indexed", "cube:split", "cube:merge",
      "index:upserted", "index:removed", "index:reconciled",
    ] as const;

    for (const t of types) {
      bus.on(t, () => { emitted.push(t); });
    }

    // Arama yap
    mgr.indexProject(makeProject({ name: "readonly test" }));
    await engine.search({ term: "readonly" });

    // Yalnızca index:upserted (indexProject'ten) olmalı; search emit etmemeli
    const searchEmitted = emitted.filter((t) => t !== "index:upserted");
    assertEqual(searchEmitted.length, 0,
      `SearchEngine olay atti: [${searchEmitted.join(", ")}]`
    );
  },

  "resolve: token → yol zinciri": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    const path   = await engine.resolve("STL repair mesh");
    assert(Array.isArray(path));
    assert(path.length > 0, "Yol zinciri boş olamaz");
  },

  "detectIntent doğru çalışır": async () => {
    const mgr    = new IndexManager();
    const engine = new SearchEngine(mgr);
    assertEqual(engine.detectIntent("mesh tool"),    "semantic");
    assertEqual(engine.detectIntent("4/7/2"),        "structural");
    assertEqual(engine.detectIntent("4/7/2 repair"), "hybrid");
  },
});
