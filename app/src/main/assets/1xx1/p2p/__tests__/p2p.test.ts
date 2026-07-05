/**
 * 1XX1 P2P Asset Transfer Testleri
 * Aşama 16
 *
 * Gruplar:
 *   content-addresser — CID üretimi, chunking, chunk doğrulama, birleştirme
 *   chunk-store       — put/get, isComplete, assemble, delete
 *   content-registry  — announce, providers, prune, peer temizleme
 *   p2p-transport     — send/receive, partition, latency
 *   transfer-engine   — tam indirme, paralel chunk, hash doğrulama, retry
 *   determinism       — aynı içerik → aynı CID (her zaman)
 *   performans        — 10MB dosya, 100 chunk paralel
 */

import {
  runSuite, assert, assertEqual
} from "../../core/test-utils.ts";
import { ContentAddresser, CHUNK_SIZE } from "../content/content-addresser.ts";
import { InMemoryChunkStore, ContentRegistry } from "../content/chunk-store.ts";
import { MemoryP2PTransport } from "../transport/p2p-transport.ts";
import { TransferEngine } from "../transfer/transfer-engine.ts";
import type { ContentId, ContentAddress, ChunkDescriptor } from "../p2p-types.ts";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

async function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeData(size: number, fill = 0xAB): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = (fill + i) % 256;
  return buf;
}

function makeTransferPair(id1 = "p1", id2 = "p2"): {
  t1: MemoryP2PTransport; t2: MemoryP2PTransport;
  store1: InMemoryChunkStore; store2: InMemoryChunkStore;
  reg1: ContentRegistry; reg2: ContentRegistry;
  eng1: TransferEngine; eng2: TransferEngine;
} {
  MemoryP2PTransport.clearRegistry();
  const t1 = new MemoryP2PTransport(id1);
  const t2 = new MemoryP2PTransport(id2);
  t1.addPeer(id2); t2.addPeer(id1);

  const store1 = new InMemoryChunkStore();
  const store2 = new InMemoryChunkStore();
  const reg1   = new ContentRegistry();
  const reg2   = new ContentRegistry();

  const eng1 = new TransferEngine(t1, store1, reg1, { concurrency: 4, maxRetries: 3, chunkTimeoutMs: 5000 });
  const eng2 = new TransferEngine(t2, store2, reg2, { concurrency: 4, maxRetries: 3, chunkTimeoutMs: 5000 });

  return { t1, t2, store1, store2, reg1, reg2, eng1, eng2 };
}

// ─── ContentAddresser ─────────────────────────────────────────────────────────

