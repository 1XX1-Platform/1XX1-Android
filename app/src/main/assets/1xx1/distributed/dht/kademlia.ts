/**
 * 1XX1 DHT — Kademlia-lite
 * FAZ 3.3 — Internet scale peer discovery
 *
 * Klasik Kademlia'dan farklar:
 *   - UDP degil HTTP/fetch kullanilir (NAT dostu)
 *   - k=8 (standart 20 yerine — kucuk network icin)
 *   - XOR distance metric (ayni)
 *   - k-buckets (ayni)
 *   - FindNode / Store / Lookup RPC (ayni)
 *
 * Bu layer gossip discovery'nin ustunde calisir:
 *   Gossip → yerel/LAN peer discovery
 *   DHT    → internet scale peer discovery
 */

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const K          = 8;    // k-bucket buyuklugu
const ALPHA      = 3;    // paralel lookup sayisi
const ID_BITS    = 256;  // nodeId bit uzunlugu (SHA-256)
const BUCKET_CNT = ID_BITS;

// ─── XOR Distance ─────────────────────────────────────────────────────────────

/**
 * XOR distance: iki nodeId arasindaki Kademlia mesafesi.
 * nodeId'ler hex string veya base58 — once normalize et.
 */
export function xorDistance(a: string, b: string): bigint {
  const aBuf = nodeIdToBigInt(a);
  const bBuf = nodeIdToBigInt(b);
  return aBuf ^ bBuf;
}

function nodeIdToBigInt(id: string): bigint {
  // Base58 veya hex — her ikisi de BigInt'e donusturulebilir
  // Basitlik icin: string'i UTF-8 byte'lara don, BigInt yap
  const bytes = new TextEncoder().encode(id.slice(0, 32)); // ilk 32 byte
  let result  = 0n;
  for (const b of bytes) result = (result << 8n) | BigInt(b);
  return result;
}

function bucketIndex(distance: bigint): number {
  if (distance === 0n) return 0;
  let idx = 0;
  let d   = distance;
  while (d > 0n) { d >>= 1n; idx++; }
  return Math.min(idx - 1, BUCKET_CNT - 1);
}

// ─── DHT Contact ─────────────────────────────────────────────────────────────

export interface DHTContact {
  nodeId:   string;
  endpoint: string;  // http://ip:port
  lastSeen: number;
}

// ─── k-Bucket ────────────────────────────────────────────────────────────────

export class KBucket {
  private contacts: DHTContact[] = [];

  add(contact: DHTContact): void {
    const idx = this.contacts.findIndex(c => c.nodeId === contact.nodeId);
    if (idx >= 0) {
      // Zaten var — en sona tas (LRU)
      this.contacts.splice(idx, 1);
      this.contacts.push({ ...contact, lastSeen: Date.now() });
    } else if (this.contacts.length < K) {
      this.contacts.push({ ...contact, lastSeen: Date.now() });
    } else {
      // Bucket dolu — en eski contact'i cikart (basit politika)
      // Gercek Kademlia: en eski contact'e ping at, cevap vermezse cikart
      this.contacts.shift();
      this.contacts.push({ ...contact, lastSeen: Date.now() });
    }
  }

  remove(nodeId: string): void {
    this.contacts = this.contacts.filter(c => c.nodeId !== nodeId);
  }

  getContacts(): DHTContact[] {
    return [...this.contacts];
  }

  size(): number { return this.contacts.length; }
}

// ─── Routing Table ────────────────────────────────────────────────────────────

export class RoutingTable {
  private buckets: KBucket[] = Array.from({ length: BUCKET_CNT }, () => new KBucket());

  private readonly selfNodeId: string;
  constructor(selfNodeId: string) { this.selfNodeId = selfNodeId; }

  add(contact: DHTContact): void {
    if (contact.nodeId === this.selfNodeId) return; // kendini ekleme
    const dist  = xorDistance(this.selfNodeId, contact.nodeId);
    const idx   = bucketIndex(dist);
    this.buckets[idx].add(contact);
  }

  remove(nodeId: string): void {
    const dist = xorDistance(this.selfNodeId, nodeId);
    const idx  = bucketIndex(dist);
    this.buckets[idx].remove(nodeId);
  }

  /**
   * FindNode: Verilen nodeId'ye en yakin K contact'i dondur.
   */
  findNearest(targetId: string, count = K): DHTContact[] {
    const targetDist = xorDistance(this.selfNodeId, targetId);

    const all: Array<{ contact: DHTContact; dist: bigint }> = [];
    for (const bucket of this.buckets) {
      for (const c of bucket.getContacts()) {
        const d = xorDistance(c.nodeId, targetId);
        all.push({ contact: c, dist: d });
      }
    }

    return all
      .sort((a, b) => (a.dist < b.dist ? -1 : a.dist > b.dist ? 1 : 0))
      .slice(0, count)
      .map(x => x.contact);
  }

  size(): number {
    return this.buckets.reduce((s, b) => s + b.size(), 0);
  }

