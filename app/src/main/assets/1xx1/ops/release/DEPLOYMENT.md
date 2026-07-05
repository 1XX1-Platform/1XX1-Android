# 1XX1 Platform — Dağıtım Rehberi

**Sürüm:** 1.0.0

---

## Ön Gereksinimler

| Gereksinim | Minimum | Önerilen |
|---|---|---|
| Node.js | 20.x LTS | 22.x LTS |
| RAM (her düğüm) | 256 MB | 512 MB |
| CPU (her düğüm) | 0.25 core | 0.5 core |
| Disk | 10 GB | 50 GB |
| Docker | 24.x | 26.x |
| Kubernetes | 1.27 | 1.29 |

---

## Seçenek A: Docker Compose (Geliştirme / Test)

```bash
# 1. Repoyu klonla
git clone https://github.com/kaptan/1xx1
cd 1xx1

# 2. Image'ı inşa et
docker build -t 1xx1-node:latest .

# 3. Cluster başlat (3 node)
docker compose up -d

# 4. Sağlık kontrolü
curl http://localhost:8080/health
curl http://localhost:8081/health
curl http://localhost:8082/health

# 5. Lider bulma
for port in 8080 8081 8082; do
  role=$(curl -s http://localhost:$port/health | grep -o '"role":"[^"]*"')
  echo "Port $port: $role"
done

# 6. Durdurma
docker compose down
```

---

## Seçenek B: Kubernetes / Helm (Prodüksiyon)

```bash
# 1. Kubernetes cluster bağlantısı doğrula
kubectl cluster-info

# 2. Namespace oluştur
kubectl create namespace x1

# 3. Gizli anahtarları kaydet (Her node için farklı anahtar!)
kubectl create secret generic x1-node-private-key \
  --from-literal=privateKey="$(cat node1.privkey.pem)" \
  -n x1

# 4. Helm ile yükle
helm install x1 ./ops/deployment/helm \
  -f ops/deployment/helm-values.yaml \
  -n x1 \
  --set image.tag=1.0.0

# 5. Pod durumu
kubectl get pods -n x1 -w

# 6. Servis logu
kubectl logs -n x1 -l app.kubernetes.io/name=1xx1-node -f

# 7. Port yönlendirme (test)
kubectl port-forward -n x1 svc/x1-node1 8080:8080
```

---

## Seçenek C: Ham Sunucu (Bare Metal / VPS)

```bash
# 1. Her sunucuda
node --version  # 20+ gerekli

# 2. Kodu çek
git clone https://github.com/kaptan/1xx1
cd 1xx1 && npm ci --only=production

# 3. Ortam değişkenlerini ayarla (.env dosyası ASLA commit'lenmez)
cat > /etc/x1/node.env << 'EOF'
X1_NODE_ID=node1
X1_API_PORT=8080
X1_METRICS_PORT=9090
X1_PEERS=192.168.1.2:8080,192.168.1.3:8080
X1_LOG_LEVEL=info
X1_LOG_FORMAT=json
EOF

# 4. SystemD servis
cat > /etc/systemd/system/x1-node.service << 'EOF'
[Unit]
Description=1XX1 Platform Node
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/x1/node.env
ExecStart=/usr/bin/node /opt/1xx1/dist/main.js
Restart=always
RestartSec=5
User=x1user
Group=x1group

[Install]
WantedBy=multi-user.target
EOF

systemctl enable x1-node
systemctl start x1-node
```

---

## Doğrulama Kontrol Listesi (Post-Deployment)

```
[ ] /health endpoint 200 döndürüyor
[ ] /metrics endpoint Prometheus formatında veri döndürüyor
[ ] En az 1 node "leader" rolünde
[ ] Node'lar birbirini peer olarak görüyor (x1_node_active_peers >= 2)
[ ] Pulse tick çalışıyor (x1_pulse_tick_total artıyor)
[ ] Log JSON formatında ve hata yok (level != "error")
[ ] Anti-affinity: node'lar farklı fiziksel/sanal makinelerde
[ ] PodDisruptionBudget aktif (minAvailable: 2)
```

---

## Rollback

```bash
# Helm ile önceki sürüme geri dön
helm rollback x1 1 -n x1

# Docker Compose ile önceki image
docker compose down
docker tag 1xx1-node:1.0.0 1xx1-node:latest
docker compose up -d
```
