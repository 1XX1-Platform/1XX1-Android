/**
 * 1XX1 Transport Catalog — FAZ T.1
 *
 * Kaptan'in tasiyici-bagimsiz (transport-agnostic) vizyonunun veri temeli.
 * Cekirdek hicbir zaman "Wi-Fi'dayim" demez; sadece bu katalogdan
 * "su anda en iyi yol hangisi?" cevabini alir.
 *
 * KURAL: Yeni teknoloji = bu tabloya bir satir + bir ITransport implementasyonu.
 *        Cekirdege ASLA dokunulmaz.
 */

// ─── Tipler ───────────────────────────────────────────────────────────────────

export type TransportRole = "discovery" | "connection" | "both";

export type ImplStatus =
  | "node"     // Node.js icinde gercek calisir (Termux + APK)
  | "bridge"   // Android native tarafi HTTP koprusuyle bildirir (/admin/add-peer)
  | "stub";    // arayuz hazir, implementasyon gelecekte

export type SpeedClass = "cok-dusuk" | "dusuk" | "orta" | "yuksek" | "cok-yuksek";

export type TransportSpec = {
  id:            string;
  name:          string;
  priority:      number;      // 1-5 yildiz (5 = ilk tercih)
  role:          TransportRole;
  needsInternet: boolean;
  rangeMeters:   [number, number];  // [min, max]; -1 = sinirsiz/kablo/kuresel
  speed:         SpeedClass;
  purpose:       string;
  impl:          ImplStatus;
  /** Buyuk veri tasimaya uygun mu? (ses/QR/NFC sadece kesif icindir) */
  bulkCapable:   boolean;
};

// ─── Katalog — Kaptan'in tablosu ─────────────────────────────────────────────

