# Guestbook with Prometheus and Grafana

This is the Pulumi Kubernetes Guestbook example with monitoring added. Everything runs on a local kind cluster and is deployed with a single `pulumi up`.

What gets deployed:

- The Guestbook app (frontend + Redis leader/replica)
- MetalLB, so `LoadBalancer` services get a real IP on kind
- Prometheus and Grafana from the `kube-prometheus-stack` Helm chart
- An apache exporter sidecar on the frontend and a redis exporter sidecar on both Redis pods
- A `ServiceMonitor` so Prometheus scrapes those exporters
- A "Guestbook Overview" dashboard in Grafana
- A small traffic generator pod so there is data to look at straight away

## Prerequisites

- Docker
- kind
- kubectl
- Node.js 18 or newer
- Pulumi CLI

## Deploy

Create the cluster:

```bash
kind create cluster --config kind-config.yaml
```

Install the dependencies and set up a local Pulumi stack:

```bash
npm install
export PULUMI_CONFIG_PASSPHRASE=guestbook
pulumi login --local
pulumi stack init dev
```

On Windows PowerShell use `$env:PULUMI_CONFIG_PASSPHRASE="guestbook"` instead of `export`.

Deploy:

```bash
pulumi up --yes
```

The first run takes around 5 to 8 minutes, mostly pulling images. When it finishes, print the outputs:

```bash
pulumi stack output
```

## Access

Grafana: http://localhost:30300

- Username: `admin`
- Password: `guestbook123`

Guestbook: http://localhost:30080

Prometheus: http://localhost:30090

These localhost links work on Linux, macOS and Windows. kind forwards them to the same LoadBalancer services.

The services also get their own MetalLB IPs, which are in the `grafanaUrl`, `guestbookUrl` and `prometheusUrl` outputs. On Linux you can open those directly. On macOS and Windows, Docker runs inside a VM, so those IPs can't be reached from the host. Use the localhost links there.

To use a different Grafana password, run `pulumi config set grafanaAdminPassword <password>` before `pulumi up`.

## Check that Prometheus is scraping the Guestbook

Open http://localhost:30090/targets and type `guestbook` in the filter. You should see `serviceMonitor/guestbook/guestbook/0` with 5 targets, all UP:

- 3 with `job="frontend-metrics"`, one per frontend pod
- 1 with `job="redis-leader-metrics"`
- 1 with `job="redis-replica-metrics"`

You can also run these queries on http://localhost:30090/graph:

```promql
up{namespace="guestbook"}
sum(rate(apache_accesses_total{namespace="guestbook"}[2m]))
sum by (app) (rate(redis_commands_processed_total{namespace="guestbook"}[2m]))
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook", container!=""}[2m]))
```

From the command line:

```bash
kubectl -n guestbook get servicemonitor
kubectl -n guestbook get svc -l monitoring.guestbook/scrape=true
```

## Grafana dashboard

In Grafana, go to Dashboards > Guestbook > Guestbook Overview. It shows the frontend request rate, Redis commands, connected clients and memory, plus CPU, memory, ready pods and restarts for the guestbook pods. Give it a minute or two after the deploy for the graphs to fill in.

## Project layout

- `index.ts`: config and stack outputs
- `metallb.ts`: installs MetalLB and creates an IP pool from the kind docker network
- `monitoring.ts`: kube-prometheus-stack, the Grafana and Prometheus LoadBalancer services, and the dashboard ConfigMap
- `guestbook.ts`: the Guestbook app, the exporters, the metrics services and the ServiceMonitor
- `grafana/guestbook-dashboard.json`: the dashboard
- `kind-config.yaml`: the kind cluster with the localhost port mappings

## Notes

- The Guestbook app doesn't expose HTTP status codes, so the dashboard shows container restarts instead of an error rate.
- The apache request count includes the exporter's own requests to `/server-status` (one per pod every 15s).
- MetalLB picks its addresses from the top of the `kind` docker network, for example `172.18.255.200-172.18.255.250`. You can override this with `pulumi config set metallbAddressRange <start>-<end>`.
- On a cloud cluster (EKS, GKE, AKS), run `pulumi config set metallb false` first. The cloud provider will then hand out the LoadBalancer addresses, and you can skip `kind-config.yaml` and the localhost links.

## Clean up

```bash
pulumi destroy --yes
pulumi stack rm dev --yes
kind delete cluster --name guestbook
```