await runSuite("content-addresser", {
  "CID üretimi deterministik": async () => {
    const ca   = new ContentAddresser();
    const data = makeData(1024);
    const c1   = await ca.computeCID(data);
    const c2   = await ca.computeCID(data);
    assertEqual(c1, c2, "Aynı içerik → aynı CID");
    assert(ca.isValidCID(c1), "CID geçerli formatta olmalı");
  },

  "farklı içerik → farklı CID": async () => {
    const ca = new ContentAddresser();
    const c1 = await ca.computeCID(makeData(100, 0xAA));
    const c2 = await ca.computeCID(makeData(100, 0xBB));
    assert(c1 !== c2, "Farklı içerik → farklı CID");
  },

  "split: tek chunk (küçük dosya)": async () => {
    const ca   = new ContentAddresser();
    const data = makeData(1024); // 1 KB < 2MB chunk boyutu
    const { address, chunks } = await ca.split(data, "application/octet-stream");

    assertEqual(chunks.length, 1);
    assertEqual(address.chunks, 1);
    assertEqual(address.size, 1024);
    assert(address.cid.length > 0);
    assertEqual(chunks[0].descriptor.chunkIndex, 0);
    assertEqual(chunks[0].descriptor.offset, 0);
    assertEqual(chunks[0].descriptor.size, 1024);
  },

  "split: çok chunk (büyük dosya)": async () => {
    const ca       = new ContentAddresser();
    const size     = 5 * 1024 * 1024; // 5 MB
    const data     = makeData(size);
    const chunkSz  = 2 * 1024 * 1024; // 2 MB chunk
    const { address, chunks } = await ca.split(data, "model/stl", chunkSz);

    assertEqual(chunks.length, 3, "5MB / 2MB = 3 chunk (son kısmi)");
    assertEqual(address.chunks, 3);
    assertEqual(address.size,   size);

    // Chunk boyutları
    assertEqual(chunks[0].data.byteLength, chunkSz);
    assertEqual(chunks[1].data.byteLength, chunkSz);
    assert(chunks[2].data.byteLength > 0 && chunks[2].data.byteLength <= chunkSz);

    // Offset'ler
    assertEqual(chunks[0].descriptor.offset, 0);
    assertEqual(chunks[1].descriptor.offset, chunkSz);
    assertEqual(chunks[2].descriptor.offset, chunkSz * 2);
  },

  "assemble: birleştirme + CID doğrulama": async () => {
    const ca   = new ContentAddresser();
    const data = makeData(3 * 1024 * 1024); // 3 MB
    const { address, chunks } = await ca.split(data, "model/stl", 1024 * 1024);

    const result = await ca.assemble(chunks, address.cid);
    assert(result.ok, `Birleştirme başarısız: failedChunk=${result.failedChunk}`);
    assert(result.data !== undefined);
    assertEqual(result.data!.byteLength, data.byteLength);

    // İçerik aynı mı?
    for (let i = 0; i < data.byteLength; i++) {
      if (result.data![i] !== data[i]) {
        assert(false, `Byte ${i} farklı: ${result.data![i]} !== ${data[i]}`);
      }
    }
  },

  "assemble: bozuk chunk tespiti": async () => {
    const ca   = new ContentAddresser();
    const data = makeData(512 * 1024); // 512 KB
    const { address, chunks } = await ca.split(data, "image/png", 256 * 1024);

    // İkinci chunk'u boz
    const corrupted = [...chunks];
    const badData   = new Uint8Array(corrupted[1].data);
    badData[0] = ~badData[0]; // ilk byte'ı tersine çevir
    corrupted[1] = { ...corrupted[1], data: badData };

    const result = await ca.assemble(corrupted, address.cid);
    assert(!result.ok, "Bozuk chunk tespit edilmeli");
    assertEqual(result.failedChunk, 1, "Bozuk chunk index 1 olmalı");
  },

  "verifyChunk: geçerli": async () => {
    const ca        = new ContentAddresser();
    const data      = makeData(1024);
    const { chunks } = await ca.split(data, "text/plain", 512);
    const ok        = await ca.verifyChunk(chunks[0].data, chunks[0].descriptor);
    assert(ok);
  },

  "verifyChunk: bozuk → false": async () => {
    const ca        = new ContentAddresser();
    const data      = makeData(512);
    const { chunks } = await ca.split(data, "text/plain", 512);
    const bad       = new Uint8Array(chunks[0].data);
    bad[0] = ~bad[0];
    const ok = await ca.verifyChunk(bad, chunks[0].descriptor);
    assert(!ok, "Bozuk chunk reddedilmeli");
  },
});

// ─── ChunkStore ───────────────────────────────────────────────────────────────

