/**
 * 1XX1 Preview — Üst Düzey Dışa Aktarma
 * Aşama 17 — Web Önizleme Motoru
 *
 * Bu dosya iki bağımsız alt modülü bir araya getirir:
 *
 *   preview/core/      → platform bağımsız (document/window/HTMLElement bilmez)
 *   preview/renderer/  → browser/DOM bilir, Core'u import eder
 *
 * Yalnızca Core'a ihtiyaç duyan tüketiciler (örn. CLI, sunucu tarafı
 * extraction job'ları) doğrudan "preview/core/index.ts" import etmelidir;
 * bu sayede gereksiz DOM bağımlılığı zincire girmez.
 *
 * Web/Electron/Tauri gibi DOM'a erişimi olan istemciler bu dosyayı
 * veya doğrudan "preview/renderer/index.ts" kullanabilir.
 */
export * from "./core/index.ts";
export * from "./renderer/index.ts";