export const TRANSPORT_CATALOG: TransportSpec[] = [
  { id:"lan-ethernet",  name:"LAN (Ethernet)",     priority:5, role:"both",       needsInternet:false, rangeMeters:[0,-1],    speed:"cok-yuksek", purpose:"En stabil",              impl:"node",   bulkCapable:true  },
  { id:"wifi-ayni-ag",  name:"Wi-Fi (ayni ag)",    priority:5, role:"both",       needsInternet:false, rangeMeters:[30,100],  speed:"cok-yuksek", purpose:"Ana tasiyici",           impl:"node",   bulkCapable:true  },
  { id:"wifi-hotspot",  name:"Wi-Fi Hotspot",      priority:5, role:"both",       needsInternet:false, rangeMeters:[30,100],  speed:"cok-yuksek", purpose:"Acil ag",                impl:"node",   bulkCapable:true  },
  { id:"wifi-direct",   name:"Wi-Fi Direct",       priority:5, role:"connection", needsInternet:false, rangeMeters:[30,100],  speed:"cok-yuksek", purpose:"Telefondan telefona",    impl:"bridge", bulkCapable:true  },
  { id:"ble",           name:"Bluetooth LE",       priority:4, role:"discovery",  needsInternet:false, rangeMeters:[10,30],   speed:"dusuk",      purpose:"Kesif + kucuk veri",     impl:"bridge", bulkCapable:false },
  { id:"bt-classic",    name:"Bluetooth Classic",  priority:4, role:"connection", needsInternet:false, rangeMeters:[10,100],  speed:"orta",       purpose:"Yedek baglanti",         impl:"bridge", bulkCapable:true  },
  { id:"udp-multicast", name:"UDP Multicast",      priority:4, role:"discovery",  needsInternet:false, rangeMeters:[0,-1],    speed:"cok-yuksek", purpose:"Peer kesfi",             impl:"node",   bulkCapable:false },
  { id:"subnet-sweep",  name:"Subnet Taramasi",    priority:4, role:"discovery",  needsInternet:false, rangeMeters:[0,-1],    speed:"yuksek",     purpose:"Multicast'siz kesif",    impl:"node",   bulkCapable:false },
  { id:"mdns",          name:"mDNS / DNS-SD",      priority:4, role:"discovery",  needsInternet:false, rangeMeters:[0,-1],    speed:"yuksek",     purpose:"Servis kesfi",           impl:"bridge", bulkCapable:false },
  { id:"ipv6-ll",       name:"IPv6 Link-Local",    priority:4, role:"connection", needsInternet:false, rangeMeters:[0,-1],    speed:"cok-yuksek", purpose:"Router'siz iletisim",    impl:"stub",   bulkCapable:true  },
  { id:"nfc",           name:"NFC",                priority:3, role:"discovery",  needsInternet:false, rangeMeters:[0,0.1],   speed:"cok-dusuk",  purpose:"Ilk eslesme",            impl:"bridge", bulkCapable:false },
  { id:"qr",            name:"QR Kod",             priority:3, role:"discovery",  needsInternet:false, rangeMeters:[0,10],    speed:"cok-dusuk",  purpose:"Kimlik paylasimi",       impl:"bridge", bulkCapable:false },
  { id:"audio-ultra",   name:"Ultrasonik Ses",     priority:3, role:"discovery",  needsInternet:false, rangeMeters:[2,10],    speed:"cok-dusuk",  purpose:"Agsiz kesif",            impl:"stub",   bulkCapable:false },
  { id:"audio",         name:"Duyulabilir Ses",    priority:3, role:"discovery",  needsInternet:false, rangeMeters:[2,5],     speed:"cok-dusuk",  purpose:"Son care kesif",         impl:"stub",   bulkCapable:false },
  { id:"usb-otg",       name:"USB-OTG",            priority:3, role:"connection", needsInternet:false, rangeMeters:[0,2],     speed:"cok-yuksek", purpose:"Dogrudan aktarim",       impl:"stub",   bulkCapable:true  },
  { id:"lora",          name:"LoRa",               priority:2, role:"both",       needsInternet:false, rangeMeters:[100,15000],speed:"cok-dusuk", purpose:"Uzun menzil",            impl:"stub",   bulkCapable:false },
  { id:"meshtastic",    name:"Meshtastic",         priority:2, role:"both",       needsInternet:false, rangeMeters:[100,15000],speed:"dusuk",     purpose:"LoRa tabanli mesh",      impl:"stub",   bulkCapable:false },
  { id:"thread",        name:"Thread (802.15.4)",  priority:2, role:"connection", needsInternet:false, rangeMeters:[10,100],  speed:"dusuk",      purpose:"IoT mesh",               impl:"stub",   bulkCapable:false },
  { id:"zigbee",        name:"Zigbee",             priority:2, role:"connection", needsInternet:false, rangeMeters:[10,100],  speed:"dusuk",      purpose:"IoT",                    impl:"stub",   bulkCapable:false },
  { id:"uwb",           name:"UWB",                priority:2, role:"both",       needsInternet:false, rangeMeters:[10,50],   speed:"orta",       purpose:"Yakin konum + veri",     impl:"stub",   bulkCapable:true  },
  { id:"cellular",      name:"Hucresel Internet",  priority:1, role:"connection", needsInternet:true,  rangeMeters:[0,-1],    speed:"yuksek",     purpose:"Son secenek",            impl:"stub",   bulkCapable:true  },
  { id:"satellite",     name:"Uydu",               priority:1, role:"connection", needsInternet:true,  rangeMeters:[0,-1],    speed:"orta",       purpose:"Ozel senaryolar",        impl:"stub",   bulkCapable:true  },
];

// ─── Yardimcilar ─────────────────────────────────────────────────────────────

export function getSpec(id: string): TransportSpec | null {
  return TRANSPORT_CATALOG.find(t => t.id === id) ?? null;
}

/** Baglanti (veri tasima) adaylarini oncelik sirasiyla ver */
export function connectionLadder(): TransportSpec[] {
  return TRANSPORT_CATALOG
    .filter(t => (t.role === "connection" || t.role === "both") && t.bulkCapable)
    .sort((a, b) => b.priority - a.priority || (b.impl === "node" ? 1 : 0) - (a.impl === "node" ? 1 : 0));
}

/** Kesif kaynaklarini oncelik sirasiyla ver */
export function discoveryLadder(): TransportSpec[] {
  return TRANSPORT_CATALOG
    .filter(t => t.role === "discovery" || t.role === "both")
    .sort((a, b) => b.priority - a.priority);
}

/** Internetsiz calisabilenler (Kaptan'in cekirdek kriteri) */
export function offlineCapable(): TransportSpec[] {
  return TRANSPORT_CATALOG.filter(t => !t.needsInternet);
}