await runSuite("chunk-store", {
  "put + get": async () => {
    const store = new InMemoryChunkStore();
    const desc: ChunkDescriptor = {
      cid: "abc123", chunkIndex: 0,
      chunkHash: "hash0", offset: 0, size: 1024,
    };
    const data = makeData(1024);
    await store.putChunk(desc, data);

    const got = await store.getChunk("abc123", 0);
    assert(got !== null);
    assertEqual(got!.descriptor.chunkIndex, 0);
    assertEqual(got!.data.byteLength, 1024);
  },

  "isComplete: tüm chunk'lar var mı?": async () => {
    const store = new InMemoryChunkStore();
    const cid   = "testcid";
    for (let i = 0; i < 3; i++) {
      await store.putChunk(
        { cid, chunkIndex: i, chunkHash: `h${i}`, offset: i * 512, size: 512 },
        makeData(512, i)
      );
    }
    assert(await store.isComplete(cid, 3),  "Tamamlanmış: 3/3");
    assert(!await store.isComplete(cid, 4), "Eksik: 3/4");
  },

  "assemble: sıralı birleştirme": async () => {
    const store = new InMemoryChunkStore();
    const cid   = "assemble_cid";
    // Ters sırayla ekle — assemble sıralamalı yapmalı
    for (let i = 2; i >= 0; i--) {
      await store.putChunk(
        { cid, chunkIndex: i, chunkHash: `h${i}`, offset: i * 100, size: 100 },
        makeData(100, i * 10)
      );
    }
    const result = await store.assemble(cid, 3);
    assert(result !== null);
    assertEqual(result!.byteLength, 300);
    // İlk chunk 0 ile başlamalı
    assertEqual(result![0], makeData(100, 0)[0]);
  },

  "delete": async () => {
    const store = new InMemoryChunkStore();
    const cid   = "del_cid";
    await store.putChunk(
      { cid, chunkIndex: 0, chunkHash: "h", offset: 0, size: 100 },
      makeData(100)
    );
    assert(await store.chunkCount(cid) > 0);
    await store.delete(cid);
    assertEqual(await store.chunkCount(cid), 0);
  },

  "totalBytes sayacı": async () => {
    const store = new InMemoryChunkStore();
    await store.putChunk(
      { cid: "c1", chunkIndex: 0, chunkHash: "h", offset: 0, size: 1000 },
      makeData(1000)
    );
    await store.putChunk(
      { cid: "c2", chunkIndex: 0, chunkHash: "h", offset: 0, size: 500 },
      makeData(500)
    );
    assertEqual(store.totalBytes(), 1500);
  },
});

// ─── ContentRegistry ─────────────────────────────────────────────────────────

await runSuite("content-registry", {
  "announce + providers": () => {
    const reg = new ContentRegistry();
    reg.announce("cid1", "peer1", { cid: "cid1", size: 1024, mimeType: "model/stl", chunks: 1 });
    reg.announce("cid1", "peer2", { cid: "cid1", size: 1024, mimeType: "model/stl", chunks: 1 });
    reg.announce("cid2", "peer1", { cid: "cid2", size: 512,  mimeType: "image/png",  chunks: 1 });

    const p1 = reg.providers("cid1");
    assert(p1.includes("peer1") && p1.includes("peer2"), "2 provider olmalı");
    assert(reg.providers("cid3").length === 0, "Bilinmeyen CID → boş");
  },

  "removePeer: peer'ın CID'leri temizlenir": () => {
    const reg = new ContentRegistry();
    reg.announce("c1", "peer1", { cid: "c1", size: 100, mimeType: "text/plain", chunks: 1 });
    reg.announce("c2", "peer1", { cid: "c2", size: 100, mimeType: "text/plain", chunks: 1 });
    reg.announce("c1", "peer2", { cid: "c1", size: 100, mimeType: "text/plain", chunks: 1 });

    reg.removePeer("peer1");
    const providers = reg.providers("c1");
    assert(!providers.includes("peer1"), "peer1 kaldırılmalı");
    assert(providers.includes("peer2"),  "peer2 kalmalı");
    assert(reg.providers("c2").length === 0, "c2 artık provider'sız");
  },

  "prune: eski kayıtları sil": async () => {
    const reg = new ContentRegistry();
    reg.announce("old", "p", { cid: "old", size: 1, mimeType: "text/plain", chunks: 1 });
    reg.removePeer("p"); // provider yok → prune edilebilir
    await waitMs(10);
    const pruned = reg.prune(1); // 1ms TTL
    assert(pruned >= 1, "Eski kayıt silinmeli");
  },

  "stats": () => {
    const reg = new ContentRegistry();
    reg.announce("c1", "p1", { cid: "c1", size: 1, mimeType: "t", chunks: 1 });
    reg.announce("c2", "p2", { cid: "c2", size: 1, mimeType: "t", chunks: 1 });
    const s = reg.stats();
    assertEqual(s.knownCIDs, 2);
    assertEqual(s.peerCount, 2);
  },
});

// ─── P2P Transport ────────────────────────────────────────────────────────────

