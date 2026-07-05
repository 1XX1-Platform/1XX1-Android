# Aşama-07 — Persistence (Veritabanı) Katmanı

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-08 — Proje ve Geliştirici Yönetimi

---

## Mimari

```
Application (Aşama 08+)
    ↓
Repository Interface (core/interfaces.ts)
    ↓
UnitOfWork (database/index.ts)
    ↓
Repository Implementations (database/repositories/)
    ↓
Mapper (database/mapper/)
    ↓
DbPool (InMemoryPool | PgPool)
    ↓
PostgreSQL (production)
```

**Kritik kural:** Hiçbir üst katman SQL görmez. Tüm erişim Repository arayüzleri üzerinden geçer.

---

## Dosyalar

| Dosya | Satır | Açıklama |
|---|---|---|
| `database/schema/schema.ts` | ~130 | Tablo şemaları, kolon tipleri, indeks tanımları |
| `database/connection.ts` | ~270 | InMemoryPool + PgPool, DbPool arayüzü |
| `database/transaction.ts` | ~110 | TransactionManager, savepoint desteği |
| `database/mapper/mapper.ts` | ~130 | DB satırı ↔ domain model dönüşümü |
| `database/repositories/project.repository.ts` | ~160 | IProjectRepository implementasyonu |
| `database/repositories/other.repositories.ts` | ~230 | Developer, Event, Snapshot repository'leri |
| `database/migrations/runner.ts` | ~140 | MigrationRunner, 6 migration, history |
| `database/seed/seeder.ts` | ~120 | DatabaseSeeder, 3 dev + 10 proje |
| `database/index.ts` | ~60 | UnitOfWork, dışa aktarma |
| `database/__tests__/database.test.ts` | ~370 | 10 grup, 40+ test, performans |

---

## Tablolar

| Tablo | Açıklama |
|---|---|
| `projects` | Proje varlıkları |
| `developers` | Geliştirici varlıkları |
| `events` | Event Store (replay için) |
| `cube_snapshots` | Küp motoru anlık görüntüleri |
| `cube_index` | Küp-proje ilişkisi |
| `schema_migrations` | Migration geçmişi |

---

## İndeksler (6 migration, 006'da)

`idx_projects_developer_id`, `idx_projects_cube_path`, `idx_projects_status`, `idx_projects_license`, `idx_projects_created_at`, `idx_projects_cube_xyz`, `idx_projects_tags (GIN)` + event, snapshot, cube_index indeksleri.

---

## Transaction Sistemi

```typescript
// Otomatik transaction
await db.tx.run(async (tx) => {
  const project = await db.projects.create(data, tx);
  await db.events.store("core", "project:created", { id: project.id }, key, tx);
  // hata → otomatik rollback
});

// Manuel transaction
const tx = await db.tx.begin();
try {
  await tx.savepoint("before_split");
  // Cube split işlemleri...
  await tx.commit();
} catch {
  await tx.rollback();
}
```

---

## Event Store

```typescript
// Depolama (idempotent)
await db.events.store("cube", "cube:split", payload, idempotencyKey);

// Replay
const events = await db.events.findSince(lastRestartDate);
for (const ev of events) {
  eventBus.replay([ev]);
}
```

---

## Snapshot Sistemi

```typescript
// Kaydet
await db.snapshots.save("4/7/2", cubeEngine.serialize());

// Yükle (yeniden başlatmada)
const snap = await db.snapshots.latest("4/7/2");
if (snap) cubeEngine.restore(snap.payload);

// Temizle (her path için son 3 tut)
await db.snapshots.pruneOld("4/7/2", 3);
```

---

## Test Stratejisi

- **InMemoryPool**: Gerçek PostgreSQL gerektirmez. Tüm testler in-memory.
- **Migration idempotency**: İki kez çalışınca skip eder.
- **Performans**: 1000 proje insert < 5000ms, listAll < 500ms, count < 100ms.

---

## Production Geçişi

`createPool("postgres", dbConfig)` → PgPool aktif olur.  
Diğer hiçbir kod değişmez.  
UnitOfWork aynı API'yi korur.

---

## Sonraki Aşamanın Amacı

**Aşama-08 — Proje ve Geliştirici Yönetimi**

- Proje CRUD servis katmanı (domain logic)
- Geliştirici profil yönetimi
- Küp motoru + repository entegrasyonu
- Proje oluşturulunca: CubeEngine.index() + IndexManager.indexProject() + EventStore
- API endpoint'leri: POST /projects, GET /projects/:id, PATCH /projects/:id
