/**
 * 1XX1 Seed Verisi
 * Aşama 07 — Persistence Katmanı
 *
 * Geliştirme ve test ortamı için örnek veri.
 * Production'da çalıştırılmaz.
 *
 * Seed:
 *   - 3 geliştirici
 *   - 10 proje (farklı koordinatlarda)
 *   - Farklı lisans, tag ve durum kombinasyonları
 */

import type { ProjectRepository } from "../repositories/project.repository.ts";
import type { DeveloperRepository } from "../repositories/other.repositories.ts";
import type { ILogger } from "../core/interfaces.ts";
import type { LicenseType, ProjectStatus } from "../core/types.ts";

// ─── Seed Verisi ──────────────────────────────────────────────────────────────

const SEED_DEVELOPERS = [
  {
    username:    "kaptan",
    displayName: "Kaptan",
    bio:         "1XX1 ekosistemi mimarı. Vienna tabanlı geliştirici.",
    website:     "https://github.com/kaptan",
  },
  {
    username:    "alice_dev",
    displayName: "Alice",
    bio:         "3D yazılım ve mesh processing uzmanı.",
  },
  {
    username:    "bob_coder",
    displayName: "Bob",
    bio:         "Açık kaynak savunucusu.",
  },
] as const;

interface SeedProject {
  name:        string;
  description: string;
  cube:        { x: number; y: number; z: number };
  developerUsername: string;
  repo:        string;
  tags:        string[];
  license:     LicenseType;
  status:      ProjectStatus;
}

const SEED_PROJECTS: SeedProject[] = [
  {
    name:        "Kaptan STL Viewer",
    description: "WebGL tabanlı 3D STL model görüntüleyici. FEM analizi içerir.",
    cube:        { x: 4, y: 7, z: 2 },
    developerUsername: "kaptan",
    repo:        "https://github.com/kaptan/stl-viewer",
    tags:        ["STL", "WebGL", "3D", "viewer", "FEM"],
    license:     "MIT",
    status:      "active",
  },
  {
    name:        "KAPTAN vQ-CAD",
    description: "Fraktal geometri tabanlı CAD motoru. 11×11×11 küp sistemi.",
    cube:        { x: 4, y: 7, z: 3 },
    developerUsername: "kaptan",
    repo:        "https://github.com/kaptan/vq-cad",
    tags:        ["CAD", "geometry", "fractal", "3D"],
    license:     "MIT",
    status:      "active",
  },
  {
    name:        "Mesh Repair Tool",
    description: "STL mesh onarımı için komut satırı aracı.",
    cube:        { x: 3, y: 6, z: 2 },
    developerUsername: "alice_dev",
    repo:        "https://github.com/alice/mesh-repair",
    tags:        ["mesh", "repair", "STL", "CLI"],
    license:     "GPL",
    status:      "active",
  },
  {
    name:        "Triangulate Engine",
    description: "Yüzey triangulasyon algoritmaları koleksiyonu.",
    cube:        { x: 5, y: 7, z: 2 },
    developerUsername: "alice_dev",
    repo:        "https://github.com/alice/triangulate",
    tags:        ["triangulation", "geometry", "algorithm"],
    license:     "MIT",
    status:      "active",
  },
  {
    name:        "OBJ Exporter",
    description: "Wavefront OBJ formatına dışa aktarma modülü.",
    cube:        { x: 4, y: 8, z: 2 },
    developerUsername: "bob_coder",
    repo:        "https://github.com/bob/obj-export",
    tags:        ["OBJ", "export", "3D", "format"],
    license:     "Apache",
    status:      "active",
  },
  {
    name:        "Physics Sim",
    description: "Rigid body fizik simülasyonu.",
    cube:        { x: 6, y: 5, z: 4 },
    developerUsername: "bob_coder",
    repo:        "https://github.com/bob/physics-sim",
    tags:        ["physics", "simulation", "3D"],
    license:     "MIT",
    status:      "pending",
  },
  {
    name:        "Shader Library",
    description: "GLSL shader koleksiyonu.",
    cube:        { x: 3, y: 3, z: 7 },
    developerUsername: "alice_dev",
    repo:        "https://github.com/alice/shaders",
    tags:        ["GLSL", "shader", "WebGL", "graphics"],
    license:     "MIT",
    status:      "active",
  },
  {
    name:        "Asset Packer",
    description: "3D asset paketleme ve sıkıştırma aracı.",
    cube:        { x: 8, y: 2, z: 5 },
    developerUsername: "kaptan",
    repo:        "https://github.com/kaptan/asset-pack",
    tags:        ["asset", "packer", "compression", "3D"],
    license:     "MIT",
    status:      "active",
  },
  {
    name:        "Point Cloud Viewer",
    description: "LiDAR nokta bulutu görselleştirme aracı.",
    cube:        { x: 2, y: 9, z: 1 },
    developerUsername: "bob_coder",
    repo:        "https://github.com/bob/point-cloud",
    tags:        ["lidar", "point-cloud", "viewer", "3D"],
    license:     "BSD",
    status:      "active",
  },
  {
    name:        "Legacy Format Converter",
    description: "Eski 3D formatlarını modern formatlara dönüştürür.",
    cube:        { x: 1, y: 1, z: 9 },
    developerUsername: "alice_dev",
    repo:        "https://github.com/alice/convert",
    tags:        ["converter", "format", "legacy", "3D"],
    license:     "GPL",
    status:      "archived",
  },
];

// ─── Seeder ───────────────────────────────────────────────────────────────────

export class DatabaseSeeder {
  private developerIds: Map<string, string> = new Map();

  constructor(
    projectRepo:   ProjectRepository,
    developerRepo: DeveloperRepository,
    logger?:       ILogger
  ) {
    this.logger = logger;
    this.developerRepo = developerRepo;
    this.projectRepo = projectRepo;}

  async seed(): Promise<{ developers: number; projects: number }> {
    this.logger?.info("Seed verisi ekleniyor...");

    // Geliştiriciler
    let devCount = 0;
    for (const devData of SEED_DEVELOPERS) {
      const existing = await this.developerRepo.findByUsername(devData.username);
      if (existing) {
        this.developerIds.set(devData.username, existing.id);
        continue;
      }
      const dev = await this.developerRepo.create(devData);
      this.developerIds.set(devData.username, dev.id);
      devCount++;
    }

    // Projeler
    let projCount = 0;
    for (const projData of SEED_PROJECTS) {
      const developerId = this.developerIds.get(projData.developerUsername);
      if (!developerId) continue;

      // Duplicate önleme: aynı repo URL'si varsa geç
      const all = await this.projectRepo.listAll(1000, 0);
      if (all.some((p) => p.repo === projData.repo)) continue;

      await this.projectRepo.create({
        name:        projData.name,
        description: projData.description,
        cube:        projData.cube,
        developer:   developerId,
        repo:        projData.repo,
        tags:        projData.tags,
        license:     projData.license,
        status:      projData.status,
      });
      projCount++;
    }

    this.logger?.info(`Seed tamamlandı: ${devCount} geliştirici, ${projCount} proje`);
    return { developers: devCount, projects: projCount };
  }
}