await runSuite("p2p-transport", {
  "send + receive": async () => {
    MemoryP2PTransport.clearRegistry();
    const t1 = new MemoryP2PTransport("a");
    const t2 = new MemoryP2PTransport("b");
    await t1.start(); await t2.start();
    t1.addPeer("b");

    const received: string[] = [];
    t2.onMessage((msg) => { received.push(msg.type); });

    await t1.send("b", {
      type: "content:announce", messageId: "m1", senderId: "a", cid: "cid1", payload: {},
    });
    await waitMs(10);
    assert(received.includes("content:announce"));
    await t1.stop(); await t2.stop();
  },

  "partition: mesaj ulaşmaz": async () => {
    MemoryP2PTransport.clearRegistry();
    const t1 = new MemoryP2PTransport("pa");
    const t2 = new MemoryP2PTransport("pb");
    await t1.start(); await t2.start();
    t1.addPeer("pb");
    t1.partition(["pb"]);

    let got = false;
    t2.onMessage(() => { got = true; });
    await t1.send("pb", {
      type: "chunk:request", messageId: "m", senderId: "pa", cid: "c", payload: {},
    });
    await waitMs(20);
    assert(!got, "Partition → mesaj ulaşmamalı");
    await t1.stop(); await t2.stop();
  },

  "heal: partition kaldırılınca mesaj gider": async () => {
    MemoryP2PTransport.clearRegistry();
    const t1 = new MemoryP2PTransport("ha");
    const t2 = new MemoryP2PTransport("hb");
    await t1.start(); await t2.start();
    t1.addPeer("hb");
    t1.partition(["hb"]);
    t1.heal(["hb"]);

    let got = false;
    t2.onMessage(() => { got = true; });
    await t1.send("hb", {
      type: "content:announce", messageId: "m", senderId: "ha", cid: "c", payload: {},
    });
    await waitMs(20);
    assert(got, "Heal sonrası mesaj ulaşmalı");
    await t1.stop(); await t2.stop();
  },

  "metrics sayacı": async () => {
    MemoryP2PTransport.clearRegistry();
    const t1 = new MemoryP2PTransport("m1");
    const t2 = new MemoryP2PTransport("m2");
    await t1.start(); await t2.start();
    t1.addPeer("m2");
    t2.onMessage(() => {});

    for (let i = 0; i < 5; i++) {
      await t1.send("m2", {
        type: "content:announce", messageId: `m${i}`, senderId: "m1", cid: "c", payload: {},
      });
    }
    await waitMs(20);
    assertEqual(t1.metrics().sent, 5);
    assertEqual(t2.metrics().received, 5);
    await t1.stop(); await t2.stop();
  },
});

// ─── TransferEngine ───────────────────────────────────────────────────────────

await runSuite("transfer-engine/temel", {
  "duyuru (announce)": async () => {
    const { eng1, reg2, t1, t2 } = makeTransferPair();
    await t1.start(); await t2.start();

    // reg2'de dinle
    t2.onMessage((msg, from) => {
      if (msg.type === "content:announce") {
        const p = msg.payload as { cid: ContentId; size: number; mimeType: string; chunks: number };
        reg2.announce(p.cid, from, { cid: p.cid, size: p.size, mimeType: p.mimeType, chunks: p.chunks });
      }
    });

    const ca   = new ContentAddresser();
    const data = makeData(1024);
    const cid  = await ca.computeCID(data);
    await eng1.announce(cid, { cid, size: 1024, mimeType: "model/stl", chunks: 1 });

    await waitMs(30);
    const providers = reg2.providers(cid);
    assert(providers.includes("p1"), "p1 provider olarak kayıtlı olmalı");

    await t1.stop(); await t2.stop();
  },
});