  allContacts(): DHTContact[] {
    return this.buckets.flatMap(b => b.getContacts());
  }
}

// ─── DHT RPC ─────────────────────────────────────────────────────────────────

export interface FindNodeRequest {
  fromNodeId: string;
  targetId:   string;
}

export interface FindNodeResponse {
  contacts: DHTContact[];
}

export interface StoreRequest {
  key:   string;
  value: string;
  ttlMs: number;
}

// ─── Kademlia Engine ──────────────────────────────────────────────────────────

export class KademliaEngine {
  private readonly table: RoutingTable;
  private readonly store: Map<string, { value: string; expiresAt: number }> = new Map();

  private readonly selfNodeId: string;
  private readonly selfEndpoint: string;
  private readonly logger: { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void } | undefined;

  constructor(
    selfNodeId: string,
    selfEndpoint: string,
    logger?: { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void }
  ) {
    this.selfNodeId   = selfNodeId;
    this.selfEndpoint = selfEndpoint;
    this.logger       = logger;
    this.table = new RoutingTable(selfNodeId);
  }

  // ─── Routing Table Erisimi ──────────────────────────────────────────────────

  addContact(contact: DHTContact): void {
    this.table.add(contact);
  }

  findNearest(targetId: string, count = K): DHTContact[] {
    return this.table.findNearest(targetId, count);
  }

  size(): number { return this.table.size(); }

  // ─── HandleFindNode (gelen istek) ──────────────────────────────────────────

  handleFindNode(req: FindNodeRequest): FindNodeResponse {
    // Istegi yapan node'u routing table'a ekle
    // (endpoint'i bilmiyoruz — gossip'ten gelecek)
    const nearest = this.table.findNearest(req.targetId, K);
    return { contacts: nearest };
  }

  // ─── HandleStore ────────────────────────────────────────────────────────────

  handleStore(req: StoreRequest): { ok: boolean } {
    this.store.set(req.key, {
      value:     req.value,
      expiresAt: Date.now() + req.ttlMs,
    });
    return { ok: true };
  }

  // ─── Lookup (iteratif node arama) ──────────────────────────────────────────

  async lookup(targetId: string): Promise<DHTContact[]> {
    const seen    = new Set<string>([this.selfNodeId]);
    const closest = this.table.findNearest(targetId, ALPHA);
    const queue   = [...closest];
    let result    = [...closest];

    while (queue.length > 0) {
      const batch = queue.splice(0, ALPHA);

      const responses = await Promise.allSettled(
        batch.map(contact => this._sendFindNode(contact, targetId))
      );

      for (const r of responses) {
        if (r.status !== "fulfilled" || !r.value) continue;
        for (const c of r.value.contacts) {
          if (seen.has(c.nodeId)) continue;
          seen.add(c.nodeId);
          this.table.add(c);
          result.push(c);
          queue.push(c);
        }
      }

      // En yakin K'yi tut
      const distOf = (c: DHTContact) => xorDistance(c.nodeId, targetId);
      result = result
        .sort((a, b) => (distOf(a) < distOf(b) ? -1 : 1))
        .slice(0, K);
    }

    return result;
  }

  // ─── HTTP RPC ───────────────────────────────────────────────────────────────

  private async _sendFindNode(
    contact:  DHTContact,
    targetId: string
  ): Promise<FindNodeResponse | null> {
    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(`${contact.endpoint}/dht/find-node`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ fromNodeId: this.selfNodeId, targetId }),
        signal:  controller.signal,
      });
      clearTimeout(timer);
      if (!r.ok) return null;
      return await r.json() as FindNodeResponse;
    } catch {
      this.table.remove(contact.nodeId); // erisemiyor — routing table'dan cikar
      return null;
    }
  }

  // ─── Store value RPC ────────────────────────────────────────────────────────

  async storeAt(contact: DHTContact, key: string, value: string, ttlMs = 3_600_000): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`${contact.endpoint}/dht/store`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ key, value, ttlMs }),
        signal:  controller.signal,
      });
      clearTimeout(timer);
      return r.ok;
    } catch {
      return false;
    }
  }

  // ─── Self-healing: periyodik routing table tazeleme ────────────────────────

  async refresh(): Promise<void> {
    if (this.table.size() === 0) return;

    // Kendi nodeId'sine en yakin node'lara FindNode at
    const nearest = this.table.findNearest(this.selfNodeId, 3);
    for (const contact of nearest) {
      const res = await this._sendFindNode(contact, this.selfNodeId);
      if (res) {
        for (const c of res.contacts) this.table.add(c);
      }
    }
    this.logger?.debug(`[DHT] Refresh: routing table size=${this.table.size()}`);
  }

  // ─── TTL temizleme ──────────────────────────────────────────────────────────

  cleanExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt < now) this.store.delete(k);
    }
  }

  // ─── Debug ──────────────────────────────────────────────────────────────────

  stats() {
    return {
      routingTableSize: this.table.size(),
      storeSize:        this.store.size,
      selfNodeId:       this.selfNodeId,
    };
  }
}
