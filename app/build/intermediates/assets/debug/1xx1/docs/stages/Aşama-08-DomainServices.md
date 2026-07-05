# Aşama-08 — Domain & Application Services

**Tarih:** 2026-06-28  
**Durum:** ✅ Tamamlandı  
**Sonraki Aşama:** Aşama-09 — Kanal (Ada) Sistemi

---

## Mimari

```
ApplicationOrchestrator (tek giriş noktası)
├── ProjectService
│     Validation → Policy → TX(Repository + EventStore) →
│     CubeEngine → IndexManager → DomainEventPublisher
├── DeveloperService
│     Validation → Policy → TX(Repository + EventStore) →
│     DomainEventPublisher
└── SearchApplicationService
      Policy(visibility) → SearchEngine(read-only) →
      Repository(fetch) → toProjectSummary
```

---

## CQRS Ayrımı

**Komutlar** (yazma) — `commands/commands.ts`:
- `CreateProjectCommand`, `UpdateProjectCommand`, `ArchiveProjectCommand`
- `MoveProjectCommand`, `VerifyProjectCommand`, `RejectProjectCommand`
- `RegisterDeveloperCommand`, `UpdateDeveloperCommand`, `MaskDeveloperCommand`, `CreateChannelCommand`

**Sorgular** (okuma) — `queries/queries.ts`:
- `SearchProjectsQuery`, `GetProjectQuery`, `ListDeveloperProjectsQuery`
- `GetDeveloperQuery`, `GetCubeStatsQuery`

Okuma ve yazma birbirini asla çağırmaz.

---

## Validator — İş Kuralları

| Kural | Kod |
|---|---|
| İsim < 3 karakter | `NAME_TOO_SHORT` |
| Açıklama < 10 karakter | `DESCRIPTION_TOO_SHORT` |
| Repo bilinen platformda değil | `INVALID_REPO_URL` |
| Yasaklı etiket | `TAG_BANNED` |
| 15'ten fazla etiket | `TOO_MANY_TAGS` |
| Geçersiz küp koordinatı | `INVALID_CUBE_COORDINATE` |
| İsim çakışması (aynı geliştiricide) | `DUPLICATE_PROJECT_NAME` |
| Günlük 10 proje sınırı | `DAILY_LIMIT_EXCEEDED` |
| Rezerve username | `RESERVED_USERNAME` |
| Username deseni geçersiz | `INVALID_USERNAME` |
| Cüzdan adresi geçersiz | `INVALID_DONATION_ADDRESS` |

---

## Policy Engine

```
ProjectPolicy:
  canUpdate(project, requesterId)  → NOT_OWNER | PROJECT_ARCHIVED
  canArchive(project, requesterId) → NOT_OWNER | ALREADY_ARCHIVED
  canMove(project, requesterId)    → NOT_OWNER | PROJECT_ARCHIVED
  canView(project, viewerId)       → ARCHIVED_PRIVATE
  canVerify(project)               → ALREADY_VERIFIED | PROJECT_ARCHIVED

DeveloperPolicy:
  canUpdateProfile(id, requesterId) → NOT_SELF
  canMask(developer)               → (herkese açık, Aşama 14'te kısıtlanacak)
  canCreateChannel(dev, count)     → MAX_CHANNELS_REACHED (limit: 3)

VisibilityPolicy:
  searchableStatuses() → ["active", "verified"]
  isSearchable(project) → bool

DonationPolicy:
  canShowDonation(project, developer) → PROJECT_ARCHIVED | NO_ADDRESS
  effectiveAddress() → proje > geliştirici önceliği
```

---

## Domain Events

| Olay | Tetikleyici |
|---|---|
| `project:published` | ProjectService.create() |
| `project:verified` | ProjectService.verify() |
| `project:rejected` | ProjectService.reject() |
| `project:archived` | ProjectService.archive() |
| `developer:registered` | DeveloperService.register() |
| `developer:masked` | DeveloperService.mask() |
| `channel:created` | DeveloperService.createChannel() |
| `asset:linked` | (Aşama 11) |

---

## Create Project Akışı

```
CreateProjectCommand
  1. ProjectValidator.validateCreate()   ← iş kuralları
  2. TX.begin()
     a. db.projects.create()            ← kalıcı depolama
     b. db.events.store("core")         ← audit trail
  3. TX.commit()
  4. cube.index(project)                ← koordinat indeksi (eventually consistent)
  5. index.indexProject(project)        ← arama indeksi
  6. publisher.projectPublished()       ← domain event
  ← CommandOutcome<Project>
```

---

## Dosyalar

| Dosya | Satır |
|---|---|
| `application/commands/commands.ts` | ~90 |
| `application/queries/queries.ts` | ~100 |
| `application/validators/domain-validators.ts` | ~190 |
| `application/policies/policies.ts` | ~160 |
| `application/events/domain-events.ts` | ~130 |
| `application/services/project.service.ts` | ~200 |
| `application/services/developer.service.ts` | ~160 |
| `application/orchestrator/orchestrator.ts` | ~80 |
| `application/index.ts` | ~15 |
| `application/__tests__/application.test.ts` | ~380 |

---

## Sonraki Aşamanın Amacı

**Aşama-09 — Kanal (Ada) Sistemi**

Her geliştirici bir "ada" (kanal) sahibi olur:
- Kanal: geliştirici + uygulamalar + bağış noktası
- Kanal ID = geliştirici ID'siyle bağlı
- Abonelik sistemi (başkasının kanalını takip et)
- Kanal aktivite akışı (son 20 olay)
- Kanal istatistikleri (toplam proje, yıldız, bağış)