await runSuite("transfer-engine/tam-akis", {
  "p1 → p2 tek chunk transfer": async () => {
    const { eng1, eng2, store1, reg2, t1, t2 } = makeTransferPair();
    await t1.start(); await t2.start();

    // Küçük dosya: 512 KB (< 2 MB chunk)
    const ca   = new ContentAddresser();
    const data = makeData(512 * 1024, 0x42);
    const { address, chunks } = await ca.split(data, "model/stl");

    // p1'de sakla
    for (const { descriptor, data: d } of chunks) {
      await store1.putChunk(descriptor, d);
    }

    // p1 duyurusu → reg2'ye kayıt
    reg2.announce(address.cid, "p1", address);

    // p2 indir
    const result = await eng2.download(address.cid);
    assert(result.ok, `Transfer başarısız: ${result.error}`);
    assert(result.data !== undefined, "Veri alınmalı");
    assertEqual(result.data!.byteLength, data.byteLength);
    assert(result.durationMs >= 0);

    await t1.stop(); await t2.stop();
  },

  "p1 → p2 çok chunk transfer (3 chunk)": async () => {
    const { eng2, store1, reg2, t1, t2 } = makeTransferPair();
    await t1.start(); await t2.start();

    const ca   = new ContentAddresser();
    const data = makeData(3 * 1024 * 1024, 0xCC); // 3 MB
    const { address, chunks } = await ca.split(data, "model/stl", 1024 * 1024); // 1MB chunk

    for (const { descriptor, data: d } of chunks) {
      await store1.putChunk(descriptor, d);
    }
    reg2.announce(address.cid, "p1", address);

    const result = await eng2.download(address.cid);
    assert(result.ok, `Çok chunk transfer başarısız: ${result.error}`);
    assertEqual(result.data!.byteLength, data.byteLength);
    console.log(`  → 3MB transfer: ${result.durationMs}ms`);

    await t1.stop(); await t2.stop();
  },
});

// ─── Determinizm ─────────────────────────────────────────────────────────────

await runSuite("determinism", {
  "aynı içerik → aynı CID (100 iterasyon)": async () => {
    const ca   = new ContentAddresser();
    const data = makeData(8192, 0x77);
    const cids = await Promise.all(
      Array.from({ length: 100 }, () => ca.computeCID(data))
    );
    const first = cids[0];
    for (const cid of cids) {
      assertEqual(cid, first, "Her iterasyon aynı CID vermeli");
    }
  },

  "chunk hash deterministik": async () => {
    const ca    = new ContentAddresser();
    const data  = makeData(2 * 1024 * 1024 + 100);
    const r1    = await ca.split(data, "model/stl");
    const r2    = await ca.split(data, "model/stl");
    assertEqual(r1.address.cid, r2.address.cid);
    for (let i = 0; i < r1.chunks.length; i++) {
      assertEqual(
        r1.chunks[i].descriptor.chunkHash,
        r2.chunks[i].descriptor.chunkHash,
        `Chunk ${i} hash farklı`
      );
    }
  },
});

// ─── Performans ───────────────────────────────────────────────────────────────

await runSuite("performans", {
  "10MB dosya CID hesaplama": async () => {
    const ca    = new ContentAddresser();
    const data  = makeData(10 * 1024 * 1024);
    const start = Date.now();
    const cid   = await ca.computeCID(data);
    const ms    = Date.now() - start;
    assert(cid.length > 0);
    assert(ms < 2000, `10MB CID ${ms}ms (beklenen < 2s)`);
    console.log(`  → 10MB SHA-256: ${ms}ms`);
  },

  "10MB chunk bölme": async () => {
    const ca    = new ContentAddresser();
    const data  = makeData(10 * 1024 * 1024);
    const start = Date.now();
    const { address, chunks } = await ca.split(data, "model/stl");
    const ms    = Date.now() - start;
    assertEqual(chunks.length, 5, "10MB / 2MB = 5 chunk");
    assert(ms < 3000, `10MB split ${ms}ms (beklenen < 3s)`);
    console.log(`  → 10MB split (${chunks.length} chunk): ${ms}ms`);
  },

  "1000 chunk store put/get": async () => {
    const store = new InMemoryChunkStore();
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      await store.putChunk(
        { cid: `cid${i % 10}`, chunkIndex: i % 100, chunkHash: `h${i}`, offset: i * 1024, size: 1024 },
        makeData(1024, i % 256)
      );
    }
    const ms = Date.now() - start;
    assert(ms < 1000, `1000 chunk put ${ms}ms (beklenen < 1s)`);
    console.log(`  → 1000 chunk put: ${ms}ms`);
  },
});
